/**
 * Production PostgreSQL through node-postgres (`pg`, an optional peer dependency loaded on first
 * use), with the connection rules of ADR-0007:
 * - the tenant is set transaction-locally by the {@link Connection} (`set_config(…, true)`), never
 *   per session, so it can't leak through pooling;
 * - a client that emits `error` (the server went away mid-transaction) is **destroyed**, never
 *   handed back to the pool, and the process does not crash;
 * - every connection gets the pool's `statement_timeout` and a client-side query timeout (the same
 *   settings as v1's `pgPoolOptions`), so one runaway query can't hold a connection forever.
 *
 * Type parsing is pinned per pool (never through `pg.types`, which is process-global):
 * `DATE` stays the text the server sent (as a JS `Date` it would be local midnight and could show
 * the previous day), and timestamps are parsed exactly, including years 0001–0099.
 *
 * @module
 */
import { parsePgTimestamp } from '../drivers.ts'
import type { Driver, DriverSession, QueryResult, Row } from './driver.ts'

/** The node-postgres pool options this driver passes through (structural, so `pg` stays optional). */
export type PgPoolSettings = Readonly<Record<string, unknown>>

interface PgClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
  release(error?: Error | boolean): void
  on(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

interface PgPool {
  connect(): Promise<PgClient>
  end(): Promise<void>
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Postgres type OIDs parsed specially. */
const DATE_OID = 1082
const TIMESTAMP_OID = 1114
const TIMESTAMPTZ_OID = 1184

/** Per-pool type parsers (see the module notes). */
function typeParsers(builtin: (oid: number, format?: string) => unknown): {
  getTypeParser(oid: number, format?: string): unknown
} {
  return {
    getTypeParser(oid, format) {
      if (format !== 'binary') {
        if (oid === DATE_OID) return (text: string) => text
        if (oid === TIMESTAMP_OID || oid === TIMESTAMPTZ_OID)
          return (text: string) => parsePgTimestamp(text)
      }
      return builtin(oid, format)
    },
  }
}

/**
 * Open a pooled PostgreSQL driver. `settings` are node-postgres `Pool` options (use
 * `pgPoolOptions(config)` to build them from `config/database.ts`).
 *
 * @example
 * const connection = new Connection(pgDriver({ connectionString: process.env.DB_URL }))
 */
export function pgDriver(settings: PgPoolSettings): Driver {
  let pool: Promise<PgPool> | undefined
  let closed = false

  const open = (): Promise<PgPool> => {
    pool ??= import('pg').then((module) => {
      const pg = module.default ?? module
      const created = new pg.Pool({
        ...settings,
        types: typeParsers((oid, format) =>
          pg.types.getTypeParser(oid, format === 'binary' ? 'binary' : 'text'),
        ),
      }) as unknown as PgPool
      // An idle client erroring must not crash the process (ADR-0007 rule 5); the pool drops it.
      created.on('error', () => undefined)
      return created
    })
    return pool
  }

  return {
    dialect: 'postgres',
    async acquire(): Promise<DriverSession> {
      if (closed)
        throw new Error(
          'This PostgreSQL connection is closed. Create a new connection instead of reusing a closed one.',
        )
      const client = await (await open()).connect()
      let broken: Error | undefined
      const onError = (error: Error): void => {
        broken = error
      }
      client.on('error', onError)
      let released = false
      return {
        async run(sql: string, params: readonly unknown[]): Promise<QueryResult> {
          const result = await client.query(sql, [...params])
          return { rows: result.rows, rowsAffected: result.rowCount ?? result.rows.length }
        },
        release(destroy = false) {
          if (released) return
          released = true
          client.off('error', onError)
          // `release(err)` destroys the connection instead of returning it to the pool.
          client.release(broken ?? (destroy ? new Error('connection discarded') : false))
        },
      }
    },
    async close() {
      if (closed) return
      closed = true
      if (pool !== undefined) await (await pool).end()
    },
  }
}
