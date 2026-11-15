/**
 * A Postgres that stops answering must not hang the app. Real `pg` driver against a fake server
 * speaking just enough of the wire protocol:
 * - `blackhole`: accepts TCP connections and never replies (an unreachable or overloaded server,
 *   or a pool whose connections are all taken: the wait for a connection must end);
 * - `stalls`: completes the startup handshake, then never answers a query (a frozen server or a
 *   network partition mid-request; the server-side `statement_timeout` cannot help there).
 * Without client-side limits both wait forever, holding the request and its pooled connection.
 * The Docker-based chaos run (`docker pause` on a real Postgres) is in test/soak.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  connectDatabase,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  pgPoolOptions,
} from '../../src/database/connect.ts'
import type { Database } from '../../src/database/types.ts'

const servers: Server[] = []
const sockets = new Set<Socket>()
const databases: Database[] = []
afterEach(async () => {
  for (const s of sockets) s.destroy()
  sockets.clear()
  await Promise.all(databases.splice(0).map((d) => d.close().catch(() => undefined)))
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

/** AuthenticationOk + ReadyForQuery(idle). */
const HANDSHAKE = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49])

async function fakePostgres(mode: 'blackhole' | 'stalls'): Promise<number> {
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    let started = false
    socket.on('data', () => {
      if (mode === 'stalls' && !started) {
        started = true
        socket.write(HANDSHAKE)
      }
      // Anything after that (the query) is never answered.
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

async function open(port: number, pool: Record<string, number>): Promise<Database> {
  const db = await connectDatabase({
    driver: 'postgres',
    url: `postgres://app:app@127.0.0.1:${port}/app`,
    pool,
  })
  databases.push(db)
  return db
}

/** Settles with how the operation ended and how long it took. */
async function outcome(work: Promise<unknown>, giveUpMs = 10_000) {
  const started = Date.now()
  const result = await Promise.race([
    work.then(
      () => 'resolved',
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    ),
    new Promise<string>((r) => setTimeout(() => r('hung'), giveUpMs).unref()),
  ])
  return { result, ms: Date.now() - started }
}

describe('Postgres client-side timeouts', () => {
  it('defaults: a bounded wait for a connection and a client-side query limit', () => {
    expect(pgPoolOptions({ driver: 'postgres' })).toMatchObject({
      connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
      query_timeout: DEFAULT_STATEMENT_TIMEOUT_MS + 2_000,
    })
    // Disabling the statement timeout leaves the query unbounded only when asked twice.
    const unlimited = pgPoolOptions({
      driver: 'postgres',
      pool: { statementTimeoutMs: 0, queryTimeoutMs: 0 },
    })
    expect(unlimited).not.toHaveProperty('query_timeout')
    expect(pgPoolOptions({ driver: 'postgres', pool: { statementTimeoutMs: 0 } })).toMatchObject({
      query_timeout: 30_000,
    })
    for (const bad of [{ connectionTimeoutMs: -1 }, { queryTimeoutMs: 1.5 }])
      expect(() => pgPoolOptions({ driver: 'postgres', pool: bad })).toThrow(RangeError)
  })

  it('an unreachable server: the query fails after the connection timeout, it never hangs', async () => {
    const db = await open(await fakePostgres('blackhole'), { connectionTimeoutMs: 300 })
    const { result, ms } = await outcome(db.query('SELECT 1'))
    expect(result).toMatch(/^rejected: .*timeout/i)
    expect(ms).toBeLessThan(5_000)
    const tx = await outcome(db.transaction(async (t) => t.query('SELECT 1')))
    expect(tx.result).toMatch(/^rejected/)
  })

  it('a server that stops answering mid-query: the query and the transaction fail, never hang', async () => {
    const db = await open(await fakePostgres('stalls'), {
      connectionTimeoutMs: 1_000,
      queryTimeoutMs: 300,
    })
    const { result, ms } = await outcome(db.query('SELECT 1'))
    expect(result).toMatch(/^rejected: .*timeout/i)
    expect(ms).toBeLessThan(5_000)
    // In a transaction the ROLLBACK hits the same wall; the connection is destroyed, not reused.
    const tx = await outcome(db.transaction(async (t) => t.query('SELECT 1')))
    expect(tx.result).toMatch(/^rejected/)
    expect(tx.ms).toBeLessThan(5_000)
  })
})
