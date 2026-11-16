/**
 * MySQL 8.4+ through mysql2 (the default engine for new Strutvane apps).
 *
 * The pool settings are the part that matters; each one prevents a real bug:
 * - `timezone: 'Z'`: DATETIME has no zone, so both directions are UTC. Without it mysql2 uses the
 *   Node process' local zone and every timestamp shifts by the server's offset.
 * - `dateStrings: ['DATE']`: a DATE stays `'2026-11-14'`; as a JS Date it would become local
 *   midnight and could show the previous day.
 * - `supportBigNumbers`: BIGINT values beyond 2^53 come back as strings instead of rounded numbers
 *   (the ORM then refuses them loudly instead of corrupting ids).
 * - `decimalNumbers: false` (the default): DECIMAL stays an exact string, like on PostgreSQL.
 * - Statements go through `execute()`: real server-side prepared statements, cached per
 *   connection by mysql2, so values never touch the SQL text.
 * - A connection that fails mid-transaction is destroyed, never returned to the pool.
 * - Every new connection pins its session (security review F-08): a strict `sql_mode` (bad
 *   values are errors, not silently truncated or zeroed), UTC, and utf8mb4. Servers configured
 *   loosely (Laravel's usual setup, managed defaults) can't weaken the app's guarantees.
 * - `jsonStrings`: JSON columns arrive as text and the ORM parses them once. mysql2 would parse
 *   MySQL's JSON type and MariaDB 11's JSON alias itself, but MariaDB 10.4's JSON is a plain
 *   LONGTEXT; asking for text always makes every server behave the same.
 *
 * MariaDB (`DB_CONNECTION=mariadb`, what XAMPP ships) uses the same driver with its own dialect:
 * pass `{ dialect: 'mariadb' }`, or let {@link connectMysqlFamily} detect it from `VERSION()`.
 */
import { createConnection, createPool, type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise'
import type { Driver, DriverSession, QueryResult, Row } from './driver.ts'

/**
 * Which server of the MySQL family is on the other end, and what it supports.
 *
 * @example
 * const server: MysqlServer = { dialect: 'mariadb', insertReturning: true }
 */
export interface MysqlServer {
  readonly dialect: 'mysql' | 'mariadb'
  /** `INSERT … RETURNING` (MariaDB 10.5+). Undefined means "the dialect's default". */
  readonly insertReturning?: boolean
}

/**
 * The version-detection hook: read a `VERSION()` string and say which dialect it is.
 *
 * MariaDB reports `11.4.13-MariaDB-ubu2404`; old MariaDB handshakes prefix `5.5.5-` to keep old
 * MySQL clients happy (`5.5.5-10.4.32-MariaDB`). `INSERT … RETURNING` exists from MariaDB 10.5.
 *
 * @example
 * detectMysqlServer('8.4.13') // { dialect: 'mysql' }
 * detectMysqlServer('10.4.32-MariaDB') // { dialect: 'mariadb', insertReturning: false }
 */
export function detectMysqlServer(version: string): MysqlServer {
  if (!/mariadb/i.test(version)) return { dialect: 'mysql' }
  const match = /(?:^5\.5\.5-)?(\d+)\.(\d+)/.exec(version)
  const major = Number(match?.[1] ?? 0)
  const minor = Number(match?.[2] ?? 0)
  return { dialect: 'mariadb', insertReturning: major > 10 || (major === 10 && minor >= 5) }
}

/**
 * Connect to a MySQL-family server and pick the dialect from its version (one extra round trip at
 * boot). Use it when `DB_CONNECTION` doesn't say, or to check that it says the truth.
 *
 * @example
 * const driver = await connectMysqlFamily({ uri: process.env.DATABASE_URL })
 */
export async function connectMysqlFamily(options: PoolOptions): Promise<Driver> {
  const probe = await createConnection(options)
  try {
    const [rows] = await probe.query('SELECT VERSION() AS version')
    const first = Array.isArray(rows) ? rows[0] : undefined
    const version = isRow(first) ? String(first['version']) : ''
    return mysqlDriver(options, detectMysqlServer(version))
  } finally {
    await probe.end()
  }
}

/**
 * Connect to MySQL (or MariaDB) with a connection URL or mysql2 options (merged over the safe
 * defaults).
 *
 * @example
 * const driver = mysqlDriver({ uri: 'mysql://app:secret@127.0.0.1:3306/app' })
 * const maria = mysqlDriver({ uri }, { dialect: 'mariadb' })
 */
export function mysqlDriver(options: PoolOptions, server: MysqlServer = { dialect: 'mysql' }): Driver {
  const pool: Pool = createPool({
    connectionLimit: 10,
    ...options,
    timezone: 'Z',
    dateStrings: ['DATE'],
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,
    jsonStrings: true,
  })
  let closed = false
  const settings = sessionSettings(server.dialect)
  // mysql2 runs commands on one connection in order, so this SET always precedes the first query.
  // A failing SET is fatal for that connection (checked): it never serves queries unpinned.
  pool.pool.on('connection', (connection) => {
    connection.query(settings)
  })

  return {
    dialect: server.dialect,
    ...(server.insertReturning === undefined ? {} : { insertReturning: server.insertReturning }),
    async acquire(): Promise<DriverSession> {
      if (closed) throw new Error('This MySQL pool is closed. Create a new connection instead of reusing a closed one.')
      const connection = await pool.getConnection()
      let released = false
      return {
        run: (sql, params) => runOn(connection, sql, params),
        release(broken = false) {
          if (released) return
          released = true
          if (broken) connection.destroy()
          else connection.release()
        },
      }
    },
    async close() {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}

/**
 * The session every connection runs with. STRICT_ALL_TABLES turns truncation and bad values into
 * errors; NO_BACKSLASH_ESCAPES makes string literals standard SQL (the ORM never writes literals,
 * but raw SQL and the migration DDL do). The connection collation is binary: MySQL's
 * `utf8mb4_0900_bin`, MariaDB's `utf8mb4_nopad_bin` (MariaDB only accepts the 0900 names from 11.4.5,
 * and its plain `utf8mb4_bin` is PAD SPACE: `'resume ' = 'resume'` is true there, checked on 11.4.13).
 *
 * @example
 * sessionSettings('mariadb') // "SET SESSION sql_mode = '…', time_zone = '+00:00', NAMES utf8mb4 COLLATE utf8mb4_nopad_bin"
 */
export function sessionSettings(dialect: 'mysql' | 'mariadb'): string {
  return (
    "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY,NO_BACKSLASH_ESCAPES', " +
    `time_zone = '+00:00', NAMES utf8mb4 COLLATE ${dialect === 'mariadb' ? 'utf8mb4_nopad_bin' : 'utf8mb4_0900_bin'}`
  )
}

async function runOn(connection: PoolConnection, sql: string, params: readonly unknown[]): Promise<QueryResult> {
  // Transaction control (BEGIN, SAVEPOINT …) can't be prepared in MySQL's binary protocol.
  if (params.length === 0 && /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) {
    await connection.query(sql)
    return { rows: [], rowsAffected: 0 }
  }
  const [result] = await connection.execute(sql, params.map(toMysqlValue))
  if (Array.isArray(result)) {
    const rows: Row[] = []
    for (const item of result) if (isRow(item)) rows.push(item)
    return { rows, rowsAffected: rows.length }
  }
  if ('affectedRows' in result) {
    return { rows: [], rowsAffected: result.affectedRows, ...(result.insertId > 0 ? { insertId: result.insertId } : {}) }
  }
  return { rows: [], rowsAffected: 0 }
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type MysqlValue = null | number | bigint | string | Buffer

/** MySQL has no boolean type (BOOLEAN is TINYINT(1)), so booleans are sent as 0/1. */
function toMysqlValue(raw: unknown): MysqlValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'string' || Buffer.isBuffer(raw)) return raw
  throw new TypeError(`MySQL can't take a value of type ${typeof raw} as a parameter. Convert it to a string, number or JSON first.`)
}
