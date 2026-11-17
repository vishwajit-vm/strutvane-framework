/**
 * A fresh database per test file on the run's throwaway servers (see `db-servers.ts`), so test
 * files can run in parallel without sharing tables. Dropped again when the file is done.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { inject, vi } from 'vitest'
import type { ServerInfo } from './db-servers.ts'

// Suites on real servers and PGlite share the machine with the whole gate: give their hooks and
// tests room under load (the defaults are 60 s), so a slow container start isn't a failure.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 })

/** A database created for one test file. */
export interface ServerDatabase {
  /** A URL pointing at the new database. */
  readonly url: string
  /** Drop the database. Safe to call twice. */
  drop(): Promise<void>
}

/** The provided info for an engine (`skipped` explains a skip in the test title). */
export function serverInfo(engine: 'mysql' | 'mariadb' | 'postgres'): ServerInfo {
  return inject(engine)
}

/** The reason a real-server engine is skipped, or `undefined` when it runs. */
export function skipReason(engine: 'mysql' | 'mariadb' | 'postgres'): string | undefined {
  const info = serverInfo(engine)
  return 'skipped' in info ? info.skipped : undefined
}

/**
 * Create `sv_<random>` on the engine's server and return a URL for it.
 *
 * @example
 * const db = await serverDatabase('mysql')
 * const driver = mysqlDriver({ uri: db.url })
 */
export async function serverDatabase(
  engine: 'mysql' | 'mariadb' | 'postgres',
): Promise<ServerDatabase> {
  const info = serverInfo(engine)
  if (!('url' in info)) throw new Error(`${engine} is not available: ${info.skipped}`)
  const name = `sv_${randomBytes(6).toString('hex')}`
  if (engine === 'postgres') {
    const pg = await import('pg')
    const admin = async (sql: string): Promise<void> => {
      const client = new pg.default.Client({ connectionString: info.url })
      await client.connect()
      try {
        await client.query(sql)
      } finally {
        await client.end()
      }
    }
    await admin(`CREATE DATABASE "${name}"`)
    let dropped = false
    return {
      url: info.url.replace(/\/postgres$/, `/${name}`),
      async drop() {
        if (dropped) return
        dropped = true
        await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      },
    }
  }
  const mysql = await import('mysql2/promise')
  const admin = async (sql: string): Promise<void> => {
    const connection = await mysql.createConnection({ uri: info.url, connectTimeout: 60_000 })
    try {
      await connection.query(sql)
    } finally {
      await connection.end()
    }
  }
  await admin(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`)
  let dropped = false
  return {
    // mysql2's default 10 s connect timeout is too short while the gate loads every core.
    url: `${info.url}/${name}?connectTimeout=60000`,
    async drop() {
      if (dropped) return
      dropped = true
      await admin(`DROP DATABASE IF EXISTS \`${name}\``)
    },
  }
}
