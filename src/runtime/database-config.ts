/**
 * Map an app's `config/database.ts` onto a {@link DatabaseConfig}.
 *
 * Two shapes are accepted:
 * - the generated one: `{ default: 'sqlite', connection: { filename } }` or
 *   `{ default: 'postgres', connection: { url } }` (what `create-strutvane` writes);
 * - a framework {@link DatabaseConfig} under `connection` (`{ connection: { driver: 'pglite' } }`).
 *
 * Relative SQLite files resolve against the project root, so `node strut migrate` and `node strut dev` open the
 * same file whatever the working directory.
 *
 * @module
 */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DatabaseConfig } from '../database/connect.ts'

/** The database section of the app config, as far as the runtime reads it. */
export interface AppDatabaseConfig {
  readonly default?: string
  readonly connection?: Readonly<Record<string, unknown>>
  readonly migrations?: { readonly directory?: string; readonly table?: string }
  readonly seeders?: { readonly directory?: string }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Resolve the connection config. Throws a descriptive error for anything unusable. */
export function databaseConfigFrom(
  raw: AppDatabaseConfig | undefined,
  root: string,
): DatabaseConfig {
  const connection = raw?.connection ?? {}
  if (typeof connection['driver'] === 'string') return connection as unknown as DatabaseConfig
  const driver = raw?.default ?? 'sqlite'
  switch (driver) {
    case 'sqlite': {
      const url = str(connection['url'])
      if (url) return { driver: 'sqlite', url }
      const file = str(connection['filename']) ?? 'storage/database.sqlite'
      if (file === ':memory:') return { driver: 'sqlite', url: ':memory:' }
      const path = isAbsolute(file) ? file : resolve(root, file)
      return { driver: 'sqlite', url: pathToFileURL(path).href }
    }
    case 'pglite': {
      const dataDir = str(connection['dataDir']) ?? str(connection['filename'])
      return dataDir
        ? { driver: 'pglite', dataDir: isAbsolute(dataDir) ? dataDir : resolve(root, dataDir) }
        : { driver: 'pglite' }
    }
    case 'postgres':
    case 'azure-postgres':
      return postgresConfig(connection, driver === 'azure-postgres')
    case 'mysql':
    case 'azure-mysql': {
      const url = str(connection['url'])
      return url ? { driver: 'mysql', url } : { driver: 'mysql' }
    }
    default:
      throw new Error(`config/database.ts: unknown database "${driver}"`)
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v !== ''
      ? Number(v)
      : undefined

/** Postgres from a URL or the discrete fields create-strutvane writes (host, port, user, …). */
function postgresConfig(c: Readonly<Record<string, unknown>>, azure: boolean): DatabaseConfig {
  const url = str(c['url'])
  const auth = c['auth'] as { type?: string; password?: unknown; clientId?: unknown } | undefined
  const entra = azure && auth?.type === 'entra'
  const password = str(auth?.password) ?? str(c['password'])
  const port = num(c['port'])
  const max = num((c['pool'] as { max?: unknown } | undefined)?.max)
  const ssl = c['ssl']
  if (!url && !str(c['host']))
    throw new Error('config/database.ts: postgres needs connection.url or connection.host')
  return {
    driver: 'postgres',
    ...(url ? { url } : {}),
    ...(str(c['host']) ? { host: str(c['host']) as string } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(str(c['database']) ? { database: str(c['database']) as string } : {}),
    ...(str(c['user']) ? { user: str(c['user']) as string } : {}),
    ...(password && !entra ? { password } : {}),
    ...(typeof ssl === 'boolean' || (typeof ssl === 'object' && ssl !== null)
      ? { ssl: ssl as boolean | { rejectUnauthorized: boolean } }
      : {}),
    ...(max !== undefined ? { pool: { max } } : {}),
    ...(entra
      ? {
          auth: {
            kind: 'azure-entra' as const,
            ...(str(auth?.clientId) ? { clientId: str(auth?.clientId) as string } : {}),
          },
        }
      : {}),
  }
}
