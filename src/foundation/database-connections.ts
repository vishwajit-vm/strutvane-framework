/**
 * Several databases at once (CONSISTENCY #132, RFC-0007): the extra connections an app declares
 * in `config/database.ts`, next to the default `DB_*` one.
 *
 * ```ts
 * // config/database.ts
 * connections: {
 *   pgsql: { driver: 'pgsql' },                    // reads DB_PGSQL_* from .env
 *   reports: { driver: 'pgsql', database: 'reports' },
 * }
 * ```
 *
 * **Why checked on first use, never at boot.** An app lists every key in `.env`, most of them
 * empty until somebody needs them. An empty `DB_REPORTS_DATABASE` must not stop an app that never
 * touches `reports`; it must stop the first query on `reports`, with the key to fill in.
 *
 * **Where each value comes from:** `config/database.ts` first, then `DB_<NAME>_*` in the
 * environment, like the default connection. The password and URL are read from the environment
 * only, when the connection opens: the config tree is cached by `config:cache` and easy to dump,
 * so `password` or `url` in a declaration is refused (`secret_in_config`).
 *
 * **Failure scenarios:** an undeclared name (`unknown_connection`), a bad name
 * (`invalid_connection_name`), an empty required key (`database_not_configured`), a bad value
 * (`invalid_database_config`), use after shutdown (`connection_closed`). Each is a
 * {@link BootError} whose hint names what to change. A connection that fails to configure is not
 * cached, so fixing `.env` and retrying (a new command, a test) works.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Token, token } from '../core/container.ts'
import { EnvValidationError } from '../core/index.ts'
import {
  type DatabaseSettings,
  databaseEngineOf,
  databaseSettings,
  openDatabaseLazily,
} from '../database/config.ts'
import type { Connection } from '../database/db/connection.ts'
import { DEFAULT_CONNECTION, isConnectionName } from '../database/db/manager.ts'
import { BootError } from './boot-error.ts'
import { Env, type EnvSource } from './env.ts'

/**
 * One extra connection in `config/database.ts`. Every key is optional: what the declaration does
 * not set is read from `DB_<NAME>_*` in `.env` (`driver` from `DB_<NAME>_DRIVER`).
 *
 * @example
 * const reports: DatabaseConnectionDeclaration = { driver: 'pgsql', database: 'reports' }
 */
export interface DatabaseConnectionDeclaration {
  /** `mysql`, `mariadb`, `pgsql` (`postgres`) or `sqlite`; defaults to the name when it is one. */
  readonly driver?: string
  readonly host?: string
  readonly port?: string | number
  /** The database name, or the SQLite file relative to the project root. Required. */
  readonly database?: string
  readonly username?: string
  readonly socket?: string
  readonly sslmode?: string
  readonly ssl_ca?: string
  /** Replaces `database` when `APP_ENV=testing`, so tests never touch local data. */
  readonly test_database?: string
}

/** Declaration keys → the env suffix each one reads (`host` → `DB_<NAME>_HOST`). */
const DECLARATION_KEYS: ReadonlyMap<string, string> = new Map([
  ['driver', 'DRIVER'],
  ['host', 'HOST'],
  ['port', 'PORT'],
  ['database', 'DATABASE'],
  ['username', 'USERNAME'],
  ['socket', 'SOCKET'],
  ['sslmode', 'SSLMODE'],
  ['ssl_ca', 'SSL_CA'],
  ['test_database', 'TEST_DATABASE'],
])
/** Keys that hold secrets: read from the environment only. */
const SECRET_KEYS: ReadonlyMap<string, string> = new Map([
  ['password', 'PASSWORD'],
  ['url', 'URL'],
])

/**
 * The env prefix of a connection: `reports` → `DB_REPORTS_`.
 *
 * @example
 * connectionEnvPrefix('pgsql') // 'DB_PGSQL_'
 */
export function connectionEnvPrefix(name: string): string {
  return `DB_${name.toUpperCase()}_`
}

/**
 * Validate `config/database.ts` → `connections` and return the declarations by name. `undefined`
 * (no `connections`) is an empty map. A typo in a key is refused, never ignored: a silently
 * ignored `hots` would connect to the wrong server.
 *
 * @example
 * declaredConnections({ reports: { driver: 'pgsql' } }).has('reports') // true
 */
export function declaredConnections(
  value: unknown,
): ReadonlyMap<string, DatabaseConnectionDeclaration> {
  const declared = new Map<string, DatabaseConnectionDeclaration>()
  if (value === undefined || value === null) return declared
  if (!isRecord(value))
    throw new BootError(
      'invalid_database_config',
      'config/database.ts: `connections` must be an object of named connections.',
      "Write it as connections: { reports: { driver: 'pgsql' } }; each one reads DB_<NAME>_* from .env.",
    )
  for (const [name, raw] of Object.entries(value)) {
    if (name === DEFAULT_CONNECTION || !isConnectionName(name))
      throw new BootError(
        'invalid_connection_name',
        `config/database.ts: "${name}" can't be a connection name.`,
        name === DEFAULT_CONNECTION
          ? '"default" is the DB_* connection itself; give the extra connection another name.'
          : 'Use lowercase letters, digits and _, starting with a letter (e.g. reports); its keys in .env are DB_<NAME>_*.',
      )
    declared.set(name, declaration(name, raw))
  }
  return declared
}

function declaration(name: string, raw: unknown): DatabaseConnectionDeclaration {
  if (!isRecord(raw))
    throw new BootError(
      'invalid_database_config',
      `config/database.ts: connections.${name} must be an object.`,
      `Write it as ${name}: { driver: 'pgsql' } (or {} to read everything from DB_${name.toUpperCase()}_* in .env).`,
    )
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(raw)) {
    const secret = SECRET_KEYS.get(key)
    if (secret !== undefined)
      throw new BootError(
        'secret_in_config',
        `config/database.ts: connections.${name}.${key} is a secret and can't be set in a config file.`,
        `Remove it and set ${connectionEnvPrefix(name)}${secret} in .env: the config tree is cached by config:cache and easy to dump.`,
      )
    if (!DECLARATION_KEYS.has(key))
      throw new BootError(
        'invalid_database_config',
        `config/database.ts: connections.${name} has an unknown key "${key}".`,
        `The keys are ${[...DECLARATION_KEYS.keys()].join(', ')}.`,
      )
    if (entry === undefined || entry === null) continue
    if (typeof entry === 'number' && Number.isFinite(entry)) result[key] = String(entry)
    else if (typeof entry === 'string') {
      if (entry.trim() !== '') result[key] = entry
    } else
      throw new BootError(
        'invalid_database_config',
        `config/database.ts: connections.${name}.${key} must be text or a number.`,
        `Set it to a string (or leave it out to read ${connectionEnvPrefix(name)}${DECLARATION_KEYS.get(key) ?? ''} from .env).`,
      )
  }
  return result
}

/**
 * The settings of the extra connection `name`: its declaration over its `DB_<NAME>_*` keys, the
 * test database under `APP_ENV=testing`, then the same checks as the default connection.
 *
 * @example
 * namedConnectionSettings('reports', { driver: 'sqlite' }, { DB_REPORTS_DATABASE: 'r.sqlite' }, root, 'local')
 */
export function namedConnectionSettings(
  name: string,
  declared: DatabaseConnectionDeclaration,
  env: EnvSource,
  root: string,
  environment: string,
): DatabaseSettings {
  const prefix = connectionEnvPrefix(name)
  const merged: Record<string, string | undefined> = { ...env }
  for (const [key, suffix] of DECLARATION_KEYS) {
    const value = (declared as Readonly<Record<string, string | undefined>>)[key]
    if (value !== undefined) merged[`${prefix}${suffix}`] = value
  }
  const text = (key: string): string | undefined => {
    const raw = merged[key]?.trim()
    return raw === undefined || raw === '' ? undefined : raw
  }
  const testDatabase = text(`${prefix}TEST_DATABASE`)
  if (environment === 'testing' && testDatabase !== undefined)
    merged[`${prefix}DATABASE`] = testDatabase
  const driverKey = `${prefix}DRIVER`
  const url = text(`${prefix}URL`)
  const driver = text(driverKey) ?? databaseEngineOf(name)
  if (driver !== undefined) merged[driverKey] = driver
  const missing: string[] = []
  if (driver === undefined && url === undefined) missing.push(driverKey)
  const engine = driver === undefined ? undefined : databaseEngineOf(driver)
  // A server URL carries the database name; a SQLite connection always needs its file.
  if (text(`${prefix}DATABASE`) === undefined && (url === undefined || engine === 'sqlite'))
    missing.push(`${prefix}DATABASE`)
  if (missing.length > 0)
    throw new BootError(
      'database_not_configured',
      `The "${name}" database connection is not configured: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} empty.`,
      `Set ${missing.join(' and ')} in .env (see .env.example), or set it under connections.${name} in config/database.ts.`,
    )
  try {
    return databaseSettings(merged, root, { prefix, driverKey })
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error
    const keys = error.problems.map((problem) => problem.key)
    throw new BootError(
      'invalid_database_config',
      `The "${name}" database connection has ${keys.length === 1 ? 'a bad setting' : `${keys.length} bad settings`}:\n${error.problems.map((problem) => `  - ${problem.key}: ${problem.message}`).join('\n')}`,
      `Fix ${keys.join(', ')} in .env (or under connections.${name} in config/database.ts).`,
      { cause: error },
    )
  }
}

/** What a {@link DatabaseManager} needs from the application. */
export interface DatabaseManagerOptions {
  readonly basePath: string
  /** `APP_ENV`: `testing` switches every connection to its test database. */
  readonly environment: string
  /** The merged environment (`.env` + process), read when a connection is first used. */
  readonly env: () => EnvSource
  /** `config('database.connections')`, or `undefined` when the app declares none. */
  readonly connections: () => unknown
  /** The default (`DB_*`) connection. */
  readonly defaultConnection: () => Connection
}

/**
 * The application's connections: the default one, and every extra one opened lazily by name, once,
 * and closed by `app.shutdown()`.
 *
 * @example
 * const reports = app.make(DatabaseManagerToken).connection('reports')
 */
export class DatabaseManager {
  readonly #options: DatabaseManagerOptions
  readonly #opened = new Map<string, Connection>()
  #declared: ReadonlyMap<string, DatabaseConnectionDeclaration> | undefined
  #closed = false

  constructor(options: DatabaseManagerOptions) {
    this.#options = options
  }

  /**
   * The connection called `name` (the default one without a name or with `default`). Nothing is
   * opened here: the first statement opens it.
   *
   * @example
   * await manager.connection('reports').run(sql`SELECT 1`)
   */
  connection(name?: string): Connection {
    if (name === undefined || name === DEFAULT_CONNECTION) return this.#options.defaultConnection()
    if (!isConnectionName(name))
      throw new BootError(
        'invalid_connection_name',
        `${JSON.stringify(name)} is not a database connection name.`,
        'Use the name declared in config/database.ts under connections: lowercase letters, digits and _.',
      )
    const opened = this.#opened.get(name)
    if (opened !== undefined) return opened
    if (this.#closed)
      throw new BootError(
        'connection_closed',
        `The "${name}" database connection was asked for after the application shut down.`,
        'Boot the application again instead of reusing one that was shut down.',
      )
    const declared = this.declarations().get(name)
    if (declared === undefined) throw this.#unknown(name)
    const { basePath, environment } = this.#options
    const settings = namedConnectionSettings(
      name,
      declared,
      this.#options.env(),
      basePath,
      environment,
    )
    const connection = openDatabaseLazily(settings)
    this.#opened.set(name, connection)
    return connection
  }

  /**
   * The extra connections `config/database.ts` declares, validated (the default one is not in it).
   *
   * @example
   * [...manager.declarations().keys()] // ['pgsql', 'reports']
   */
  declarations(): ReadonlyMap<string, DatabaseConnectionDeclaration> {
    this.#declared ??= declaredConnections(this.#options.connections())
    return this.#declared
  }

  /**
   * Close every extra connection that was opened (the default one has its own owner). Safe to
   * call twice; one failing close never keeps the others open.
   *
   * @example
   * await manager.close()
   */
  async close(): Promise<void> {
    this.#closed = true
    const open = [...this.#opened.values()]
    this.#opened.clear()
    const results = await Promise.allSettled(open.map((connection) => connection.close()))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  #unknown(name: string): BootError {
    const names = [...this.declarations().keys()]
    return new BootError(
      'unknown_connection',
      `No database connection is called "${name}".`,
      names.length === 0
        ? `Declare it in config/database.ts: connections: { ${name}: { driver: 'pgsql' } }, and set its ${connectionEnvPrefix(name)}* keys in .env.`
        : `The declared connections are ${names.join(', ')}. Use one of them, or add "${name}" under connections in config/database.ts.`,
    )
  }
}

/**
 * The application's {@link DatabaseManager}: named connections from `config/database.ts`.
 *
 * @example
 * app.make(DatabaseManagerToken).connection('reports')
 */
export const DatabaseManagerToken: Token<DatabaseManager> = token<DatabaseManager>(
  'strutvane.database.manager',
)

/**
 * The `connections` that `<root>/config/database.ts` declares, read the way the app reads them
 * (the file's `defineConfig` run with `env`), for `node strut migrate --database=<name>` and the
 * other database commands, so the CLI and the app always agree. `undefined` without the file.
 *
 * @example
 * declaredConnections(await readConnectionsFromConfig('/srv/app', process.env))
 */
export async function readConnectionsFromConfig(root: string, env: EnvSource): Promise<unknown> {
  const file = join(root, 'config', 'database.ts')
  if (!existsSync(file)) return undefined
  const module = (await import(pathToFileURL(file).href)) as { readonly default?: unknown }
  const exported = module.default
  const build = isRecord(exported) ? exported['build'] : undefined
  const value: unknown =
    typeof build === 'function' ? Reflect.apply(build, exported, [new Env(env)]) : exported
  return isRecord(value) ? value['connections'] : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
