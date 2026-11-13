/**
 * Driver adapters. Each wraps an already-created client, so the app owns connection settings
 * (pool size, SSL, Azure Entra tokens via `@azure/postgresql-auth`) and Strutvane owns the SQL.
 *
 * - {@link pgliteDatabase}: PGlite (Postgres in WASM) for tests and local development.
 * - {@link libsqlDatabase}: libSQL / SQLite.
 * - {@link pgDatabase}: node-postgres `Pool` for production Postgres, applying ADR-0007:
 *   tenant set with `set_config(..., true)` inside the transaction, and broken connections
 *   destroyed instead of being returned to the pool.
 *
 * @module
 */
import {
  assertTenantId,
  type Database,
  type Row,
  TENANT_SETTING,
  type TransactionOptions,
} from './types.ts'

/** The subset of the PGlite API used here (structural, so PGlite stays an optional peer). */
export interface PgliteLike {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }>
  transaction<T>(fn: (tx: PgliteTxLike) => Promise<T>): Promise<T>
  close(): Promise<void>
}
/** A PGlite transaction handle. */
export interface PgliteTxLike {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }>
}

/** Wrap a PGlite instance. */
export function pgliteDatabase(client: PgliteLike): Database {
  let closed = false
  const fromTx = (tx: PgliteTxLike): Database => ({
    dialect: 'postgres',
    query: async <R extends Row>(sql: string, params: readonly unknown[] = []) =>
      (await tx.query<R>(sql, [...params])).rows,
    execute: async (sql, params = []) => (await tx.query(sql, [...params])).affectedRows ?? 0,
    transaction: (fn) => fn(fromTx(tx)), // already inside a transaction: reuse it
    close: async () => undefined,
  })
  return {
    dialect: 'postgres',
    query: async <R extends Row>(sql: string, params: readonly unknown[] = []) =>
      (await client.query<R>(sql, [...params])).rows,
    execute: async (sql, params = []) => (await client.query(sql, [...params])).affectedRows ?? 0,
    transaction: (fn, options) =>
      client.transaction(async (tx) => {
        await setTenant(fromTx(tx), options)
        return fn(fromTx(tx))
      }),
    async close() {
      if (closed) return
      closed = true
      await client.close()
    },
  }
}

/** The subset of the libSQL client API used here. */
export interface LibsqlLike {
  execute(statement: {
    sql: string
    args: unknown[]
  }): Promise<{ rows: unknown[]; rowsAffected: number; columns: string[] }>
  transaction(mode: 'write'): Promise<LibsqlTxLike>
  close(): void
}
/** A libSQL transaction handle. */
export interface LibsqlTxLike {
  execute(statement: {
    sql: string
    args: unknown[]
  }): Promise<{ rows: unknown[]; rowsAffected: number; columns: string[] }>
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): void
}

/** Convert a libSQL row (array-like with named props) to a plain object. */
function libsqlRows(result: { rows: unknown[]; columns: string[] }): Row[] {
  return result.rows.map((r) => {
    const row: Row = {}
    const rec = r as Record<string | number, unknown>
    result.columns.forEach((c, i) => {
      row[c] = rec[c] ?? rec[i] ?? null
    })
    return row
  })
}

/** SQLite has no boolean/undefined; normalise parameters. */
function sqliteArgs(params: readonly unknown[]): unknown[] {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p))
}

/** Wrap a libSQL client. Transactions are serialised (SQLite allows one writer). */
export function libsqlDatabase(client: LibsqlLike): Database {
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()
  const fromTx = (tx: LibsqlTxLike): Database => ({
    dialect: 'sqlite',
    query: async <R extends Row>(sql: string, params: readonly unknown[] = []) =>
      libsqlRows(await tx.execute({ sql, args: sqliteArgs(params) })) as R[],
    execute: async (sql, params = []) =>
      (await tx.execute({ sql, args: sqliteArgs(params) })).rowsAffected,
    transaction: (fn) => fn(fromTx(tx)),
    close: async () => undefined,
  })
  return {
    dialect: 'sqlite',
    query: async <R extends Row>(sql: string, params: readonly unknown[] = []) =>
      libsqlRows(await client.execute({ sql, args: sqliteArgs(params) })) as R[],
    execute: async (sql, params = []) =>
      (await client.execute({ sql, args: sqliteArgs(params) })).rowsAffected,
    transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const tx = await client.transaction('write')
        try {
          const result = await fn(fromTx(tx))
          await tx.commit()
          return result
        } catch (error) {
          await tx.rollback().catch(() => undefined)
          throw error
        } finally {
          tx.close()
        }
      }
      const next = queue.then(run, run)
      queue = next.catch(() => undefined)
      return next
    },
    async close() {
      if (closed) return
      closed = true
      client.close()
    },
  }
}

/** The subset of node-postgres' Pool used here. */
export interface PgPoolLike {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
  connect(): Promise<PgClientLike>
  end(): Promise<void>
}
/** A pooled node-postgres client. */
export interface PgClientLike {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
  /** `release(err)` destroys the connection instead of returning it to the pool. */
  release(err?: Error | boolean): void
  on(event: 'error', listener: (err: Error) => void): unknown
  off(event: 'error', listener: (err: Error) => void): unknown
}

/** Wrap a node-postgres Pool (production Postgres, including Azure Database for PostgreSQL). */
export function pgDatabase(pool: PgPoolLike): Database {
  let closed = false
  const fromClient = (client: PgClientLike): Database => ({
    dialect: 'postgres',
    query: async <R extends Row>(sql: string, params: readonly unknown[] = []) =>
      (await client.query<R>(sql, [...params])).rows,
    execute: async (sql, params = []) => (await client.query(sql, [...params])).rowCount ?? 0,
    transaction: (fn) => fn(fromClient(client)),
    close: async () => undefined,
  })
  return {
    dialect: 'postgres',
    query: async <R extends Row>(sql: string, params: readonly unknown[] = []) =>
      (await pool.query<R>(sql, [...params])).rows,
    execute: async (sql, params = []) => (await pool.query(sql, [...params])).rowCount ?? 0,
    async transaction<T>(
      fn: (tx: Database) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      if (options?.tenantId !== undefined) assertTenantId(options.tenantId)
      const client = await pool.connect()
      // A connection that dies mid-transaction emits 'error'. Without a listener the process
      // crashes (found in spike 03); with one, the connection is destroyed, never reused.
      let broken: Error | undefined
      const onError = (err: Error): void => {
        broken = err
      }
      client.on('error', onError)
      try {
        await client.query('BEGIN')
        const tx = fromClient(client)
        await setTenant(tx, options)
        const result = await fn(tx)
        await client.query('COMMIT')
        return result
      } catch (error) {
        broken ??= await client.query('ROLLBACK').then(
          () => undefined,
          (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
        )
        throw error
      } finally {
        client.off('error', onError)
        client.release(broken ?? false)
      }
    },
    async close() {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}

/** Set the transaction-local tenant (Postgres only; ADR-0007 rules 2 + 3). */
async function setTenant(tx: Database, options: TransactionOptions | undefined): Promise<void> {
  if (options?.tenantId === undefined) return
  assertTenantId(options.tenantId)
  await tx.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [options.tenantId])
}
