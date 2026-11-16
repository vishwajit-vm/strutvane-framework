/**
 * Which connection models use.
 *
 * Laravel resolves a model's connection through a global resolver set at boot. Strutvane does
 * the same: the framework's database provider calls {@link useConnection} once, and models find
 * it lazily, so importing a model never opens a database. (Multiple named connections are in
 * the design; this prototype needs one.)
 */
import { OrmUsageError } from '../orm/errors.ts'
import type { Connection } from './connection.ts'

let current: Connection | undefined

/**
 * Make `connection` the one every model uses.
 *
 * @example
 * useConnection(new Connection(sqliteDriver(':memory:')))
 */
export function useConnection(connection: Connection): void {
  current = connection
}

/**
 * The connection models use. Throws a friendly error before boot.
 *
 * @example
 * await defaultConnection().run(sql`SELECT 1`)
 */
export function defaultConnection(): Connection {
  if (current === undefined) {
    throw new OrmUsageError(
      'NO_CONNECTION',
      'No database connection is set yet. Call useConnection(connection) at boot (the framework does this for you).',
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
