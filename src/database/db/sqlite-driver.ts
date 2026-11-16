/**
 * SQLite through Node's built-in `node:sqlite` (no native addon to compile, no dependency).
 *
 * Why node:sqlite for the default: it ships with Node 24+, so `npm create strutvane` works on
 * any machine without a C++ toolchain; better-sqlite3 is faster on some workloads but needs a
 * prebuilt binary per platform, and libSQL is the pick when the database is remote (Turso).
 * The ORM only needs the {@link Driver} contract, so all three can be offered.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Driver, DriverSession, QueryResult, Row } from './driver.ts'
import { Mutex } from './mutex.ts'

/** Prepared statements kept per connection. Re-preparing is the main cost of small queries. */
const STATEMENT_CACHE_LIMIT = 256

/**
 * Open a SQLite database (`':memory:'` or a file path).
 *
 * @example
 * const driver = sqliteDriver(':memory:')
 */
export function sqliteDriver(location: string): Driver {
  const database = new DatabaseSync(location)
  // SQLite ships with foreign keys off for backwards compatibility; Strutvane migrations rely on them.
  database.exec('PRAGMA foreign_keys = ON')
  // SQLite's built-in lower() folds only A-Z, so a case-insensitive search for 'émile' missed
  // 'Émile' here while PostgreSQL and MySQL found it. Replace it with JavaScript's Unicode lower
  // case (deterministic, so SQLite may still use it in indexes and constraints).
  database.function('lower', { deterministic: true }, (value) => (typeof value === 'string' ? value.toLowerCase() : value))
  const statements = new Map<string, StatementSync>()
  const mutex = new Mutex()
  let closed = false

  const prepare = (sql: string): StatementSync => {
    const cached = statements.get(sql)
    if (cached !== undefined) return cached
    const statement = database.prepare(sql)
    // Evict the oldest entry: Map iteration order is insertion order.
    if (statements.size >= STATEMENT_CACHE_LIMIT) {
      const oldest = statements.keys().next()
      if (oldest.done !== true) statements.delete(oldest.value)
    }
    statements.set(sql, statement)
    return statement
  }

  const run = async (sql: string, params: readonly unknown[]): Promise<QueryResult> => {
    const statement = prepare(sql)
    const args = params.map(toSqliteValue)
    // Statements that produce columns (SELECT, … RETURNING) are read with all(); others with run().
    if (statement.columns().length > 0) {
      const rows: Row[] = statement.all(...args)
      return { rows, rowsAffected: rows.length }
    }
    const result = statement.run(...args)
    return { rows: [], rowsAffected: Number(result.changes) }
  }

  return {
    dialect: 'sqlite',
    async acquire(): Promise<DriverSession> {
      if (closed) throw new Error('This SQLite database is closed. Create a new connection instead of reusing a closed one.')
      const unlock = await mutex.lock()
      return { run, release: () => unlock() }
    },
    async close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
}

type SqliteValue = null | number | bigint | string | Uint8Array

/** SQLite has no boolean or Date type: store booleans as 0/1 and refuse anything else unknown. */
function toSqliteValue(raw: unknown): SqliteValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'string' || raw instanceof Uint8Array) return raw
  if (raw instanceof Date) return raw.toISOString()
  throw new TypeError(`SQLite can't store a value of type ${typeof raw}. Convert it to a string, number or JSON first.`)
}
