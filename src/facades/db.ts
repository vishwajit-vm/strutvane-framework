/**
 * The `DB` facade: the current app's primary database connection (the `Database` contract),
 * Laravel's `DB::`. Parameters are always bound, never interpolated.
 *
 * @module
 */
import type { Database, Dialect, Row, TransactionOptions } from '../database/types.ts'
import { DatabaseToken } from '../tokens.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<Database> = {
  facade: 'DB',
  token: DatabaseToken,
  provides: 'a database connection',
  install:
    'Configure config/database.ts (DATABASE_URL in .env); the framework provider binds the connection when the app boots.',
}

/**
 * What the `DB` facade offers.
 *
 * @example
 * const db: DbFacade = DB
 */
export interface DbFacade {
  /** The connection's SQL dialect. */
  readonly dialect: Dialect
  /** Run a query and return its rows (bound parameters). */
  query<TRow extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<TRow[]>
  /** Run a statement and return the number of affected rows. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>
  /** Run `work` in a transaction: commit if it resolves, roll back if it throws. */
  transaction<TResult>(
    work: (tx: Database) => Promise<TResult>,
    options?: TransactionOptions,
  ): Promise<TResult>
  /** The connection itself, for code that takes a `Database`. */
  connection(): Database
}

/**
 * Query the current app's database.
 *
 * @example
 * const rows = await DB.query('select id, title from posts where status = $1', ['published'])
 * await DB.transaction(async (tx) => tx.execute('update posts set views = views + 1 where id = $1', [id]))
 */
export const DB: DbFacade = Object.freeze({
  get dialect(): Dialect {
    return resolveFacade(binding, 'dialect').dialect
  },
  query: <TRow extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<TRow[]> =>
    resolveFacade(binding, 'query').query<TRow>(sql, params),
  execute: (sql: string, params?: readonly unknown[]): Promise<number> =>
    resolveFacade(binding, 'execute').execute(sql, params),
  transaction: <TResult>(
    work: (tx: Database) => Promise<TResult>,
    options?: TransactionOptions,
  ): Promise<TResult> => resolveFacade(binding, 'transaction').transaction(work, options),
  connection: (): Database => resolveFacade(binding, 'connection'),
})
