/**
 * Load, boot and serve a project until a shutdown signal arrives. Used by `sv start` (in
 * process) and `sv dev` (in a child process that Node restarts on file changes).
 *
 * @module
 */
import { join } from 'node:path'
import { LoggerToken } from '@strutvane/core'
import type { TrustProxy } from '../http/proxy.ts'
import { hasBuiltUi } from '../http/static-files.ts'
import { type BootedProject, bootProject } from './boot.ts'
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
  const project = await bootProject(loaded, {
    ...(options.env ? { env: options.env } : {}),
    ...(web ? { web } : {}),
  })
  const logger = project.app.make(LoggerToken)
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
      onError: (error) =>
        logger.error('Unhandled server error', {
          error: error instanceof Error ? error.message : String(error),
        }),
    })
  } catch (error) {
    await project.shutdown()
    throw error
  }
  logger.info('Server started', { url: server.url, env: project.env })
  let stopping: Promise<void> | undefined
  return {
    project,
    server,
    stop: () => {
      stopping ??= (async () => {
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
