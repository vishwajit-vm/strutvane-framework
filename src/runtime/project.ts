/**
 * Load a Strutvane project from disk: `.env`, `strutvane.config.ts`, `config/*.ts`, and the
 * convention folders (`app/models`, `app/resources`, `app/http/routes`).
 *
 * Project files are TypeScript with explicit `.ts` imports; Node 24 runs them natively (type
 * stripping), so no build step or loader is involved.
 *
 * Failure scenarios (each throws {@link ProjectLoadError} naming the file):
 * - a missing `strutvane.config.ts`, or one whose default export has no `providers` array;
 * - a convention file whose default export has the wrong shape (e.g. a model file exporting a
 *   resource), which would otherwise silently drop a model from the API;
 * - an invalid environment, reported by `defineEnv` in the app's own `env.ts` when config loads.
 *
 * @module
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Provider } from '../core/index.ts'
import type { ResourceConfig } from '../http/resource.ts'
import { isRouteDefinition, type RouteDefinition } from '../http/route.ts'
import type { AnyModel } from '../model/define-model.ts'
import { normaliseAppEnv } from './app-env.ts'

/** Thrown when a project file is missing or has the wrong shape. */
export class ProjectLoadError extends Error {
  override readonly name = 'ProjectLoadError'
}

/** A loaded project. */
export interface LoadedProject {
  readonly root: string
  /** `config/*.ts` by file name, plus `app` merged with `strutvane.config.ts`'s `app` and `root`. */
  readonly config: Readonly<Record<string, unknown>>
  readonly providers: readonly Provider[]
  readonly models: readonly AnyModel[]
  readonly resources: readonly ResourceConfig[]
  readonly routes: readonly RouteDefinition[]
}

/** Options for {@link loadProject}. */
export interface LoadProjectOptions {
  /** Load `.env` into `process.env` (existing variables win). Default `true`. */
  readonly dotenv?: boolean
  /**
   * The `APP_ENV` already resolved by the caller (the CLI passes `ctx.appEnv`). It is written to
   * `process.env` *before* `.env` and the config files load, so `config/app.ts` and `.env` can
   * never disagree with the value the caller (and its production guard) used.
   */
  readonly appEnv?: string
}

/** List `dir/*<suffix>` sorted by name (empty when the folder doesn't exist). */
export function conventionFiles(root: string, dir: string, suffix: string): string[] {
  const abs = join(root, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(suffix) && !e.name.endsWith('.d.ts'))
    .map((e) => join(abs, e.name))
    .sort()
}

/** Import a project file and return its default export. */
export async function importDefault(file: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown }
  return mod.default
}

/** Load `.env` from `root` without overriding variables that are already set. */
export function loadDotEnv(root: string): void {
  const file = join(root, '.env')
  if (existsSync(file)) process.loadEnvFile(file)
}

const isModel = (v: unknown): v is AnyModel =>
  typeof v === 'object' && v !== null && 'definition' in v && typeof v.definition === 'object'

const isResource = (v: unknown): v is ResourceConfig =>
  typeof v === 'object' && v !== null && 'model' in v && typeof v.model === 'object'

/** Load a project. */
export async function loadProject(
  root: string,
  options: LoadProjectOptions = {},
): Promise<LoadedProject> {
  const appEnv = normaliseAppEnv(options.appEnv)
  if (appEnv !== undefined) process.env['APP_ENV'] = appEnv
  else if (
    process.env['APP_ENV'] !== undefined &&
    normaliseAppEnv(process.env['APP_ENV']) === undefined
  )
    delete process.env['APP_ENV'] // `APP_ENV=` means unset: let `.env` (or the default) decide
  if (options.dotenv !== false) loadDotEnv(root)
  const rel = (file: string) => relative(root, file).replaceAll('\\', '/')

  const configFile = join(root, 'strutvane.config.ts')
  if (!existsSync(configFile))
    throw new ProjectLoadError(`No strutvane.config.ts in ${root} (is this a Strutvane project?)`)
  const main = (await importDefault(configFile)) as
    | { app?: Record<string, unknown>; providers?: unknown }
    | undefined
  if (!main || !Array.isArray(main.providers))
    throw new ProjectLoadError(
      'strutvane.config.ts must default-export defineConfig({ providers: [...] })',
    )

  const config: Record<string, unknown> = {}
  for (const file of conventionFiles(root, 'config', '.ts')) {
    config[basename(file, '.ts')] = await importDefault(file)
  }
  config['app'] = {
    ...(config['app'] as Record<string, unknown> | undefined),
    ...main.app,
    root,
  }

  const models: AnyModel[] = []
  for (const file of conventionFiles(root, 'app/models', '.model.ts')) {
    const value = await importDefault(file)
    if (!isModel(value))
      throw new ProjectLoadError(`${rel(file)} must default-export defineModel(...)`)
    models.push(value)
  }
  const resources: ResourceConfig[] = []
  for (const file of conventionFiles(root, 'app/resources', '.resource.ts')) {
    const value = await importDefault(file)
    if (!isResource(value))
      throw new ProjectLoadError(`${rel(file)} must default-export defineResource(Model, {...})`)
    resources.push(value)
  }
  const routes: RouteDefinition[] = []
  for (const file of conventionFiles(root, 'app/http/routes', '.ts')) {
    const value = await importDefault(file)
    if (!Array.isArray(value) || !value.every(isRouteDefinition))
      throw new ProjectLoadError(`${rel(file)} must default-export an array of route.<method>(...)`)
    routes.push(...value)
  }
  return {
    root,
    config,
    providers: main.providers as Provider[],
    models,
    resources,
    routes,
  }
}
