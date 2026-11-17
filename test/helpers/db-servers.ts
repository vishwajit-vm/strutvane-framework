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
 * - Docker counts as usable only when it runs **Linux containers** (`docker version` reports a
 *   `linux` server). GitHub's Windows runners have Docker with Windows containers only, where
 *   `docker run mysql:8.4` fails with "no matching manifest".
 *
 * Environment variables:
 *
 * | Variable | Values | Effect |
 * |---|---|---|
 * | `STRUTVANE_TEST_DOCKER` | unset / `auto` | Start the servers when Docker runs Linux containers. A server that can't start is skipped, with the reason in the test title, and the rest of the run goes on. |
 * | | `off` | Start nothing; every real-server suite is skipped on purpose. |
 * | | `require` | Every server must start (unless switched off below); otherwise the run fails at setup. |
 * | | anything else | Refused at setup (a typo must not change what runs). |
 * | `STRUTVANE_TEST_MYSQL`, `STRUTVANE_TEST_MARIADB`, `STRUTVANE_TEST_POSTGRES` | `off` | Skip that one server. |
 * | `CI` (set by CI services) | set, not `false`/`0` | On **Linux** this acts like `require`: Linux runners always run Linux containers, so a server that can't start there is a broken runner or image and must fail loudly, never silently drop the real-server coverage. On Windows and macOS runners `auto` applies. |
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

/** One throwaway server: its image, port, off switch and how to reach it. */
export interface ServerSpec {
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

/** How the run treats Docker, from `STRUTVANE_TEST_DOCKER` (see the module docs). */
export type DockerMode = 'auto' | 'off' | 'require'

/**
 * Read `STRUTVANE_TEST_DOCKER`. Unset (or empty) is `auto`; an unknown value is refused, so a typo
 * such as `of` can never quietly turn into "start everything" or "skip everything".
 *
 * @example
 * dockerMode({ STRUTVANE_TEST_DOCKER: 'require' }) // 'require'
 */
export function dockerMode(env: Readonly<Record<string, string | undefined>>): DockerMode {
  const value = env['STRUTVANE_TEST_DOCKER'] ?? ''
  if (value === '' || value === 'auto') return 'auto'
  if (value === 'off' || value === 'require') return value
  throw new Error(
    `STRUTVANE_TEST_DOCKER=${JSON.stringify(value)} is not a known value. Use off, require or auto (the default).`,
  )
}

/**
 * Must a server that cannot start fail the run? Yes with `STRUTVANE_TEST_DOCKER=require`, and on
 * Linux CI, where Docker always runs Linux containers: there a failed start is a broken runner or
 * image, and silently skipping would hide the loss of every real-server suite.
 *
 * @example
 * mustStart('auto', { CI: 'true' }, 'linux') // true
 * mustStart('auto', { CI: 'true' }, 'win32') // false: Windows runners only run Windows containers
 */
export function mustStart(
  mode: DockerMode,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): boolean {
  if (mode === 'require') return true
  if (mode === 'off') return false
  const ci = env['CI']
  return platform === 'linux' && ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0'
}

/** What {@link resolveServers} needs from the outside world (injected so it can be unit-tested). */
export interface ServerEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
  /** `undefined` when Docker can run Linux containers, otherwise why not. */
  readonly dockerUnusable: () => Promise<string | undefined>
  /** Start one server under `name`; resolves to its admin URL. */
  readonly start: (server: ServerSpec, name: string) => Promise<string>
  /** Remove a container this run started (never fails). */
  readonly remove: (name: string) => Promise<void>
}

/**
 * Decide, per server, between a URL and a skip reason, starting the containers that should run.
 * A server that fails to start is removed again and skipped with the reason, unless
 * {@link mustStart} says the failure must fail the run; then every container started so far is
 * removed and the error (password redacted) is thrown.
 *
 * @returns the info per server (in {@link SERVERS} order) and the names of the containers started.
 */
export async function resolveServers(
  servers: readonly ServerSpec[],
  outside: ServerEnvironment,
  suffix: string,
): Promise<{ readonly infos: readonly ServerInfo[]; readonly started: readonly string[] }> {
  const mode = dockerMode(outside.env)
  const strict = mustStart(mode, outside.env, outside.platform)
  const started: string[] = []
  if (mode === 'off')
    return { infos: servers.map(() => ({ skipped: 'STRUTVANE_TEST_DOCKER=off' })), started }
  const wanted = servers.filter((server) => outside.env[server.offSwitch] !== 'off')
  const unusable = wanted.length === 0 ? undefined : await outside.dockerUnusable()
  if (unusable !== undefined && strict)
    throw new Error(
      `${unusable}. The real-server suites must run here (${strictReason(mode)}); fix Docker, or set STRUTVANE_TEST_DOCKER=off to skip them on purpose.`,
    )
  const results = await Promise.allSettled(
    servers.map(async (server): Promise<ServerInfo> => {
      if (outside.env[server.offSwitch] === 'off') return { skipped: `${server.offSwitch}=off` }
      if (unusable !== undefined) return { skipped: `${unusable} (needed for ${server.image})` }
      const name = `strutvane-fw-test-${server.key}-${suffix}`
      started.push(name)
      try {
        return { url: await outside.start(server, name) }
      } catch (error) {
        if (strict) throw error
        await outside.remove(name)
        return { skipped: `${server.image} could not start: ${firstLine(error)}` }
      }
    }),
  )
  const failed = results.find((result) => result.status === 'rejected')
  if (failed !== undefined) {
    await Promise.all(started.map((name) => outside.remove(name)))
    throw new Error(
      `A test database server could not start, and the real-server suites must run here (${strictReason(mode)}): ${firstLine(failed.reason)}`,
      { cause: failed.reason },
    )
  }
  return {
    infos: results.map((result) => (result.status === 'fulfilled' ? result.value : unreachable())),
    started,
  }
}

const strictReason = (mode: DockerMode): string =>
  mode === 'require' ? 'STRUTVANE_TEST_DOCKER=require' : 'Linux CI'

function unreachable(): never {
  throw new Error('unreachable: rejected results were handled above')
}

/** The first line of an error's message: enough for a test title, never a whole stack. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split(/\r?\n/).find((line) => line.trim() !== '') ?? 'unknown error').trim()
}

/** Start the servers (or record why not) and hand their URLs to the test files. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
  const { infos, started } = await resolveServers(
    SERVERS,
    {
      env: process.env,
      platform: process.platform,
      dockerUnusable,
      start: startServer,
      remove: removeOwnContainer,
    },
    suffix,
  )
  SERVERS.forEach((server, index) => {
    const info = infos[index]
    if (info !== undefined) project.provide(server.key, info)
  })
  return async () => {
    await Promise.all(started.map((name) => removeOwnContainer(name)))
  }
}

async function startServer(server: ServerSpec, name: string): Promise<string> {
  const port = await freePort()
  const password = randomBytes(18).toString('base64url')
  const env = server.env(password).flatMap((entry) => ['-e', entry])
  try {
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
  } catch (error) {
    // Node's message repeats the whole command line, password included: report Docker's own
    // words (stderr) instead, and never the password, even if Docker echoed it.
    const stderr = (error as { stderr?: unknown }).stderr
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : firstLine(error)
    throw new Error(`docker run ${server.image}: ${redact(firstLine(detail), password)}`)
  }
  const url = server.url(password, port)
  await waitUntilReady(server.key, url)
  return url
}

/** `text` with every occurrence of `secret` replaced by `***`. */
export function redact(text: string, secret: string): string {
  return secret === '' ? text : text.replaceAll(secret, '***')
}

/**
 * `undefined` when Docker can run the test servers (a Linux container engine), else why not.
 * `{{.Server.Os}}` is the engine's container OS: `linux`, or `windows` for Docker in Windows
 * containers mode (GitHub's Windows runners), which cannot run `mysql:8.4` and the others.
 */
async function dockerUnusable(): Promise<string | undefined> {
  let os: string
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Os}}'], {
      timeout: 15_000,
    })
    os = stdout.trim()
  } catch {
    return 'Docker is not available'
  }
  return os === 'linux'
    ? undefined
    : `Docker runs ${os === '' ? 'non-Linux' : os} containers here; the test servers need Linux containers`
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
