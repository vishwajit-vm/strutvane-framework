/**
 * `config/database.ts` shapes and `connectDatabase()`: turns configuration into a {@link Database}
 * by loading the matching optional driver (`pg`, `@electric-sql/pglite`, `@libsql/client`).
 * Drivers are optional peer dependencies, so an app installs only the one it uses.
 *
 * Deferred (shape kept so configs written today stay valid):
 * - `auth: { kind: 'azure-entra' }` (Azure Database for PostgreSQL passwordless via
 *   `@azure/postgresql-auth`): throws a clear "not implemented yet" error.
 * - `driver: 'mysql'`: throws likewise.
 *
 * @module
 */
import {
  type LibsqlLike,
  libsqlDatabase,
  type PgliteLike,
  type PgPoolLike,
  pgDatabase,
  pgliteDatabase,
} from './drivers.ts'
import type { Database } from './types.ts'

/** Postgres authentication. */
export type PostgresAuth =
  | { readonly kind: 'password' }
  /** Entra ID token as password, refreshed per connection (deferred to a later release). */
  | { readonly kind: 'azure-entra'; readonly clientId?: string; readonly scope?: string }

/** Database configuration. */
export type DatabaseConfig =
  | {
      readonly driver: 'postgres'
      /** `postgres://user:pass@host:5432/db` (or use the discrete fields). */
      readonly url?: string
      readonly host?: string
      readonly port?: number
      readonly database?: string
      readonly user?: string
      readonly password?: string
      /** `true` = verify certificates (recommended); never disable verification in production. */
      readonly ssl?: boolean | { readonly rejectUnauthorized: boolean; readonly ca?: string }
      readonly pool?: {
        readonly max?: number
        readonly idleTimeoutMs?: number
        /**
         * Postgres `statement_timeout` per connection, in milliseconds. Default
         * {@link DEFAULT_STATEMENT_TIMEOUT_MS} (5 s); `0` disables the limit (not recommended
         * for a public API). Long-running jobs should use their own connection settings.
         */
        readonly statementTimeoutMs?: number
        /**
         * How long a query waits for a pooled connection, including opening a new one, in
         * milliseconds. Default {@link DEFAULT_CONNECTION_TIMEOUT_MS}. Bounds the wait when the
         * pool is exhausted or the server is unreachable, instead of queueing forever.
         */
        readonly connectionTimeoutMs?: number
        /**
         * Client-side limit per query, in milliseconds: the backstop when the server stops
         * answering (frozen, partitioned), where `statement_timeout` cannot fire. Default
         * `statementTimeoutMs + 2000`, or 30 s when the statement timeout is off; `0` disables it.
         */
        readonly queryTimeoutMs?: number
        /**
         * Postgres `lock_timeout` per connection, in milliseconds: how long a statement waits for
         * a lock before failing. Unset by default (the server's own default). Migrations use
         * their own connection with this set (`DB_MIGRATION_LOCK_TIMEOUT`, default 10 s).
         */
        readonly lockTimeoutMs?: number
      }
      readonly auth?: PostgresAuth
    }
  | { readonly driver: 'pglite'; readonly dataDir?: string }
  | { readonly driver: 'sqlite'; readonly url: string; readonly authToken?: string }
  | { readonly driver: 'mysql'; readonly url?: string }

/** Default Postgres `statement_timeout` (ms) for pooled connections. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000

/** Default wait (ms) for a pooled Postgres connection before the query fails. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000

/** Thrown for configured features that are designed but not implemented yet. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'
}

/** Postgres configuration (the `driver: 'postgres'` member of {@link DatabaseConfig}). */
export type PostgresConfig = Extract<DatabaseConfig, { readonly driver: 'postgres' }>

/**
 * The node-postgres `Pool` options for a config: certificate verification on when `ssl: true`,
 * and a default {@link DEFAULT_STATEMENT_TIMEOUT_MS} statement timeout.
 */
export function pgPoolOptions(config: PostgresConfig): Record<string, unknown> {
  const statementTimeout = config.pool?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
  if (!Number.isInteger(statementTimeout) || statementTimeout < 0)
    throw new RangeError('pool.statementTimeoutMs must be a non-negative integer')
  const connectionTimeout = config.pool?.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS
  if (!Number.isInteger(connectionTimeout) || connectionTimeout < 0)
    throw new RangeError('pool.connectionTimeoutMs must be a non-negative integer')
  const queryTimeout =
    config.pool?.queryTimeoutMs ?? (statementTimeout > 0 ? statementTimeout + 2_000 : 30_000)
  if (!Number.isInteger(queryTimeout) || queryTimeout < 0)
    throw new RangeError('pool.queryTimeoutMs must be a non-negative integer')
  const lockTimeout = config.pool?.lockTimeoutMs
  if (lockTimeout !== undefined && (!Number.isInteger(lockTimeout) || lockTimeout < 0))
    throw new RangeError('pool.lockTimeoutMs must be a non-negative integer')
  // Session settings sent at connect time (`-c name=value`). An explicit 0 statement timeout is
  // sent as such, so a role or database default (`ALTER ROLE … SET statement_timeout`) cannot
  // bring a limit back for a connection that must not have one (migrations).
  const settings = [
    ...(config.pool?.statementTimeoutMs === 0 ? ['statement_timeout=0'] : []),
    ...(lockTimeout !== undefined ? [`lock_timeout=${lockTimeout}`] : []),
  ]
  return {
    ...(config.url ? { connectionString: config.url } : {}),
    ...(config.host ? { host: config.host } : {}),
    ...(config.port ? { port: config.port } : {}),
    ...(config.database ? { database: config.database } : {}),
    ...(config.user ? { user: config.user } : {}),
    ...(config.password ? { password: config.password } : {}),
    ...(config.ssl !== undefined
      ? { ssl: config.ssl === true ? { rejectUnauthorized: true } : config.ssl }
      : {}),
    max: config.pool?.max ?? 10,
    idleTimeoutMillis: config.pool?.idleTimeoutMs ?? 30_000,
    // A default cap on every statement: one expensive query (a deep page, a count over a huge
    // table) must not hold a connection forever. `0` disables it explicitly.
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
    // Client-side bounds (node-postgres has none by default): a pool with every connection taken,
    // an unreachable host, or a server that stops answering mid-query would otherwise hold the
    // request, and its connection, forever. `0` means no limit in node-postgres too.
    connectionTimeoutMillis: connectionTimeout,
    ...(queryTimeout > 0 ? { query_timeout: queryTimeout } : {}),
    ...(settings.length > 0 ? { options: settings.map((s) => `-c ${s}`).join(' ') } : {}),
  }
}

/** Open a database from configuration. */
export async function connectDatabase(config: DatabaseConfig): Promise<Database> {
  switch (config.driver) {
    case 'pglite': {
      const { PGlite } = await import('@electric-sql/pglite')
      const client = config.dataDir ? await PGlite.create(config.dataDir) : await PGlite.create()
      return pgliteDatabase(client as unknown as PgliteLike)
    }
    case 'sqlite': {
      const { createClient } = await import('@libsql/client')
      // intMode 'bigint': 64-bit integers are never rounded; the repository converts them.
      const client = createClient({
        url: config.url,
        intMode: 'bigint',
        ...(config.authToken ? { authToken: config.authToken } : {}),
      })
      if (config.url.startsWith('file:') || config.url === ':memory:')
        await client.execute('PRAGMA foreign_keys = ON')
      return libsqlDatabase(client as unknown as LibsqlLike)
    }
    case 'postgres': {
      if (config.auth?.kind === 'azure-entra') {
        throw new NotImplementedError(
          'Azure Entra ID (passwordless) authentication for Postgres is not implemented yet; use auth: { kind: "password" }.',
        )
      }
      const pg = await import('pg')
      const Pool = (pg.default ?? pg).Pool
      const pool = new Pool(pgPoolOptions(config))
      // An idle client erroring must not crash the process (ADR-0007 rule 5); the pool drops it.
      pool.on('error', () => undefined)
      return pgDatabase(pool as unknown as PgPoolLike)
    }
    case 'mysql':
      throw new NotImplementedError(
        'MySQL support is planned (ADR-0004 tier 2) but not implemented yet.',
      )
  }
}
