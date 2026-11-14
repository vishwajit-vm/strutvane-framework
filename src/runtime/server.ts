/**
 * Load, boot and serve a project until a shutdown signal arrives. Used by `sv start` (in
 * process) and `sv dev` (in a child process that Node restarts on file changes).
 *
 * One port serves everything: the API, and the web UI next to it. `sv start` serves the built UI
 * (`dist/web`, from `sv build`); `sv dev` mounts the project's own Vite in middleware mode
 * (`dev-ui.ts`) for requests the API does not own, with HMR on the same port. Same origin means
 * the UI's `/api/v1` fetches and auth's `trustedOrigins: [APP_URL]` work without a proxy.
 *
 * @module
 */
import type { Server } from 'node:http'
import { join } from 'node:path'
import { LoggerToken } from '@strutvane/core'
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
   * contains an `index.html` (the output of `sv build`); `false` serves the API only.
   */
  readonly web?: string | false
  /**
   * Serve the UI through the project's own Vite (`sv dev`): resolved from the project root, run
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
      hint: 'install the project dependencies (e.g. pnpm install)',
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

/** Stop gracefully on SIGINT/SIGTERM. Resolves once stopped. */
export function stopOnSignals(started: StartedServer): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      void started.stop().then(resolve, resolve)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
