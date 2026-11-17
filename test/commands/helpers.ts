/**
 * Shared setup for the app-command tests (`node strut optimize`, `down`, `route:list`…).
 *
 * - {@link appFolder}: a temporary app root (a `bootstrap/app.ts` marker plus any files).
 * - {@link buildApp}: a small app built in-process on that folder, with a test clock and a memory
 *   logger, so every command runs deterministically.
 * - {@link strut}: run a command line through the real CLI runner, with the app commands wired to
 *   a loader that builds a fresh app for every command (as a new `node strut` process would).
 * - {@link writeRealApp}: a real `bootstrap/app.ts` importing the framework source by file URL,
 *   for the tests that load the app the way `node strut` does, in this process or another.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAppCommands } from '../../src/console/commands/app/index.ts'
import { BUILTIN_COMMANDS } from '../../src/console/commands/builtins.ts'
import type { AnyCommand } from '../../src/console/framework/command.ts'
import type { Spawner } from '../../src/console/framework/services.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { ClockToken, LoggerToken } from '../../src/core/tokens.ts'
import { Application } from '../../src/foundation/application.ts'
import { type ConfigFiles, defineConfig } from '../../src/foundation/config.ts'
import { APP_ENVIRONMENTS } from '../../src/foundation/env.ts'
import type { MiddlewareConfig } from '../../src/http/app/middleware.ts'
import { defineRoutes, Route, type RouteList, type RoutesSource } from '../../src/routing/route.ts'
import { MemoryLogger } from '../app/helpers.ts'
import { type CliResult, cli } from '../console/helpers.ts'

export { MemoryLogger }

/** The repository root. */
export const ROOT: string = resolve(import.meta.dirname, '..', '..')

/** A generated 32-byte key (CONSISTENCY #79). */
export const APP_KEY: string = newKey()

/** The fixed time of every test clock (2026-11-14T10:00:00Z). */
export const NOW: number = Date.UTC(2026, 10, 14, 10, 0, 0)

/** A fresh `base64:` key. */
export function newKey(): string {
  return `base64:${randomBytes(32).toString('base64')}`
}

/** The environment every test app gets unless a test overrides a variable. */
export const testEnv: Readonly<Record<string, string>> = Object.freeze({
  APP_NAME: 'Command Test',
  APP_ENV: 'testing',
  APP_DEBUG: 'false',
  APP_URL: 'http://localhost',
  APP_KEY,
})

const temporary: string[] = []

/** Remove every temporary folder made so far (call in `afterEach`). */
export function cleanupFolders(): void {
  for (const folder of temporary.splice(0))
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
}

/** Write files (relative POSIX paths) under `root`, creating folders. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

/** A temporary app root: a `bootstrap/app.ts` marker plus `files`. */
export function appFolder(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'strut-cmd-'))
  temporary.push(root)
  writeFiles(root, {
    'bootstrap/app.ts':
      '// The tests build this app in-process (test/commands/helpers.ts).\nexport {}\n',
    ...files,
  })
  return root
}

/** config/app.ts and config/database.ts of the test app. */
export const testConfig: ConfigFiles = {
  app: defineConfig((env) => ({
    name: env.string('APP_NAME', 'Command Test'),
    env: env.oneOf('APP_ENV', APP_ENVIRONMENTS, 'production'),
    debug: env.boolean('APP_DEBUG', false),
    url: env.url('APP_URL', 'http://localhost'),
    key: env.string('APP_KEY'),
    previous_keys: env.string('APP_PREVIOUS_KEYS', ''),
    editor: env.optional('APP_EDITOR'),
  })),
  database: defineConfig((env) => ({
    password: env.optional('DB_PASSWORD'),
  })),
}

/** routes/web.ts: a page, a form post, a webhook that opts out of CSRF and a developer tool. */
export const webRoutes: RouteList<unknown> = defineRoutes([
  Route.get('/', (ctx) => ctx.json({ home: true })).name('home'),
  Route.get('/posts', (ctx) => ctx.json({ posts: [] })).name('posts.index'),
  Route.post('/posts', (ctx) => ctx.json({ created: true })).name('posts.store'),
  Route.post('/webhooks/stripe', (ctx) => ctx.json({ ok: true }))
    .name('webhooks.stripe')
    .withoutMiddleware('csrf'),
  Route.get('/_tools/info', (ctx) => ctx.json({ tool: true })).name('tools.info'),
])

/** Options for {@link buildApp}. */
export interface AppOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly config?: ConfigFiles
  readonly middleware?: (middleware: MiddlewareConfig) => void
  /** routes/web.ts; default {@link webRoutes}. Any routes list or callback. */
  readonly web?: RoutesSource
}

/** The in-process test app on `base`, with a test clock and a memory logger. */
export function buildApp(
  base: string,
  options: AppOptions = {},
): { readonly app: Application; readonly logger: MemoryLogger } {
  const app = Application.configure({ basePath: base, env: { ...testEnv, ...options.env } })
    .withConfig(options.config ?? testConfig)
    .withRouting({ web: options.web ?? webRoutes, health: '/up' })
    .withMiddleware((middleware) => options.middleware?.(middleware))
    .create()
  const logger = new MemoryLogger()
  app.container.value(LoggerToken, logger)
  app.container.value(ClockToken, createTestClock(NOW))
  return { app, logger }
}

/** Options for {@link strut}. */
export interface StrutOptions {
  /** The working directory (the app root). */
  readonly cwd: string
  /** Build the app each command loads; default {@link buildApp} on `cwd`. */
  readonly app?: () => Application
  /** Extra CLI process environment (APP_ENV defaults to `testing`). */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly spawn?: Spawner
  /** Commands to use instead of the app commands wired to `app` (the real loader tests). */
  readonly builtins?: readonly AnyCommand[]
}

/** Names of the app commands, to swap them for test-wired ones. */
const APP_NAMES: ReadonlySet<string> = new Set(createAppCommands().map((command) => command.name))

/** The built-in commands with the app commands loading `app` instead of `bootstrap/app.ts`. */
export function builtinsWith(app: () => Application): readonly AnyCommand[] {
  return [
    ...BUILTIN_COMMANDS.filter((command) => !APP_NAMES.has(command.name)),
    ...createAppCommands({ load: async () => app() }),
  ]
}

/** Run one `node strut` command line in-process. */
export function strut(argv: readonly string[], options: StrutOptions): Promise<CliResult> {
  const make = options.app ?? (() => buildApp(options.cwd).app)
  return cli(argv, {
    cwd: options.cwd,
    builtins: options.builtins ?? builtinsWith(make),
    env: { APP_ENV: 'testing', ...options.env },
    now: NOW,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  })
}

/** A framework source file as a `file:` URL (for apps outside the repository). */
export function sourceUrl(path: string): string {
  return pathToFileURL(join(ROOT, 'src', ...path.split('/'))).href
}

/**
 * A real app: `bootstrap/app.ts` importing the framework by file URL, plus a `.env`. It loads
 * the way `node strut` loads an app, in this process or in another one.
 */
export function writeRealApp(root: string, env: Readonly<Record<string, string>> = testEnv): void {
  writeFiles(root, {
    'bootstrap/app.ts': `import { dirname } from 'node:path'
import { Application } from '${sourceUrl('foundation/application.ts')}'
import { defineConfig } from '${sourceUrl('foundation/config.ts')}'
import { defineRoutes, Route } from '${sourceUrl('routing/route.ts')}'

const app = defineConfig((env) => ({
  name: env.string('APP_NAME', 'Real'),
  env: env.string('APP_ENV', 'production'),
  debug: env.boolean('APP_DEBUG', false),
  url: env.string('APP_URL', 'http://localhost'),
  key: env.string('APP_KEY'),
}))

export default Application.configure({ basePath: dirname(import.meta.dirname) })
  .withConfig({ app })
  .withRouting({ web: defineRoutes([Route.get('/', (ctx) => ctx.json({ hello: true })).name('home')]) })
  .create()
`,
    '.env': `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  })
}
