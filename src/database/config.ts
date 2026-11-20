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
 * An extra connection (`config/database.ts` → `connections`, CONSISTENCY #132) reads the same keys
 * with its own prefix (`DB_REPORTS_HOST`, …) and names its engine with `DB_REPORTS_DRIVER`; see
 * {@link DatabaseKeys} and `foundation/database-connections.ts`.
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
import type { Driver } from './db/driver.ts'
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
  /** The key prefix the settings were read with (`DB_`, `DB_REPORTS_`): messages name its keys. */
  readonly prefix?: string
  /** The server is on this machine (a loopback host or a socket), so plaintext is acceptable. */
  readonly local?: boolean
  /** `DB_UNSAFE_NO_TLS=true`: plaintext to a remote server in production, accepted explicitly. */
  readonly unsafeNoTls?: boolean
  /**
   * `DB_UNSAFE_PRIVILEGED_ROLE=true`: a PostgreSQL runtime role that is a superuser, has
   * `BYPASSRLS` or owns tenant tables, accepted explicitly in production.
   */
  readonly unsafePrivilegedRole?: boolean
  /** The owner credentials for migrations and seeders (`DB_MIGRATION_*`), when set. */
  readonly migration?: DatabaseMigrationCredentials
}

/**
 * The credentials `node strut migrate`, `migrate:*` and `db:seed` connect with, so the tables are
 * owned by a role the app never uses at runtime (ADR-0007 rule 4: the runtime role owns nothing).
 *
 * @example
 * const owner: DatabaseMigrationCredentials = { username: 'blog_owner', password: '…' }
 */
export interface DatabaseMigrationCredentials {
  /** `DB_MIGRATION_URL`: wins over the two keys below (it holds the password). */
  readonly url?: string
  readonly username?: string
  readonly password?: string
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

/**
 * The engine a driver name means (`postgres` → `pgsql`), or `undefined` for a name that is not an
 * engine. An extra connection called `mysql`, `pgsql` or `sqlite` uses that engine by default.
 *
 * @example
 * databaseEngineOf('postgres') // 'pgsql'
 * databaseEngineOf('reports') // undefined
 */
export function databaseEngineOf(name: string): DatabaseConnectionName | undefined {
  return Object.hasOwn(CONNECTIONS, name.toLowerCase())
    ? CONNECTIONS[name.toLowerCase()]
    : undefined
}

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
 * Which keys {@link databaseSettings} reads. The default connection reads `DB_*`; an extra
 * connection (`config/database.ts` → `connections.reports`) reads `DB_REPORTS_*`, so every problem
 * names the key the developer has to fix.
 *
 * @example
 * const keys: DatabaseKeys = { prefix: 'DB_REPORTS_', driverKey: 'DB_REPORTS_DRIVER' }
 */
export interface DatabaseKeys {
  /** Prepended to `URL`, `HOST`, `PORT`, … Default `DB_`. */
  readonly prefix?: string
  /** The key that names the engine. Default `DB_CONNECTION`. */
  readonly driverKey?: string
  /**
   * `APP_ENV`, which decides the TLS rules for a remote server. Default: the environment's
   * `APP_ENV`, else `production` (an unknown environment gets the strict rules).
   */
  readonly environment?: string
}

/** Hosts that are this machine: plaintext never leaves it. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|0:0:0:0:0:0:0:1)$/i

/**
 * Is `host` this machine (`localhost`, `127.x.x.x`, `::1`)? A Docker service name such as `db`
 * is not: it is reached over a network.
 *
 * @example
 * isLoopbackHost('127.0.0.1') // true
 * isLoopbackHost('db.internal') // false
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim())
}

/** MySQL's `ssl-mode` names → libpq's. */
const MYSQL_SSL_MODES: Readonly<Record<string, DatabaseSslMode>> = {
  disabled: 'disable',
  preferred: 'prefer',
  required: 'require',
  verify_ca: 'verify-ca',
  verify_identity: 'verify-full',
}

/**
 * Take the TLS settings out of a connection URL. node-postgres and mysql2 would apply a URL's own
 * `sslmode`/`ssl` *over* the TLS options the framework sets, so a URL could quietly turn TLS off;
 * here they become the connection's mode instead (checked by the same rules as `DB_SSLMODE`), and
 * the URL handed to the driver carries none. Other `ssl*` parameters (certificate files) are
 * refused: `DB_SSL_CA` is the one supported way.
 */
function splitUrlTls(
  url: string,
  key: string,
  problems: EnvProblem[],
): { readonly url: string; readonly mode?: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { url }
  }
  let mode: string | undefined
  for (const name of [...parsed.searchParams.keys()]) {
    const lower = name.toLowerCase()
    if (!lower.startsWith('ssl')) continue
    const raw = (parsed.searchParams.get(name) ?? '').toLowerCase()
    if (lower === 'sslmode') mode = raw
    else if (lower === 'ssl-mode') mode = MYSQL_SSL_MODES[raw] ?? raw
    else if (lower === 'ssl')
      mode =
        raw === 'true' || raw === '1' ? 'require' : raw === 'false' || raw === '0' ? 'disable' : raw
    else
      problems.push({
        key,
        message: `has a "${name}" parameter; set the TLS mode with ${key.replace(/URL$/, 'SSLMODE')} and the CA file with ${key.replace(/URL$/, 'SSL_CA')} instead`,
      })
    parsed.searchParams.delete(name)
  }
  return { url: parsed.toString(), ...(mode !== undefined ? { mode } : {}) }
}

/** `true`/`1` → true, empty → false, anything else is a problem (a typo must not count as yes). */
function flag(env: EnvSource, key: string, problems: EnvProblem[]): boolean {
  const raw = value(env, key)?.toLowerCase()
  if (raw === undefined || raw === 'false' || raw === '0') return false
  if (raw === 'true' || raw === '1') return true
  problems.push({ key, message: 'must be true or false' })
  return false
}

/**
 * Read the `DB_*` keys (or another connection's prefixed keys, see {@link DatabaseKeys}). Throws
 * an `EnvValidationError` listing every problem, without echoing secret values.
 *
 * **TLS** (`DB_SSLMODE`, or the URL's own `sslmode`): a server on this machine (loopback host or
 * socket) may use any mode. A remote server in production defaults to `verify-full`, and
 * `disable`/`prefer` are refused unless `DB_UNSAFE_NO_TLS=true` says so explicitly: Node drivers
 * can't fall back from TLS, so `prefer` would mean plaintext. Outside production, `prefer` to a
 * remote server means `require` (encrypted).
 *
 * **Migrations** connect with `DB_MIGRATION_URL`, or `DB_MIGRATION_USERNAME` and
 * `DB_MIGRATION_PASSWORD`, when set (see {@link migrationSettings}).
 *
 * @example
 * databaseSettings({ DB_CONNECTION: 'pgsql', DB_DATABASE: 'app' }, '/srv/app').port // 5432
 * databaseSettings({ DB_REPORTS_DRIVER: 'sqlite', DB_REPORTS_DATABASE: 'r.sqlite' }, root, {
 *   prefix: 'DB_REPORTS_', driverKey: 'DB_REPORTS_DRIVER',
 * }).filename // '<root>/r.sqlite'
 */
export function databaseSettings(
  env: EnvSource,
  root: string,
  keys: DatabaseKeys = {},
): DatabaseSettings {
  const prefix = keys.prefix ?? 'DB_'
  const driverKey = keys.driverKey ?? 'DB_CONNECTION'
  const environment = (keys.environment ?? value(env, 'APP_ENV') ?? 'production').toLowerCase()
  const key = (name: string): string => `${prefix}${name}`
  const problems: EnvProblem[] = []
  const rawUrl = value(env, key('URL'))
  // Without a driver key, a URL says which engine it is.
  const name = (value(env, driverKey) ?? schemeOf(rawUrl) ?? 'mysql').toLowerCase()
  let connection = CONNECTIONS[name]
  if (connection === undefined) {
    problems.push({
      key: driverKey,
      message: `must be mysql, mariadb, pgsql (or postgres) or sqlite, not "${name}"`,
    })
    connection = 'mysql'
  }
  const checkUrl = (urlKey: string, url: string | undefined): void => {
    if (url === undefined || connection === 'sqlite') return
    let scheme: string | undefined
    try {
      scheme = new URL(url).protocol
    } catch {
      problems.push({
        key: urlKey,
        message: 'is not a valid URL (e.g. mysql://user:pass@host:3306/app)',
      })
    }
    const family = scheme === undefined ? undefined : URL_SCHEMES[scheme]
    if (scheme !== undefined && family === undefined)
      problems.push({
        key: urlKey,
        message: 'must start with mysql://, mariadb://, postgres:// or postgresql://',
      })
    else if (family !== undefined && (family === 'pgsql') !== (connection === 'pgsql'))
      problems.push({
        key: urlKey,
        message: `is a ${family === 'pgsql' ? 'PostgreSQL' : 'MySQL/MariaDB'} URL but ${driverKey} is ${name}`,
      })
  }
  checkUrl(key('URL'), rawUrl)
  const split =
    rawUrl === undefined || connection === 'sqlite'
      ? undefined
      : splitUrlTls(rawUrl, key('URL'), problems)
  const url = split?.url
  const portText = value(env, key('PORT'))
  const port = portText === undefined ? DEFAULT_PORT[connection] : Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    problems.push({ key: key('PORT'), message: 'must be a port number from 1 to 65535' })
  const sslModeText = (value(env, key('SSLMODE')) ?? split?.mode)?.toLowerCase()
  if (sslModeText !== undefined && !SSL_MODES.has(sslModeText))
    problems.push({
      key: key('SSLMODE'),
      message: 'must be disable, prefer, require, verify-ca or verify-full',
    })
  const caPath = value(env, key('SSL_CA'))
  let sslCa: string | undefined
  if (caPath !== undefined) {
    try {
      sslCa = readFileSync(isAbsolute(caPath) ? caPath : resolve(root, caPath), 'utf8')
    } catch {
      problems.push({
        key: key('SSL_CA'),
        message: `cannot read the CA certificate file ${caPath}`,
      })
    }
  }
  const unsafeNoTls = flag(env, key('UNSAFE_NO_TLS'), problems)
  const unsafePrivilegedRole = flag(env, key('UNSAFE_PRIVILEGED_ROLE'), problems)

  const socket = value(env, key('SOCKET'))
  const host = value(env, key('HOST')) ?? '127.0.0.1'
  const urlHost = url === undefined ? undefined : hostOf(url)
  const local =
    connection === 'sqlite' ||
    (url === undefined ? socket !== undefined || isLoopbackHost(host) : isLocalUrlHost(urlHost))
  const sslMode = tlsMode(sslModeText as DatabaseSslMode | undefined, {
    local,
    production: environment === 'production',
    unsafeNoTls,
    where: url === undefined ? (socket ?? host) : (urlHost ?? 'the URL host'),
    key: key('SSLMODE'),
    unsafeKey: key('UNSAFE_NO_TLS'),
    problems,
  })

  const migrationUrl = value(env, key('MIGRATION_URL'))
  checkUrl(key('MIGRATION_URL'), migrationUrl)
  const migrationSplit =
    migrationUrl === undefined || connection === 'sqlite'
      ? undefined
      : splitUrlTls(migrationUrl, key('MIGRATION_URL'), problems)
  const migrationUser = value(env, key('MIGRATION_USERNAME'))
  const migrationPassword = env[key('MIGRATION_PASSWORD')]
  if (problems.length > 0) throw new EnvValidationError(problems)

  const database = value(env, key('DATABASE'))
  const password = env[key('PASSWORD')]
  const migration: DatabaseMigrationCredentials | undefined =
    migrationSplit !== undefined
      ? { url: migrationSplit.url }
      : migrationUser !== undefined
        ? {
            username: migrationUser,
            ...(migrationPassword !== undefined && migrationPassword !== ''
              ? { password: migrationPassword }
              : {}),
          }
        : undefined
  const base = {
    connection,
    host,
    port,
    database: database ?? (connection === 'sqlite' ? DEFAULT_SQLITE_FILE : 'strutvane'),
    username: value(env, key('USERNAME')) ?? (connection === 'pgsql' ? 'postgres' : 'root'),
    prefix,
    local,
    ...(password !== undefined && password !== '' ? { password } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(socket !== undefined ? { socket } : {}),
    ...(sslMode !== undefined ? { sslMode } : {}),
    ...(sslCa !== undefined ? { sslCa } : {}),
    ...(unsafeNoTls ? { unsafeNoTls } : {}),
    ...(unsafePrivilegedRole ? { unsafePrivilegedRole } : {}),
    ...(migration !== undefined && connection !== 'sqlite' ? { migration } : {}),
  }
  if (connection !== 'sqlite') return base
  const file = database ?? DEFAULT_SQLITE_FILE
  return { ...base, filename: file === ':memory:' || isAbsolute(file) ? file : resolve(root, file) }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** A URL without a host connects through the default socket (this machine). */
function isLocalUrlHost(host: string | undefined): boolean {
  return host === undefined || host === '' || isLoopbackHost(host)
}

/** The TLS mode a connection really uses, after the rules in {@link databaseSettings}. */
function tlsMode(
  mode: DatabaseSslMode | undefined,
  context: {
    readonly local: boolean
    readonly production: boolean
    readonly unsafeNoTls: boolean
    readonly where: string
    readonly key: string
    readonly unsafeKey: string
    readonly problems: EnvProblem[]
  },
): DatabaseSslMode | undefined {
  if (context.local) return mode
  if (context.production) {
    if (mode === undefined) return 'verify-full'
    if ((mode === 'disable' || mode === 'prefer') && !context.unsafeNoTls)
      context.problems.push({
        key: context.key,
        message: `is ${mode} for ${context.where}, a server on another machine, in production: the connection (and its password) would travel unencrypted. Use verify-full (with the CA file for a private CA), or set ${context.unsafeKey}=true to accept plaintext`,
      })
    return mode
  }
  // Node drivers can't fall back from TLS to plaintext: "prefer" to another machine means TLS.
  return mode === 'prefer' ? 'require' : mode
}

/**
 * The settings migrations and seeders connect with: the `DB_MIGRATION_*` owner credentials over
 * the runtime ones (a migration URL wins; a username replaces the user in `DB_URL` too), or the
 * settings unchanged when none are set.
 *
 * @example
 * await openDatabase(migrationSettings(settings), { forMigrations: { lockTimeoutMs: 10_000 } })
 */
export function migrationSettings(settings: DatabaseSettings): DatabaseSettings {
  const { migration, ...runtime } = settings
  if (migration === undefined) return runtime
  if (migration.url !== undefined) return { ...runtime, url: migration.url }
  const username = migration.username ?? runtime.username
  const { password: _password, ...withoutPassword } = runtime
  const owner = {
    ...withoutPassword,
    username,
    ...(migration.password !== undefined ? { password: migration.password } : {}),
  }
  if (runtime.url === undefined) return owner
  const url = new URL(runtime.url)
  url.username = encodeURIComponent(username)
  url.password = migration.password === undefined ? '' : encodeURIComponent(migration.password)
  return { ...owner, url: url.toString() }
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

/** Options for {@link openDatabaseLazily}. */
export interface LazyDatabaseOptions {
  /** Checks on the freshly opened engine, before the first statement (see `lazyDriver`). */
  readonly afterOpen?: (driver: Driver) => Promise<void>
}

/**
 * How a connection's TLS looks, for `node strut security:check` and `doctor`: `fail` only for
 * plaintext to another machine in production (accepted with `DB_UNSAFE_NO_TLS`).
 *
 * @example
 * tlsReport(settings) // { status: 'pass', detail: 'verify-full to db.example.com' }
 */
export function tlsReport(settings: DatabaseSettings): {
  readonly status: 'pass' | 'warn' | 'fail'
  readonly detail: string
} {
  if (settings.connection === 'sqlite')
    return { status: 'pass', detail: 'SQLite file (no network)' }
  const mode = settings.sslMode ?? 'disable'
  const where =
    settings.url === undefined
      ? (settings.socket ?? settings.host)
      : (hostOf(settings.url) ?? 'the URL host')
  if (settings.local === true)
    return { status: 'pass', detail: `${mode} to ${where} (this machine)` }
  if (mode === 'verify-full' || mode === 'verify-ca')
    return { status: 'pass', detail: `${mode} to ${where}` }
  if (mode === 'require')
    return {
      status: 'warn',
      detail: `require to ${where}: encrypted, but the server certificate is not verified. Use verify-full.`,
    }
  return {
    status: settings.unsafeNoTls === true ? 'fail' : 'warn',
    detail: `${mode} to ${where}, another machine: the connection is not encrypted${settings.unsafeNoTls === true ? ` (accepted with ${settings.prefix ?? 'DB_'}UNSAFE_NO_TLS)` : ''}. Use verify-full.`,
  }
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
export function openDatabaseLazily(
  settings: DatabaseSettings,
  options: LazyDatabaseOptions = {},
): Connection {
  const afterOpen = options.afterOpen === undefined ? {} : { afterOpen: options.afterOpen }
  switch (settings.connection) {
    case 'sqlite': {
      const file = settings.filename ?? DEFAULT_SQLITE_FILE
      return new Connection(
        lazyDriver({ dialect: 'sqlite', open: async () => sqliteDriver(file), ...afterOpen }),
      )
    }
    case 'pgsql': {
      const pool = pgOptions(settings, {})
      return new Connection(
        lazyDriver({ dialect: 'postgres', open: async () => pgDriver(pool), ...afterOpen }),
      )
    }
    case 'mysql':
    case 'mariadb': {
      const pool = mysqlOptions(settings, {})
      return new Connection(
        lazyDriver({
          dialect: settings.connection,
          insertReturning: false,
          open: () => connectMysqlFamily(pool),
          ...afterOpen,
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
