/**
 * The driver contract: the smallest thing an engine must do for the ORM.
 *
 * Drivers only move bytes. They never build SQL, never decide on transactions and never know
 * about models. That keeps each one ~60 lines and makes a new engine (node-postgres, mysql2,
 * libSQL) a small, separately testable piece.
 */
import type { Dialect } from '../sql/grammar.ts'

/** A row as a driver returns it: column name → raw value. */
export type Row = Readonly<Record<string, unknown>>

/**
 * The result of one statement.
 *
 * @example
 * const result: QueryResult = { rows: [], rowsAffected: 1 }
 */
export interface QueryResult {
  readonly rows: readonly Row[]
  readonly rowsAffected: number
  /** The auto-increment id of an INSERT, where the engine reports one (MySQL needs it: no RETURNING). */
  readonly insertId?: number | string
}

/**
 * One borrowed connection. Everything a transaction does goes through the same session, and it
 * must be released exactly once.
 *
 * @example
 * const session = await driver.acquire()
 * try { await session.run('SELECT 1', []) } finally { session.release() }
 */
export interface DriverSession {
  run(sql: string, params: readonly unknown[]): Promise<QueryResult>
  /** Give the connection back. `broken: true` destroys it instead of reusing it (ADR-0007 rule 5). */
  release(broken?: boolean): void
}

/**
 * An engine.
 *
 * @example
 * const driver: Driver = sqliteDriver(':memory:')
 */
export interface Driver {
  readonly dialect: Dialect
  /** Set when the server version changes the dialect's default (MariaDB 10.4: no INSERT … RETURNING). */
  readonly insertReturning?: boolean
  /** Borrow a connection, waiting if none is free. */
  acquire(): Promise<DriverSession>
  /** Close every connection. Safe to call twice. */
  close(): Promise<void>
}
