/**
 * Vitest global setup: start throwaway MySQL 8.4 and MariaDB 11.4 containers for the whole run, and
 * remove them afterwards. Nothing Docker-related is committed (ADR-0006): each container is created
 * from the official image with a `docker run` command and deleted at the end.
 *
 * Safety rules this file follows:
 * - It only ever touches containers with its own unique names (`spike11-orm-mysql`,
 *   `spike11-orm-mariadb`). It never lists, stops or removes any other container.
 * - It binds to 127.0.0.1 on a free port, so the databases are never exposed to the network.
 * - The root passwords are random per run and only live in this process' memory.
 * - When Docker is not available, the MySQL and MariaDB tests are skipped with a clear message
 *   instead of failing. Set SPIKE11_MYSQL=off or SPIKE11_MARIADB=off to skip one deliberately.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { createConnection } from 'mysql2/promise'
import type { TestProject } from 'vitest/node'

const run = promisify(execFile)
const READY_TIMEOUT_MS = 240_000

/** Connection URL of a test server, or a reason it is not available. */
type ServerInfo = { readonly url: string } | { readonly skipped: string }

declare module 'vitest' {
  export interface ProvidedContext {
    /** MySQL 8.4, the default engine. */
    mysql: ServerInfo
    /** MariaDB 11.4 (what XAMPP-style local installs run). */
    mariadb: ServerInfo
  }
}

/** One throwaway server: its container, image, and the environment its image expects. */
interface ServerSpec {
  readonly key: 'mysql' | 'mariadb'
  readonly container: string
  readonly image: string
  readonly offSwitch: string
  readonly env: (password: string) => readonly string[]
}

const SERVERS: readonly ServerSpec[] = [
  { key: 'mysql', container: 'spike11-orm-mysql', image: 'mysql:8.4', offSwitch: 'SPIKE11_MYSQL', env: (password) => [`MYSQL_ROOT_PASSWORD=${password}`, 'MYSQL_DATABASE=spike11'] },
  { key: 'mariadb', container: 'spike11-orm-mariadb', image: 'mariadb:11.4', offSwitch: 'SPIKE11_MARIADB', env: (password) => [`MARIADB_ROOT_PASSWORD=${password}`, 'MARIADB_DATABASE=spike11'] },
]

/**
 * Start the servers (or explain why not) and provide their URLs to the test files.
 *
 * @example
 * // vitest.config.ts: test.globalSetup = ['test/support/mysql-container.ts']
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const docker = await dockerAvailable()
  const started: ServerSpec[] = []
  try {
    // In parallel: both images boot in about the same time, so the run waits once, not twice.
    const infos = await Promise.all(
      SERVERS.map(async (server): Promise<ServerInfo> => {
        if (process.env[server.offSwitch] === 'off') return { skipped: `${server.offSwitch}=off` }
        if (!docker) return { skipped: `Docker is not available, so the ${server.key} suite is skipped (install/start Docker to run it)` }
        started.push(server)
        return { url: await startServer(server) }
      }),
    )
    SERVERS.forEach((server, index) => {
      const info = infos[index]
      if (info !== undefined) project.provide(server.key, info)
    })
  } catch (error) {
    await Promise.all(started.map((server) => removeOwnContainer(server.container)))
    throw error
  }
  return async () => {
    await Promise.all(started.map((server) => removeOwnContainer(server.container)))
  }
}

async function startServer(server: ServerSpec): Promise<string> {
  const port = await freePort()
  const password = randomBytes(18).toString('base64url')
  await removeOwnContainer(server.container)
  const env = server.env(password).flatMap((entry) => ['-e', entry])
  await run('docker', ['run', '--rm', '-d', '--name', server.container, ...env, '-p', `127.0.0.1:${port}:3306`, server.image], { timeout: 600_000 })
  const url = `mysql://root:${encodeURIComponent(password)}@127.0.0.1:${port}/spike11`
  await waitUntilReady(url, server.key)
  return url
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

/** Remove *our* container by its exact name; ignore "no such container". */
async function removeOwnContainer(container: string): Promise<void> {
  try {
    await run('docker', ['rm', '-f', container], { timeout: 60_000 })
  } catch {
    // Not running: nothing to clean up.
  }
}

/** Ask the OS for a free port on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** The first boot initialises the data directory and restarts once: poll until a query works. */
async function waitUntilReady(url: string, key: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const connection = await createConnection(url)
      await connection.query('SELECT 1')
      await connection.end()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error(`${key} did not become ready within ${READY_TIMEOUT_MS / 1000}s: ${String(lastError)}`)
}
