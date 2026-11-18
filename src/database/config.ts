/**
 * Database settings from the environment, Laravel's way, and opening an ORM {@link Connection}.
 *
 * | Key | Meaning |
 * |---|---|
 * | `DB_CONNECTION` | `mysql` (default), `mariadb`, `pgsql` (`postgres` accepted as an alias, #14) or `sqlite` |
 * | `DB_URL` | a full URL (`mysql://…`, `mariadb://…`, `postgres://…`); wins over the discrete keys |
 * | `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | discrete settings with local-friendly defaults |
 * | `DB_SOCKET` | a Unix socket (MySQL/MariaDB socket file, or the PostgreSQL socket directory) |
 * | `DB_SSLMODE` | `disable`, `prefer`, `require`, `verify-ca` or `verify-full` (libpq's names) |
 * | `DB_SSL_CA` | path to the CA certificate that signs the server's certificate |
 *
 * For SQLite, `DB_DATABASE` is the file (default `database/database.sqlite`, #96), relative to the
 * project root, or `:memory:`.
 *
 * Every problem is reported at once, naming the key (an `EnvValidationError`: the CLI shows it as
 * a configuration error, exit 3). A MySQL-family server is identified from `VERSION()` at connect
 * time, so an XAMPP machine (MariaDB) configured as `mysql` still gets the MariaDB grammar (#43).
 *
 * @module
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { type EnvProblem, type EnvSource, EnvValidationError } from '../core/index.ts'
import { pgPoolOptions } from './connect.ts'
import { Connection } from './db/connection.ts'
import { lazyDriver } from './db/lazy-driver.ts'
import { connectMysqlFamily, type MysqlPoolOptions } from './db/mysql-driver.ts'
import { pgDriver } from './db/pg-driver.ts'
import { sqliteDriver } from './db/sqlite-driver.ts'

/** The `DB_CONNECTION` values (Laravel's names). */
export type DatabaseConnectionName = 'mysql' | 'mariadb' | 'pgsql' | 'sqlite'

/** libpq's TLS modes, used for every engine. */
export type DatabaseSslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

/**
 * Resolved database settings. Secrets (the password) are kept here only to open the connection;
 * never log this object (use {@link describeDatabase}).
 *
 * @example
 * const settings = databaseSettings(process.env, projectRoot)
 */
export interface DatabaseSettings {
  readonly connection: DatabaseConnectionName
  readonly url?: string
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly password?: string
  readonly socket?: string
  readonly sslMode?: DatabaseSslMode
  /** The CA certificate's contents (read from `DB_SSL_CA`). */
  readonly sslCa?: string
  /** SQLite only: the absolute file path, or `:memory:`. */
  readonly filename?: string
}

const CONNECTIONS: Readonly<Record<string, DatabaseConnectionName>> = {
  mysql: 'mysql',
  mariadb: 'mariadb',
  pgsql: 'pgsql',
  postgres: 'pgsql',
  postgresql: 'pgsql',
  sqlite: 'sqlite',
}
const SSL_MODES: ReadonlySet<string> = new Set([
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
])
const DEFAULT_PORT: Readonly<Record<DatabaseConnectionName, number>> = {
  mysql: 3306,
  mariadb: 3306,
  pgsql: 5432,
  sqlite: 0,
}
const URL_SCHEMES: Readonly<Record<string, DatabaseConnectionName>> = {
  'mysql:': 'mysql',
  'mariadb:': 'mariadb',
  'postgres:': 'pgsql',
  'postgresql:': 'pgsql',
}

/** The default SQLite file, relative to the project root (Laravel's). */
export const DEFAULT_SQLITE_FILE = 'database/database.sqlite'

const value = (env: EnvSource, key: string): string | undefined => {
  const raw = env[key]?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

/** The engine a URL names (`postgres://…` → pgsql), or undefined. */
function schemeOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return URL_SCHEMES[new URL(url).protocol]
  } catch {
    return undefined
  }
}

/**
 * Read the `DB_*` keys. Throws an `EnvValidationError` listing every problem, without echoing
 * secret values.
 *
 * @example
 * databaseSettings({ DB_CONNECTION: 'pgsql', DB_DATABASE: 'app' }, '/srv/app').port // 5432
 */
export function databaseSettings(env: EnvSource, root: string): DatabaseSettings {
  const problems: EnvProblem[] = []
  const url = value(env, 'DB_URL')
  // Without DB_CONNECTION, a DB_URL says which engine it is.
  const name = (value(env, 'DB_CONNECTION') ?? schemeOf(url) ?? 'mysql').toLowerCase()
  let connection = CONNECTIONS[name]
  if (connection === undefined) {
    problems.push({
      key: 'DB_CONNECTION',
      message: `must be mysql, mariadb, pgsql (or postgres) or sqlite, not "${name}"`,
    })
    connection = 'mysql'
  }
  if (url !== undefined && connection !== 'sqlite') {
    let scheme: string | undefined
    try {
      scheme = new URL(url).protocol
    } catch {
      problems.push({
        key: 'DB_URL',
        message: 'is not a valid URL (e.g. mysql://user:pass@host:3306/app)',
      })
    }
    const family = scheme === undefined ? undefined : URL_SCHEMES[scheme]
    if (scheme !== undefined && family === undefined)
      problems.push({
        key: 'DB_URL',
        message: 'must start with mysql://, mariadb://, postgres:// or postgresql://',
      })
    else if (family !== undefined && (family === 'pgsql') !== (connection === 'pgsql'))
      problems.push({
        key: 'DB_URL',
        message: `is a ${family === 'pgsql' ? 'PostgreSQL' : 'MySQL/MariaDB'} URL but DB_CONNECTION is ${name}`,
      })
  }
  const portText = value(env, 'DB_PORT')
  const port = portText === undefined ? DEFAULT_PORT[connection] : Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    problems.push({ key: 'DB_PORT', message: 'must be a port number from 1 to 65535' })
  const sslMode = value(env, 'DB_SSLMODE')?.toLowerCase()
  if (sslMode !== undefined && !SSL_MODES.has(sslMode))
    problems.push({
      key: 'DB_SSLMODE',
      message: 'must be disable, prefer, require, verify-ca or verify-full',
    })
  const caPath = value(env, 'DB_SSL_CA')
  let sslCa: string | undefined
  if (caPath !== undefined) {
    try {
      sslCa = readFileSync(isAbsolute(caPath) ? caPath : resolve(root, caPath), 'utf8')
    } catch {
      problems.push({ key: 'DB_SSL_CA', message: `cannot read the CA certificate file ${caPath}` })
    }
  }
  if (problems.length > 0) throw new EnvValidationError(problems)

  const database = value(env, 'DB_DATABASE')
  const password = env['DB_PASSWORD']
  const socket = value(env, 'DB_SOCKET')
  const base = {
    connection,
    host: value(env, 'DB_HOST') ?? '127.0.0.1',
    port,
    database: database ?? (connection === 'sqlite' ? DEFAULT_SQLITE_FILE : 'strutvane'),
    username: value(env, 'DB_USERNAME') ?? (connection === 'pgsql' ? 'postgres' : 'root'),
    ...(password !== undefined && password !== '' ? { password } : {}),
    ...(url !== undefined && connection !== 'sqlite' ? { url } : {}),
    ...(socket !== undefined ? { socket } : {}),
    ...(sslMode !== undefined ? { sslMode: sslMode as DatabaseSslMode } : {}),
    ...(sslCa !== undefined ? { sslCa } : {}),
  }
  if (connection !== 'sqlite') return base
  const file = database ?? DEFAULT_SQLITE_FILE
  return { ...base, filename: file === ':memory:' || isAbsolute(file) ? file : resolve(root, file) }
}

/**
 * The settings without secrets, for logs and `about`: engine, host, port, database, user, TLS.
 *
 * @example
 * describeDatabase(settings) // 'mysql://root@127.0.0.1:3306/app (TLS: verify-full)'
 */
export function describeDatabase(settings: DatabaseSettings): string {
  if (settings.connection === 'sqlite') return `sqlite:${settings.filename ?? DEFAULT_SQLITE_FILE}`
  if (settings.url !== undefined) {
    const url = new URL(settings.url)
    url.password = ''
    return url.toString()
  }
  const where = settings.socket ?? `${settings.host}:${settings.port}`
  const tls = settings.sslMode === undefined ? '' : ` (TLS: ${settings.sslMode})`
  return `${settings.connection}://${settings.username}@${where}/${settings.database}${tls}`
}

/** TLS options for a driver (`undefined` = no TLS). */
function tlsOptions(
  settings: DatabaseSettings,
): { readonly rejectUnauthorized: boolean; readonly ca?: string } | undefined {
  const mode = settings.sslMode
  // Node drivers can't fall back from TLS to plain text, so `prefer` connects without TLS. Use
  // `require` or `verify-full` for anything that crosses a network you don't own.
  if (mode === undefined || mode === 'disable' || mode === 'prefer') return undefined
  const ca = settings.sslCa !== undefined ? { ca: settings.sslCa } : {}
  // libpq's `require`: encrypted, certificate not verified. `verify-ca`/`verify-full`: verified
  // (Node always checks the host name too, so verify-ca behaves like verify-full).
  return { rejectUnauthorized: mode !== 'require', ...ca }
}

/** Options for {@link openDatabase}. */
export interface OpenDatabaseOptions {
  /**
   * Open the connection migrations and seeders use: one connection, no statement timeout, and a
   * PostgreSQL `lock_timeout` (`lockTimeoutMs`), so a schema change waiting behind live traffic
   * fails fast instead of queueing every request behind its own lock.
   */
  readonly forMigrations?: { readonly lockTimeoutMs: number }
}

/**
 * Open an ORM connection for the settings. MySQL-family servers are identified from their
 * version, so MariaDB gets its grammar whatever `DB_CONNECTION` says.
 *
 * @example
 * const connection = await openDatabase(databaseSettings(process.env, root))
 * useConnection(connection)
 */
export async function openDatabase(
  settings: DatabaseSettings,
  options: OpenDatabaseOptions = {},
): Promise<Connection> {
  switch (settings.connection) {
    case 'sqlite':
      return new Connection(sqliteDriver(settings.filename ?? DEFAULT_SQLITE_FILE))
    case 'pgsql':
      return new Connection(pgDriver(pgOptions(settings, options)))
    case 'mysql':
    case 'mariadb':
      return new Connection(await connectMysqlFamily(mysqlOptions(settings, options)))
  }
}

/**
 * The connection an application's models use: built without any I/O, opened by the first
 * statement (Laravel's lazy connection), so requests and commands that never query (the `/up`
 * health route, `route:list`) never need the database, and a database that is down fails only the
 * work that needs it.
 *
 * The SQL grammar is fixed before the server answers, so for the MySQL family it is the one every
 * MySQL and MariaDB version runs: without `RETURNING` (an insert reads its row back by key). That
 * keeps an XAMPP MariaDB 10.4 configured as `mysql` (#43) working; the server version is still
 * detected when the pool opens, for its session settings (collation, SQL mode).
 *
 * @example
 * const connection = openDatabaseLazily(databaseSettings(process.env, root))
 * // nothing is open yet; `await User.first()` opens it
 */
export function openDatabaseLazily(settings: DatabaseSettings): Connection {
  switch (settings.connection) {
    case 'sqlite': {
      const file = settings.filename ?? DEFAULT_SQLITE_FILE
      return new Connection(lazyDriver({ dialect: 'sqlite', open: async () => sqliteDriver(file) }))
    }
    case 'pgsql': {
      const pool = pgOptions(settings, {})
      return new Connection(lazyDriver({ dialect: 'postgres', open: async () => pgDriver(pool) }))
    }
    case 'mysql':
    case 'mariadb': {
      const pool = mysqlOptions(settings, {})
      return new Connection(
        lazyDriver({
          dialect: settings.connection,
          insertReturning: false,
          open: () => connectMysqlFamily(pool),
        }),
      )
    }
  }
}

/** The node-postgres pool options for the settings. */
function pgOptions(
  settings: DatabaseSettings,
  options: OpenDatabaseOptions,
): Record<string, unknown> {
  const tls = tlsOptions(settings)
  const migrations = options.forMigrations
  return pgPoolOptions({
    driver: 'postgres',
    ...(settings.url !== undefined
      ? { url: settings.url }
      : {
          host: settings.socket ?? settings.host,
          port: settings.port,
          database: settings.database,
          user: settings.username,
          ...(settings.password !== undefined ? { password: settings.password } : {}),
        }),
    ...(tls !== undefined ? { ssl: tls } : {}),
    ...(migrations !== undefined
      ? {
          pool: {
            max: 1,
            statementTimeoutMs: 0,
            queryTimeoutMs: 0,
            lockTimeoutMs: migrations.lockTimeoutMs,
          },
        }
      : {}),
  })
}

/** The mysql2 pool options for the settings. */
function mysqlOptions(settings: DatabaseSettings, options: OpenDatabaseOptions): MysqlPoolOptions {
  const tls = tlsOptions(settings)
  return {
    ...(settings.url !== undefined
      ? { uri: settings.url.replace(/^mariadb:/, 'mysql:') }
      : {
          ...(settings.socket !== undefined
            ? { socketPath: settings.socket }
            : { host: settings.host, port: settings.port }),
          database: settings.database,
          user: settings.username,
          ...(settings.password !== undefined ? { password: settings.password } : {}),
        }),
    ...(tls !== undefined ? { ssl: tls } : {}),
    ...(options.forMigrations !== undefined ? { connectionLimit: 1 } : {}),
  }
}
