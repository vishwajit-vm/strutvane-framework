/**
 * PostgreSQL in WebAssembly (PGlite), for tests and local development.
 *
 * Production Postgres uses a pooled node-postgres driver with the same contract (the framework's
 * `pgDatabase` already implements the ADR-0007 connection rules); PGlite has one connection, so
 * it gets the same single-connection lock as SQLite.
 */
import type { PGlite } from '@electric-sql/pglite'
import type { Driver, DriverSession, QueryResult } from './driver.ts'
import { Mutex } from './mutex.ts'

/**
 * Wrap an open PGlite instance. The caller owns creating it (data dir, extensions).
 *
 * @example
 * const driver = pgliteDriver(await PGlite.create())
 */
export function pgliteDriver(client: PGlite): Driver {
  const mutex = new Mutex()
  let closed = false

  const run = async (sql: string, params: readonly unknown[]): Promise<QueryResult> => {
    const result = await client.query<Record<string, unknown>>(sql, [...params])
    return { rows: result.rows, rowsAffected: result.affectedRows ?? result.rows.length }
  }

  return {
    dialect: 'postgres',
    async acquire(): Promise<DriverSession> {
      if (closed) throw new Error('This PGlite database is closed. Create a new connection instead of reusing a closed one.')
      const unlock = await mutex.lock()
      return { run, release: () => unlock() }
    },
    async close() {
      if (closed) return
      closed = true
      await client.close()
    },
  }
}
