/**
 * Process entry for `sv dev`: `node --watch-path=… serve-main.mjs <root> <port> <host>`.
 * Node restarts this process when project files change (Vite, mounted inside it, watches `web/`
 * itself and hot-reloads the UI without a restart).
 *
 * @module
 */
import { startServer, stopOnSignals } from './runtime/server.ts'

const [root = process.cwd(), port, hostname] = process.argv.slice(2)
try {
  const started = await startServer({
    root,
    // The dev UI comes from the project's Vite (same port, HMR); a stale dist/web from an
    // earlier build must not shadow it.
    web: false,
    vite: true,
    ...(port ? { port: Number(port) } : {}),
    ...(hostname ? { hostname } : {}),
  })
  process.stdout.write(`Strutvane dev server: ${started.server.url}\n`)
  await stopOnSignals(started)
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 1
}
