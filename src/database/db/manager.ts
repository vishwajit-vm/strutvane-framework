/**
 * Which connection models use.
 *
 * Laravel resolves a model's connection through a resolver the framework sets at boot. Strutvane
 * has two ways in, checked in this order:
 *
 * 1. **The running application's connection.** Every request and console command of an
 *    `Application` runs inside {@link runWithConnection}, so a model resolves *that* app's
 *    connection, lazily, even when two apps live in one process (tests) and never each other's.
 * 2. **A process-wide connection** set with {@link useConnection}: what `node strut db:seed` and
 *    scripts without an application use.
 *
 * Importing a model never opens a database: the connection is looked up when a query runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { OrmUsageError } from '../orm/errors.ts'
import type { AfterCommitCallback, Connection } from './connection.ts'

let current: Connection | undefined
const scoped = new AsyncLocalStorage<() => Connection>()

/**
 * Make `connection` the one every model uses outside an application (seeders, scripts).
 *
 * @example
 * useConnection(new Connection(sqliteDriver(':memory:')))
 */
export function useConnection(connection: Connection): void {
  current = connection
}

/**
 * Run `work` with models resolving their connection through `resolve` (called on each query, so
 * it can create the connection on first use). The application wraps every request and command in
 * this; it wins over {@link useConnection} for everything inside `work`.
 *
 * @example
 * await runWithConnection(() => app.make(DatabaseConnectionToken), () => Post.all())
 */
export function runWithConnection<TResult>(
  resolve: () => Connection,
  work: () => TResult,
): TResult {
  return scoped.run(resolve, work)
}

/**
 * The connection models use. Throws a friendly error when there is none.
 *
 * @example
 * await defaultConnection().run(sql`SELECT 1`)
 */
export function defaultConnection(): Connection {
  const resolve = scoped.getStore()
  if (resolve !== undefined) return resolve()
  if (current === undefined) {
    throw new OrmUsageError(
      'no_connection',
      'No database connection is set yet. Inside an application, models use the connection from config/database.ts and DB_* in .env; outside one (a script), call useConnection(connection) first.',
    )
  }
  return current
}

/**
 * Run `fn` in a transaction on the default connection (Laravel's `DB::transaction`).
 *
 * @example
 * await transaction(async () => { await post.save(); await tag.save() })
 */
export function transaction<T>(fn: () => Promise<T>): Promise<T> {
  return defaultConnection().transaction(fn)
}

/**
 * Run `callback` once the current transaction on the default connection commits (at once outside
 * a transaction; never after a rollback). Laravel's `DB::afterCommit`.
 *
 * @example
 * await transaction(async () => {
 *   await order.save()
 *   await afterCommit(() => notify(order))
 * })
 */
export function afterCommit(callback: AfterCommitCallback): Promise<void> {
  return defaultConnection().afterCommit(callback)
}
