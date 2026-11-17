/**
 * Small SQL helpers the migrator shares: run trusted DDL text, and hold the migration lock.
 *
 * @module
 */
import type { Connection } from '../database/db/connection.ts'
import { sql, trustedSql } from '../database/sql/fragment.ts'
import type { Dialect } from '../schema/ddl/dialect.ts'
import { MigrationError } from './migration-error.ts'

/**
 * MySQL and MariaDB: no transactional DDL, `GET_LOCK` for the migration lock.
 *
 * @example
 * isMysqlFamily('mariadb') // true
 */
export function isMysqlFamily(dialect: Dialect): boolean {
  return dialect === 'mysql' || dialect === 'mariadb'
}

/**
 * Run one statement the framework generated itself (migration DDL compiled from recorded
 * operations, or fixed bookkeeping SQL). It is trusted text: it never contains a value from a
 * request, and it still passes the connection's statement guard.
 *
 * @example
 * await exec(connection, 'CREATE TABLE "tags" ("id" INTEGER PRIMARY KEY)')
 */
export async function exec(connection: Connection, statement: string): Promise<void> {
  await connection.run(trustedSql([{ kind: 'text', text: statement }]))
}

/**
 * The outcome of {@link migrationLock}: the work's value, or `locked` when `isolated` was set and
 * another migrator held the lock.
 *
 * @example
 * const outcome: LockOutcome<string[]> = { locked: false, value: [] }
 */
export type LockOutcome<T> =
  | { readonly locked: false; readonly value: T }
  | { readonly locked: true }

/** The lock's name, per database, so two apps on one server don't block each other. */
const LOCK_PREFIX = 'strutvane:migrate:'
const POLL_MS = 100

/**
 * Run `work` while holding the migration lock, on one pinned connection.
 *
 * - PostgreSQL: a session advisory lock keyed on `hashtext('strutvane:migrate:' || database)`,
 *   polled with `pg_try_advisory_lock` until `timeoutMs`.
 * - MySQL/MariaDB: `GET_LOCK('strutvane:migrate:<database>', seconds)`.
 * - SQLite: one writer per database file already; the pinned connection is enough in process.
 *
 * Without `isolated`, a lock still held after `timeoutMs` is an error naming the cause; with it,
 * the call returns `{ locked: true }` at once and runs nothing. The lock is always released, and a
 * dropped connection releases it on the server too.
 *
 * @example
 * const outcome = await migrationLock(connection, { isolated: false, timeoutMs: 10_000 }, () => run())
 */
export async function migrationLock<T>(
  connection: Connection,
  options: { readonly isolated: boolean; readonly timeoutMs: number },
  work: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const dialect = connection.grammar.dialect
  return connection.session(async () => {
    if (dialect === 'sqlite') return { locked: false, value: await work() }
    const acquired =
      dialect === 'postgres'
        ? await pgLock(connection, options)
        : await mysqlLock(connection, options)
    if (!acquired) {
      if (options.isolated) return { locked: true }
      throw lockedError(options.timeoutMs)
    }
    try {
      return { locked: false, value: await work() }
    } finally {
      if (dialect === 'postgres')
        await connection.run(
          sql`SELECT pg_advisory_unlock(hashtext(CAST(${LOCK_PREFIX} AS text) || current_database()))`,
        )
      else
        await connection.run(sql`SELECT RELEASE_LOCK(LEFT(CONCAT(${LOCK_PREFIX}, DATABASE()), 64))`)
    }
  })
}

async function pgLock(
  connection: Connection,
  options: { readonly isolated: boolean; readonly timeoutMs: number },
): Promise<boolean> {
  const deadline = Date.now() + (options.isolated ? 0 : options.timeoutMs)
  for (;;) {
    const { rows } = await connection.run(
      sql`SELECT pg_try_advisory_lock(hashtext(CAST(${LOCK_PREFIX} AS text) || current_database())) AS ${sql.id('locked')}`,
    )
    if (rows[0]?.['locked'] === true) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function mysqlLock(
  connection: Connection,
  options: { readonly isolated: boolean; readonly timeoutMs: number },
): Promise<boolean> {
  const seconds = options.isolated ? 0 : Math.max(0, Math.ceil(options.timeoutMs / 1000))
  const { rows } = await connection.run(
    sql`SELECT GET_LOCK(LEFT(CONCAT(${LOCK_PREFIX}, DATABASE()), 64), ${seconds}) AS ${sql.id('locked')}`,
  )
  return Number(rows[0]?.['locked']) === 1
}

/** The friendly error for a lock another migrator kept too long. */
function lockedError(timeoutMs: number): MigrationError {
  return new MigrationError(
    'migration_locked',
    `Another migration run is in progress on this database (it has held the lock for more than ${Math.round(timeoutMs / 1000)} s).`,
    'Wait for it to finish and run node strut migrate again. Use --isolated to skip instead of waiting when another server is already migrating.',
  )
}
