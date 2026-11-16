/**
 * Vitest global setup: throwaway MySQL 8.4, MariaDB 11.4 and PostgreSQL 18 servers for the run.
 *
 * Rules (ADR-0006: Docker is local-only and nothing Docker-related is committed):
 * - Each container gets a **unique name per run** (`strutvane-fw-test-<engine>-<random>`), so two
 *   runs (or two worktrees) never collide, and this file only ever removes the containers it
 *   started itself, by exact name. It never lists, stops or removes any other container.
 * - Servers bind to 127.0.0.1 on a free port, with a random password that lives only in memory.
 * - Every test file creates its own database on the server ({@link serverDatabase}), so files run
 *   in parallel without sharing tables.
 * - Without Docker the real-server suites are skipped **with the reason in the test title**.
 *   `STRUTVANE_TEST_DOCKER=off` skips all of them on purpose; `STRUTVANE_TEST_MYSQL=off`,
 *   `STRUTVANE_TEST_MARIADB=off` and `STRUTVANE_TEST_POSTGRES=off` skip one.
 *
 * @module
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'

const run = promisify(execFile)
const READY_TIMEOUT_MS = 240_000

/** A server's admin URL (no database in the path), or why it isn't available. */
export type ServerInfo = { readonly url: string } | { readonly skipped: string }

declare module 'vitest' {
  export interface ProvidedContext {
    /** MySQL 8.4, the default engine for new apps. */
    mysql: ServerInfo
    /** MariaDB 11.4 (what XAMPP-style installs run). */
    mariadb: ServerInfo
    /** PostgreSQL 18, a real server (RLS as a non-owner role, node-postgres pooling). */
    postgres: ServerInfo
  }
}

interface ServerSpec {
  readonly key: 'mysql' | 'mariadb' | 'postgres'
  readonly image: string
  readonly port: number
  readonly offSwitch: string
  readonly env: (password: string) => readonly string[]
  readonly url: (password: string, port: number) => string
}

const SERVERS: readonly ServerSpec[] = [
  {
    key: 'mysql',
    image: 'mysql:8.4',
    port: 3306,
    offSwitch: 'STRUTVANE_TEST_MYSQL',
    env: (password) => [`MYSQL_ROOT_PASSWORD=${password}`],
    url: (password, port) => `mysql://root:${encodeURIComponent(password)}@127.0.0.1:${port}`,
  },
  {
    key: 'mariadb',
    image: 'mariadb:11.4',
    port: 3306,
    offSwitch: 'STRUTVANE_TEST_MARIADB',
    env: (password) => [`MARIADB_ROOT_PASSWORD=${password}`],
    url: (password, port) => `mysql://root:${encodeURIComponent(password)}@127.0.0.1:${port}`,
  },
  {
    key: 'postgres',
    image: 'postgres:18-alpine',
    port: 5432,
    offSwitch: 'STRUTVANE_TEST_POSTGRES',
    env: (password) => [`POSTGRES_PASSWORD=${password}`],
    url: (password, port) =>
      `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
  },
]

/** Start the servers (or record why not) and hand their URLs to the test files. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const docker = process.env['STRUTVANE_TEST_DOCKER'] === 'off' ? false : await dockerAvailable()
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
  const started: string[] = []
  const stopAll = async (): Promise<void> => {
    await Promise.all(started.map((name) => removeOwnContainer(name)))
  }
  try {
    const infos = await Promise.all(
      SERVERS.map(async (server): Promise<ServerInfo> => {
        if (process.env['STRUTVANE_TEST_DOCKER'] === 'off')
          return { skipped: 'STRUTVANE_TEST_DOCKER=off' }
        if (process.env[server.offSwitch] === 'off') return { skipped: `${server.offSwitch}=off` }
        if (!docker) return { skipped: `Docker is not available to start ${server.image}` }
        const name = `strutvane-fw-test-${server.key}-${suffix}`
        started.push(name)
        return { url: await startServer(server, name) }
      }),
    )
    SERVERS.forEach((server, index) => {
      const info = infos[index]
      if (info !== undefined) project.provide(server.key, info)
    })
  } catch (error) {
    await stopAll()
    throw error
  }
  return stopAll
}

async function startServer(server: ServerSpec, name: string): Promise<string> {
  const port = await freePort()
  const password = randomBytes(18).toString('base64url')
  const env = server.env(password).flatMap((entry) => ['-e', entry])
  await run(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      ...env,
      '-p',
      `127.0.0.1:${port}:${server.port}`,
      server.image,
    ],
    { timeout: 600_000 },
  )
  const url = server.url(password, port)
  await waitUntilReady(server.key, url)
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

/** Remove one container this run started, by exact name; "no such container" is fine. */
async function removeOwnContainer(name: string): Promise<void> {
  try {
    await run('docker', ['rm', '-f', name], { timeout: 60_000 })
  } catch {
    // Already gone.
  }
}

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

/** First boots initialise a data directory and restart once: poll until a query works. */
async function waitUntilReady(key: ServerSpec['key'], url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await ping(key, url)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error(
    `${key} did not become ready within ${READY_TIMEOUT_MS / 1000}s: ${String(lastError)}`,
  )
}

async function ping(key: ServerSpec['key'], url: string): Promise<void> {
  if (key === 'postgres') {
    const pg = await import('pg')
    const client = new pg.default.Client({ connectionString: url })
    await client.connect()
    try {
      await client.query('SELECT 1')
    } finally {
      await client.end()
    }
    return
  }
  const mysql = await import('mysql2/promise')
  const connection = await mysql.createConnection(url)
  try {
    await connection.query('SELECT 1')
  } finally {
    await connection.end()
  }
}
