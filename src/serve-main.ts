/**
 * Process entry for `node strut dev`: `node --watch-path=… serve-main.mjs <root> <port> <host>`.
 * Node restarts this process when project files change (Vite, mounted inside it, watches `web/`
 * itself and hot-reloads the UI without a restart).
 *
 * @module
 */
import { ServerListenError } from './runtime/serve.ts'
import { startProject, stopOnSignals } from './runtime/server.ts'

const [root = process.cwd(), port, hostname, force] = process.argv.slice(2)
try {
  const started = await startProject({
    root,
    // The dev UI comes from the project's Vite (same port, HMR); a stale dist/web from an
    // earlier build must not shadow it.
    web: false,
    vite: true,
    ...(port ? { port: Number(port) } : {}),
    ...(hostname ? { hostname } : {}),
    ...(force === '--force-debug' ? { forceDebug: true } : {}),
  })
  process.stdout.write(`Strutvane dev server: ${started.server.url}\n`)
  await stopOnSignals(started)
} catch (error) {
  // A port clash after a restart is a configuration problem: say so plainly, no stack trace.
  const text =
    error instanceof ServerListenError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error)
  process.stderr.write(`${text}\n`)
  process.exitCode = 1
}
