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
        readonly statementTimeoutMs?: number
      }
      readonly auth?: PostgresAuth
    }
  | { readonly driver: 'pglite'; readonly dataDir?: string }
  | { readonly driver: 'sqlite'; readonly url: string; readonly authToken?: string }
  | { readonly driver: 'mysql'; readonly url?: string }

/** Thrown for configured features that are designed but not implemented yet. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'
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
      const pool = new Pool({
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
        ...(config.pool?.statementTimeoutMs
          ? { statement_timeout: config.pool.statementTimeoutMs }
          : {}),
      })
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
