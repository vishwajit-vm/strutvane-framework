/**
 * The engines the v2 migrator suites run on: SQLite (node:sqlite) and PGlite in process, plus
 * MySQL 8.4, MariaDB 11.4 and PostgreSQL 18 as throwaway servers (test/helpers/db-servers.ts).
 * Every `open()` gives a fresh, empty database; `close()` drops it.
 */
import { PGlite } from '@electric-sql/pglite'
import { Connection } from '../../../src/database/db/connection.ts'
import { connectMysqlFamily, mysqlDriver } from '../../../src/database/db/mysql-driver.ts'
import { pgDriver } from '../../../src/database/db/pg-driver.ts'
import { pgliteDriver } from '../../../src/database/db/pglite-driver.ts'
import { sqliteDriver } from '../../../src/database/db/sqlite-driver.ts'
import { SqlFragment } from '../../../src/database/sql/fragment.ts'
import { serverDatabase, skipReason } from '../../helpers/server-database.ts'

/** An open test database. */
export interface OpenDatabase {
  readonly connection: Connection
  /** A second connection to the same database (servers only), for lock contention tests. */
  readonly second: (() => Connection) | undefined
  close(): Promise<void>
}

/** One engine under test. */
export interface Engine {
  readonly name: 'sqlite' | 'pglite' | 'postgres' | 'mysql' | 'mariadb'
  readonly server: boolean
  readonly skipped: string | undefined
  open(): Promise<OpenDatabase>
}

async function onServer(
  engine: 'mysql' | 'mariadb' | 'postgres',
  connect: (url: string) => Promise<Connection>,
): Promise<OpenDatabase> {
  const db = await serverDatabase(engine)
  const extra: Connection[] = []
  const connection = await connect(db.url)
  return {
    connection,
    second: () => {
      const created =
        engine === 'postgres'
          ? new Connection(pgDriver({ connectionString: db.url }))
          : new Connection(
              mysqlDriver({ uri: db.url }, { dialect: engine === 'mariadb' ? 'mariadb' : 'mysql' }),
            )
      extra.push(created)
      return created
    },
    async close() {
      await Promise.all([connection, ...extra].map((c) => c.close()))
      await db.drop()
    },
  }
}

/** Every engine, the in-process ones first. */
export const ENGINES: readonly Engine[] = [
  {
    name: 'sqlite',
    server: false,
    skipped: undefined,
    open: async () => {
      const connection = new Connection(sqliteDriver(':memory:'))
      return { connection, second: undefined, close: () => connection.close() }
    },
  },
  {
    name: 'pglite',
    server: false,
    skipped: undefined,
    open: async () => {
      const connection = new Connection(pgliteDriver(await PGlite.create()))
      return { connection, second: undefined, close: () => connection.close() }
    },
  },
  {
    name: 'postgres',
    server: true,
    skipped: skipReason('postgres'),
    open: () =>
      onServer('postgres', async (url) => new Connection(pgDriver({ connectionString: url }))),
  },
  {
    name: 'mysql',
    server: true,
    skipped: skipReason('mysql'),
    open: () => onServer('mysql', async (url) => new Connection(mysqlDriver({ uri: url }))),
  },
  {
    name: 'mariadb',
    server: true,
    skipped: skipReason('mariadb'),
    open: () =>
      onServer('mariadb', async (url) => new Connection(await connectMysqlFamily({ uri: url }))),
  },
]

/** The describe title, with the skip reason when there is one. */
export function engineTitle(engine: Engine): string {
  return engine.skipped === undefined ? engine.name : `${engine.name} (skipped: ${engine.skipped})`
}

/** Is the engine MySQL or MariaDB? */
export function isMysql(connection: Connection): boolean {
  const dialect = connection.grammar.dialect
  return dialect === 'mysql' || dialect === 'mariadb'
}

/**
 * Run hand-written test SQL. Written with "double quotes" for identifiers; turned into backticks
 * on MySQL/MariaDB (whose pinned sql_mode has no ANSI_QUOTES).
 */
export async function query(
  connection: Connection,
  text: string,
): Promise<Record<string, unknown>[]> {
  const statement = isMysql(connection) ? text.replaceAll('"', '`') : text
  const { rows } = await connection.run(SqlFragment.trusted([{ kind: 'text', text: statement }]))
  return rows.map((row) => ({ ...row }))
}

/** `COUNT(*)` as a number on every engine (some drivers return int8 as text). */
export async function count(connection: Connection, table: string): Promise<number> {
  const [row] = await query(connection, `SELECT COUNT(*) AS "n" FROM "${table}"`)
  return Number(row?.['n'])
}
