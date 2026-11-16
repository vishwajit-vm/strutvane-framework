/**
 * Typed config files (`config/app.ts`, `config/database.ts`, …) and the repository that serves
 * them through `config('app.name')`.
 *
 * Laravel's config files are plain arrays read with string keys. Here each file is a function of
 * a typed {@link Env}, so the value types flow all the way to `config('app.debug')`: `boolean`.
 *
 * Config is **frozen** after boot (a mutation would be invisible to code that already read it)
 * and **unknown keys are an error**, never `undefined`: a typo in a config key must not silently
 * turn a feature off.
 *
 * @module
 */
import { deepFreeze } from '../core/config.ts'
import { type Token, token } from '../core/container.ts'
import { BootError } from './boot-error.ts'
import { Env, type EnvIssue, type EnvSource } from './env.ts'

/**
 * One config file's default export.
 *
 * @example
 * const app: ConfigDefinition<{ name: string }> = defineConfig((env) => ({ name: env.string('APP_NAME', 'Blog') }))
 */
export interface ConfigDefinition<TValue> {
  /** Build the values from the environment. Runs once, at boot. */
  readonly build: (env: Env) => TValue
}

/**
 * Declare a config file. The return type of `build` *is* the config's type.
 *
 * @example
 * export default defineConfig((env) => ({
 *   name: env.string('APP_NAME', 'Strutvane'),
 *   debug: env.boolean('APP_DEBUG', false),
 * }))
 */
export function defineConfig<TValue>(build: (env: Env) => TValue): ConfigDefinition<TValue> {
  return { build }
}

/**
 * Every config file, keyed by file name (what `withConfig` takes).
 *
 * @example
 * const files: ConfigFiles = { app, database }
 */
export type ConfigFiles = Readonly<Record<string, ConfigDefinition<unknown>>>

/**
 * Turn `{ app: ConfigDefinition<A>, database: ConfigDefinition<D> }` into `{ app: A, database: D }`.
 * Used in the app's `ConfigRegistry` augmentation.
 *
 * @example
 * interface ConfigRegistry extends ConfigOf<typeof config> {}
 */
export type ConfigOf<TFiles> = {
  readonly [File in keyof TFiles]: TFiles[File] extends ConfigDefinition<infer TValue>
    ? TValue
    : never
}

/** Depth guard for {@link ConfigPath}: config trees deeper than five levels are not worth typing. */
type Depth = [never, 0, 1, 2, 3, 4]

/**
 * Every dot path into a config tree, for example `'app' | 'app.name' | 'database.connections.mysql.host'`.
 *
 * @example
 * const key: ConfigPath<{ app: { name: string } }> = 'app.name'
 */
export type ConfigPath<TTree, TLevel extends number = 5> = [TLevel] extends [never]
  ? never
  : TTree extends object
    ? TTree extends readonly unknown[] | ((...args: never[]) => unknown)
      ? never
      : {
          [Key in keyof TTree & string]: Key | `${Key}.${ConfigPath<TTree[Key], Depth[TLevel]>}`
        }[keyof TTree & string]
    : never

/**
 * The type at a dot path.
 *
 * @example
 * type Debug = ConfigValue<{ app: { debug: boolean } }, 'app.debug'> // boolean
 */
export type ConfigValue<TTree, TPath extends string> = TPath extends `${infer Head}.${infer Rest}`
  ? Head extends keyof TTree
    ? ConfigValue<TTree[Head], Rest>
    : never
  : TPath extends keyof TTree
    ? TTree[TPath]
    : never

/**
 * One environment problem, with the config file that read the variable.
 *
 * @example
 * const problem: ConfigProblem = { key: 'APP_KEY', message: 'is required', file: 'app' }
 */
export interface ConfigProblem extends EnvIssue {
  readonly file: string
}

/**
 * Thrown at boot when environment variables are missing or wrong. Lists every problem, grouped
 * by config file.
 *
 * @example
 * try { loadConfig(files, env) } catch (error) { if (error instanceof ConfigError) error.problems }
 */
export class ConfigError extends BootError {
  /** Every problem, with the config file it came from. */
  readonly problems: readonly ConfigProblem[]

  constructor(problems: readonly ConfigProblem[]) {
    const lines = problems.map(
      (problem) => `  - ${problem.key} ${problem.message} (read in config/${problem.file}.ts)`,
    )
    super(
      'invalid_environment',
      `The app can't start: ${problems.length} environment ${problems.length === 1 ? 'variable needs' : 'variables need'} attention.\n${lines.join('\n')}`,
      'Fix the values in .env (see .env.example for every key) and start again.',
    )
    this.name = 'ConfigError'
    this.problems = Object.freeze([...problems])
  }
}

/**
 * The loaded, frozen config tree with dot-path lookups.
 *
 * @example
 * const repository = loadConfig({ app }, { APP_NAME: 'Blog' })
 * repository.get('app.name') // 'Blog'
 */
export class ConfigRepository {
  readonly #tree: Readonly<Record<string, unknown>>

  constructor(tree: Readonly<Record<string, unknown>>) {
    this.#tree = deepFreeze(tree)
  }

  /**
   * The whole tree, for `about` and debugging.
   *
   * @example
   * Object.keys(repository.all) // ['app', 'database']
   */
  get all(): Readonly<Record<string, unknown>> {
    return this.#tree
  }

  /**
   * `true` when a value exists at the dot path, for optional settings a framework feature reads
   * only if the app defines them (`app.previous_keys`).
   *
   * @example
   * repository.has('app.previous_keys') // false for apps that don't rotate keys yet
   */
  has(path: string): boolean {
    return lookup(this.#tree, path).found
  }

  /**
   * Read a value by dot path. Unknown paths are a `BootError` (`unknown_config_key`), never
   * `undefined`.
   *
   * @example
   * repository.get('database.default') // 'pgsql'
   */
  get(path: string): unknown {
    const result = lookup(this.#tree, path)
    if (result.found) return result.value
    throw new BootError(
      'unknown_config_key',
      `There is no config value at "${path}".`,
      'Check the key against the files in config/; the first segment is the file name (for example "app.name" reads config/app.ts).',
    )
  }

  /**
   * A string setting, or `fallback` when the key is absent (for framework settings an app may
   * leave out of its config files).
   *
   * @example
   * repository.string('app.url', 'http://localhost')
   */
  string(path: string, fallback: string): string {
    const result = lookup(this.#tree, path)
    return result.found && typeof result.value === 'string' ? result.value : fallback
  }

  /**
   * A boolean setting, or `fallback` when the key is absent or not a boolean.
   *
   * @example
   * repository.boolean('app.debug', false)
   */
  boolean(path: string, fallback: boolean): boolean {
    const result = lookup(this.#tree, path)
    return result.found && typeof result.value === 'boolean' ? result.value : fallback
  }
}

function lookup(tree: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = tree
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment))
      return { found: false, value: undefined }
    current = (current as Record<string, unknown>)[segment]
  }
  return { found: true, value: current }
}

/**
 * Build every config file from the environment, then fail once with *all* problems if any.
 *
 * @example
 * const config = loadConfig({ app: appConfig, database: databaseConfig }, process.env)
 */
export function loadConfig(files: ConfigFiles, source: EnvSource): ConfigRepository {
  const tree: Record<string, unknown> = {}
  const problems: ConfigProblem[] = []
  for (const [file, definition] of Object.entries(files)) {
    // A fresh reader per file, so each problem can name the file that read the variable.
    const env = new Env(source)
    tree[file] = definition.build(env)
    problems.push(...env.issues.map((issue) => ({ ...issue, file })))
  }
  if (problems.length > 0) throw new ConfigError(problems)
  return new ConfigRepository(tree)
}

/**
 * The container token for the loaded config repository, bound at boot.
 *
 * @example
 * app.make(ConfigRepositoryToken).get('app.name')
 */
export const ConfigRepositoryToken: Token<ConfigRepository> =
  token<ConfigRepository>('strutvane.config')
