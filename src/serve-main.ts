/**
 * Process entry for `sv dev`: `node --watch-path=… serve-main.mjs <root> <port> <host>`.
 * Node restarts this process when project files change.
 *
 * @module
 */
import { startServer, stopOnSignals } from './runtime/server.ts'

const [root = process.cwd(), port, hostname] = process.argv.slice(2)
try {
  const started = await startServer({
    root,
    // A dev UI comes from Vite; a stale dist/web from an earlier build must not shadow it.
    web: false,
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
