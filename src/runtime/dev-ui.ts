/**
 * The web UI in `sv dev`: the project's own Vite, mounted in middleware mode on the app's HTTP
 * server, so one port serves the API and the UI with hot reload (docs/05 §1). The UI's fetches to
 * `/api/v1` and auth's `trustedOrigins: [APP_URL]` then work without a proxy or CORS.
 *
 * Why the project's Vite, resolved at runtime: the framework must not depend on Vite (an API-only
 * project has none, and the UI toolchain belongs to the app, ADR-0002 boundaries), and the version
 * the project pinned is the one its `vite.config.*` and plugins were written for. So Vite is
 * resolved from the project's `node_modules` (and its parents'), never from this package.
 *
 * Failure scenarios, named:
 * - no `vite.config.*` → `{ status: 'no-config' }`: the API preset, served API-only;
 * - a config but Vite not installed → `{ status: 'not-installed' }`: served API-only, with a hint;
 * - Vite installed but unusable (no `createServer`, a broken install, a config that throws) →
 *   an error naming the cause: a broken UI toolchain must not look like an API-only project.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Config file names Vite itself looks for, in its order. */
export const VITE_CONFIG_FILES: readonly string[] = Object.freeze([
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
])

/** The part of a Vite dev server the framework uses. */
export interface ViteDevServerLike {
  readonly middlewares: (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => void
  close(): Promise<void>
}

/** The part of the `vite` module the framework uses. */
export interface ViteModuleLike {
  createServer(config: Record<string, unknown>): Promise<ViteDevServerLike>
  loadConfigFromFile?(
    env: { readonly command: 'serve'; readonly mode: string },
    configFile: string,
    configRoot: string,
  ): Promise<{ readonly config: { readonly root?: unknown } } | null>
}

/** The outcome of looking for the project's Vite. */
export type ProjectVite =
  | {
      readonly status: 'ready'
      readonly configFile: string
      /** Where `vite` was resolved from (for the startup line). */
      readonly entry: string
      readonly vite: ViteModuleLike
    }
  | { readonly status: 'no-config' }
  | { readonly status: 'not-installed'; readonly configFile: string }

/** The project's Vite config file, if any. */
export function findViteConfig(root: string): string | undefined {
  for (const name of VITE_CONFIG_FILES) {
    const file = join(root, name)
    if (existsSync(file)) return file
  }
  return undefined
}

/**
 * The ESM entry of a package from its `exports` (`"."`) or `module`/`main`. Handles a string and
 * nested condition objects, preferring `import`, then `node`, then `default`.
 */
export function esmEntry(pkg: Readonly<Record<string, unknown>>): string | undefined {
  const pick = (target: unknown): string | undefined => {
    if (typeof target === 'string') return target
    if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined
    const conditions = target as Record<string, unknown>
    for (const key of ['import', 'node', 'default']) {
      const found = pick(conditions[key])
      if (found !== undefined) return found
    }
    return undefined
  }
  const exportsField = pkg['exports']
  if (exportsField !== undefined) {
    const root =
      typeof exportsField === 'object' &&
      exportsField !== null &&
      !Array.isArray(exportsField) &&
      Object.keys(exportsField).some((k) => k.startsWith('.'))
        ? (exportsField as Record<string, unknown>)['.']
        : exportsField
    return pick(root)
  }
  const fallback = pkg['module'] ?? pkg['main']
  return typeof fallback === 'string' ? fallback : undefined
}

/**
 * The `package.json` of a package installed for the project: Node's `node_modules` lookup from
 * the project root up through its parents (a workspace root may hold it), and nothing else.
 * Global folders (`NODE_PATH`, which `pnpm exec` points at its own store) are deliberately not
 * searched: they could hand back some other tool's copy. Symlinked installs (pnpm) count, since
 * the link lives in the project's `node_modules`.
 */
export function projectPackageManifest(root: string, name: string): string | undefined {
  let dir = resolve(root)
  for (;;) {
    const manifest = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(manifest)) return manifest
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Resolve the `vite` package the project installed (never this package's). */
export async function resolveProjectVite(root: string): Promise<ProjectVite> {
  const configFile = findViteConfig(root)
  if (configFile === undefined) return { status: 'no-config' }
  const manifest = projectPackageManifest(root, 'vite')
  if (manifest === undefined) return { status: 'not-installed', configFile }
  const pkg = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>
  const relative = esmEntry(pkg)
  if (relative === undefined) throw new Error(`Cannot find the entry point of ${manifest}`)
  const entry = resolve(dirname(manifest), relative)
  const loaded = (await import(pathToFileURL(entry).href)) as Partial<ViteModuleLike>
  if (typeof loaded.createServer !== 'function')
    throw new Error(`${entry} has no createServer(): is "vite" in package.json the real Vite?`)
  return { status: 'ready', configFile, entry, vite: loaded as ViteModuleLike }
}

/**
 * Start Vite in middleware mode on `server`: HMR over the same port (`hmr.server`), the SPA
 * HTML fallback (`appType: 'spa'`), and the project's config file.
 *
 * Vite resolves a relative `root` (`root: 'web'` in the generated config) against the working
 * directory; it is resolved against the project root here instead, so the result does not depend
 * on where the process was started.
 */
export async function startDevUi(options: {
  readonly root: string
  readonly vite: ViteModuleLike
  readonly configFile: string
  readonly server: Server
}): Promise<ViteDevServerLike> {
  const env = { command: 'serve', mode: 'development' } as const
  const loaded = await options.vite.loadConfigFromFile?.(env, options.configFile, options.root)
  const configured = loaded?.config.root
  const uiRoot = resolve(options.root, typeof configured === 'string' ? configured : '.')
  const dev = await options.vite.createServer({
    configFile: options.configFile,
    root: uiRoot,
    mode: 'development',
    appType: 'spa',
    clearScreen: false,
    server: { middlewareMode: true, hmr: { server: options.server } },
  })
  if (typeof dev?.middlewares !== 'function' || typeof dev.close !== 'function')
    throw new Error('vite.createServer() returned no middlewares: unsupported Vite version')
  return dev
}
