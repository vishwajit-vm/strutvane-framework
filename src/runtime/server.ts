/**
 * Load, boot and serve a project until a shutdown signal arrives. Used by `node strut start` (in
 * process) and `node strut dev` (in a child process that Node restarts on file changes).
 *
 * Two kinds of project: an application (`bootstrap/app.ts`, {@link startApplication}) and a
 * `strutvane.config.ts` project ({@link startServer}); {@link startProject} picks the right one.
 *
 * One port serves everything: the API, and the web UI next to it. `node strut start` serves the built UI
 * (`dist/web`, from `node strut build`); `node strut dev` mounts the project's own Vite in middleware mode
 * (`dev-ui.ts`) for requests the API does not own, with HMR on the same port. Same origin means
 * the UI's `/api/v1` fetches and auth's `trustedOrigins: [APP_URL]` work without a proxy.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { LoggerToken } from '../core/index.ts'
import { detectPackageManager, installCommand } from '../core/package-manager.ts'
import type { Application } from '../foundation/application.ts'
import { hasBootstrapApp } from '../foundation/load.ts'
import type { TrustProxy } from '../http/proxy.ts'
import { hasBuiltUi } from '../http/static-files.ts'
import { type BootedProject, bootProject } from './boot.ts'
import {
  type ProjectVite,
  resolveProjectVite,
  startDevUi,
  type ViteDevServerLike,
} from './dev-ui.ts'
import { loadProject } from './project.ts'
import { type RunningServer, serve } from './serve.ts'

/** Options for {@link startServer}. */
export interface StartServerOptions {
  readonly root: string
  /** Default: `config/app.ts` `port`, else 3000. */
  readonly port?: number
  /** Default `127.0.0.1`. */
  readonly hostname?: string
  /** Override `APP_ENV`. */
  readonly env?: string
  /**
   * Serve the built UI from this folder next to the API. Default: `<root>/dist/web` when it
   * contains an `index.html` (the output of `node strut build`); `false` serves the API only.
   */
  readonly web?: string | false
  /**
   * Serve the UI through the project's own Vite (`node strut dev`): resolved from the project root, run
   * in middleware mode on this server, answering only requests the API does not own. Without a
   * `vite.config.*` or an installed `vite`, the API is served alone and an info line says why.
   * Default `false`.
   */
  readonly vite?: boolean
}

/** A served project. */
export interface StartedServer {
  readonly project: BootedProject
  readonly server: RunningServer
  stop(): Promise<void>
}

/** Boot the project and start listening. */
export async function startServer(options: StartServerOptions): Promise<StartedServer> {
  const loaded = await loadProject(options.root)
  const builtUi = join(options.root, 'dist', 'web')
  const web =
    options.web === false
      ? undefined
      : (options.web ?? ((await hasBuiltUi(builtUi)) ? builtUi : undefined))
  const devVite: ProjectVite | undefined = options.vite
    ? await resolveProjectVite(options.root)
    : undefined
  const viteReady = devVite?.status === 'ready' ? devVite : undefined
  const project = await bootProject(loaded, {
    ...(options.env ? { env: options.env } : {}),
    ...(web ? { web } : {}),
    ...(viteReady ? { uiFallthrough: true } : {}),
  })
  const logger = project.app.make(LoggerToken)
  if (devVite?.status === 'no-config')
    logger.info('No vite.config.* in the project: serving the API only')
  else if (devVite?.status === 'not-installed')
    logger.info('Found a Vite config but "vite" is not installed: serving the API only', {
      configFile: devVite.configFile,
      // The project's own package manager, never a hard-coded one.
      hint: `install the project dependencies (${installCommand(detectPackageManager(options.root))})`,
    })
  let dev: ViteDevServerLike | undefined
  const appConfig = loaded.config['app'] as
    | { port?: number; publicUrl?: string; trustProxy?: TrustProxy }
    | undefined
  let server: RunningServer
  try {
    // Hono receives the adapter's bindings as `c.env` (socket peer, resolved client address).
    server = await serve((request, bindings) => project.http.fetch(request, bindings), {
      port: options.port ?? appConfig?.port ?? 3000,
      ...(options.hostname ? { hostname: options.hostname } : {}),
      ...(appConfig?.publicUrl ? { publicUrl: appConfig.publicUrl } : {}),
      ...(appConfig?.trustProxy !== undefined ? { trustProxy: appConfig.trustProxy } : {}),
      ...(viteReady
        ? {
            prepare: async (httpServer: Server) => {
              dev = await startDevUi({
                root: options.root,
                vite: viteReady.vite,
                configFile: viteReady.configFile,
                server: httpServer,
              })
            },
            fallback: (req, res, next) => {
              if (dev) dev.middlewares(req, res, next)
              else next()
            },
          }
        : {}),
      onError: (error) =>
        logger.error('Unhandled server error', {
          error: error instanceof Error ? error.message : String(error),
        }),
    })
  } catch (error) {
    await dev?.close().catch(() => undefined)
    await project.shutdown()
    throw error
  }
  logger.info('Server started', {
    url: server.url,
    env: project.env,
    ...(viteReady ? { ui: 'vite', vite: viteReady.entry } : web ? { ui: web } : {}),
  })
  let stopping: Promise<void> | undefined
  return {
    project,
    server,
    stop: () => {
      stopping ??= (async () => {
        // Vite first: it closes its watcher and the HMR sockets the HTTP server no longer tracks.
        await dev?.close().catch(() => undefined)
        await server.close()
        await project.shutdown()
      })()
      return stopping
    },
  }
}

/** Options for {@link startApplication}. */
export interface StartApplicationOptions {
  readonly root: string
  /** Default: `config('app.port')`, else 3000. */
  readonly port?: number
  /** Default `127.0.0.1`. */
  readonly hostname?: string
  /** Load the app (default: import `bootstrap/app.ts`); tests pass an app they built. */
  readonly load?: (root: string) => Promise<Application>
}

/** A served application. */
export interface StartedApplication {
  readonly app: Application
  readonly server: RunningServer
  stop(): Promise<void>
}

/**
 * Load `bootstrap/app.ts`, boot it (every boot check runs before the port opens, so a broken
 * route or a weak key never starts serving) and serve it. The adapter hands the app the socket
 * peer (`ip`: the app applies its own trusted proxies) and `waitUntil` (deferred work and
 * terminable middleware run after the response, and `stop()` waits for them within the grace
 * period). `stop()` drains the server, then shuts the app down.
 *
 * @example
 * const started = await startApplication({ root: process.cwd(), port: 8000 })
 * await stopOnSignals(started)
 */
export async function startApplication(
  options: StartApplicationOptions,
): Promise<StartedApplication> {
  const load =
    options.load ??
    (async (root: string) => (await import('../foundation/load.ts')).loadApplication(root))
  const app = await load(options.root)
  await app.boot()
  const logger = app.make(LoggerToken)
  const configured = app.configRepository.has('app.port')
    ? Number(app.configRepository.get('app.port'))
    : undefined
  let server: RunningServer
  try {
    server = await serve(
      (request, bindings) =>
        app.handle(request, {
          ...(bindings.ip === undefined ? {} : { ip: bindings.ip }),
          waitUntil: bindings.waitUntil,
        }),
      {
        port: options.port ?? (Number.isInteger(configured) ? (configured as number) : 3000),
        ...(options.hostname ? { hostname: options.hostname } : {}),
        onError: (error) =>
          logger.error('Unhandled server error', {
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    )
  } catch (error) {
    await app.shutdown()
    throw error
  }
  logger.info('Server started', { url: server.url, env: app.environment })
  let stopping: Promise<void> | undefined
  return {
    app,
    server,
    stop: () => {
      stopping ??= (async () => {
        await server.close()
        await app.shutdown()
      })()
      return stopping
    },
  }
}

/**
 * Start whatever lives at `options.root`: an application when it has `bootstrap/app.ts` and no
 * `strutvane.config.ts`, else a `strutvane.config.ts` project.
 *
 * @example
 * const started = await startProject({ root: process.cwd() })
 */
export function startProject(
  options: StartServerOptions,
): Promise<StartedServer | StartedApplication> {
  if (hasBootstrapApp(options.root) && !existsSync(join(options.root, 'strutvane.config.ts')))
    return startApplication({
      root: options.root,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    })
  return startServer(options)
}

/** The environment a started server runs in (for the "Listening on …" line). */
export function startedEnv(started: StartedServer | StartedApplication): string {
  return 'project' in started ? started.project.env : started.app.environment
}

/** Why the server stopped (see {@link stopOnSignals}). */
export type StopReason = 'SIGINT' | 'SIGTERM' | 'shutdown-message'

/**
 * The IPC message that asks for a graceful shutdown (the PM2 convention). On Windows an external
 * `SIGTERM` terminates the process without running any handler (ADR-0015), so process managers
 * and `node strut` that start the app with an IPC channel send this message instead.
 */
export const SHUTDOWN_MESSAGE = 'shutdown'

/** Where signals and IPC messages come from (the process; replaceable in tests). */
export interface ShutdownSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
  /** Present when the process has an IPC channel (started with `fork` or `stdio: 'ipc'`). */
  readonly send?: unknown
}

/** Exit code for a stop reason: 128 + the signal number (143 for SIGTERM), 0 for a request. */
export function exitCodeForStop(reason: StopReason): number {
  return reason === 'SIGTERM' ? 143 : reason === 'SIGINT' ? 130 : 0
}

/**
 * Stop gracefully on SIGINT/SIGTERM, or on the {@link SHUTDOWN_MESSAGE} IPC message when the
 * process has an IPC channel. Resolves with the reason once stopped (in-flight requests drained,
 * providers shut down). A failing stop is logged, never swallowed. After the first trigger the
 * listeners are removed, so a second Ctrl+C or SIGTERM gets Node's default: exit immediately.
 */
export function stopOnSignals(
  started: StartedServer | StartedApplication,
  options: { readonly source?: ShutdownSource } = {},
): Promise<StopReason> {
  const source: ShutdownSource = options.source ?? process
  const ipc = typeof source.send === 'function'
  return new Promise((resolve) => {
    const onSigint = (): void => trigger('SIGINT')
    const onSigterm = (): void => trigger('SIGTERM')
    const onMessage = (message: unknown): void => {
      if (message === SHUTDOWN_MESSAGE) trigger('shutdown-message')
    }
    const trigger = (reason: StopReason): void => {
      source.off('SIGINT', onSigint)
      source.off('SIGTERM', onSigterm)
      if (ipc) source.off('message', onMessage)
      started.stop().then(
        () => resolve(reason),
        (error: unknown) => {
          try {
            const app = 'project' in started ? started.project.app : started.app
            app.make(LoggerToken).error('Graceful shutdown failed', { error })
          } catch {
            // The logger itself is gone: the exit code still reports the stop.
          }
          resolve(reason)
        },
      )
    }
    source.on('SIGINT', onSigint)
    source.on('SIGTERM', onSigterm)
    if (ipc) source.on('message', onMessage)
  })
}
