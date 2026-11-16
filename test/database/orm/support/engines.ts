/**
 * The engines every ORM behaviour suite runs on: MySQL 8.4 (the default), MariaDB 11.4 (through
 * the version-detection hook) and PostgreSQL 18 as real servers in throwaway containers (see
 * test/helpers/db-servers.ts), plus PGlite and SQLite (node:sqlite) in process.
 *
 * `useEngine(engine)` wires a describe block: a fresh database for this file, the tables, the
 * models pointed at the connection, and every row cleared before each test.
 */
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import {
  Connection,
  connectMysqlFamily,
  mysqlDriver,
  pgDriver,
  pgliteDriver,
  registerSchema,
  sqliteDriver,
  useConnection,
} from '../../../../src/database/index.ts'
import type { Dialect } from '../../../../src/database/sql/grammar.ts'
import {
  type ServerDatabase,
  serverDatabase,
  skipReason,
} from '../../../helpers/server-database.ts'
import { snapshot } from '../fixtures/schema.ts'
import { clearTables, createTables } from './ddl.ts'

/** One engine under test. */
export interface Engine {
  readonly name: 'mysql' | 'mariadb' | 'postgres' | 'pglite' | 'sqlite'
  readonly dialect: Dialect
  /** Why the engine is skipped, if it is. */
  readonly skipped: string | undefined
  /** Open a connection to a fresh database; `cleanup` drops it. */
  connect(): Promise<{ connection: Connection; cleanup: () => Promise<void> }>
  /** A second, independent connection to the database the last `connect()` created. */
  connectAgain(): Promise<Connection>
}

const none = async (): Promise<void> => undefined

/** The database each server engine's last `connect()` created (one per test file). */
const current = new Map<string, ServerDatabase>()

async function again(
  engine: 'mysql' | 'mariadb' | 'postgres',
  open: (db: ServerDatabase) => Promise<Connection>,
): Promise<Connection> {
  const db = current.get(engine)
  if (db === undefined) throw new Error(`No ${engine} database is open yet.`)
  return open(db)
}

async function onServer(
  engine: 'mysql' | 'mariadb' | 'postgres',
  open: (db: ServerDatabase) => Promise<Connection>,
): Promise<{ connection: Connection; cleanup: () => Promise<void> }> {
  const db = await serverDatabase(engine)
  current.set(engine, db)
  try {
    return { connection: await open(db), cleanup: () => db.drop() }
  } catch (error) {
    await db.drop()
    throw error
  }
}

const openMysql = async (db: ServerDatabase): Promise<Connection> =>
  new Connection(mysqlDriver({ uri: db.url }))
// DB_CONNECTION may say "mysql" on an XAMPP machine: the version decides the dialect.
const openMariadb = async (db: ServerDatabase): Promise<Connection> =>
  new Connection(await connectMysqlFamily({ uri: db.url }))
const openPostgres = async (db: ServerDatabase): Promise<Connection> =>
  new Connection(pgDriver({ connectionString: db.url }))

/** Every engine, MySQL first (it is the default). */
export const engines: readonly Engine[] = [
  {
    name: 'mysql',
    dialect: 'mysql',
    skipped: skipReason('mysql'),
    connect: () => onServer('mysql', openMysql),
    connectAgain: () => again('mysql', openMysql),
  },
  {
    name: 'mariadb',
    dialect: 'mariadb',
    skipped: skipReason('mariadb'),
    connect: () => onServer('mariadb', openMariadb),
    connectAgain: () => again('mariadb', openMariadb),
  },
  {
    name: 'postgres',
    dialect: 'postgres',
    skipped: skipReason('postgres'),
    connect: () => onServer('postgres', openPostgres),
    connectAgain: () => again('postgres', openPostgres),
  },
  {
    name: 'pglite',
    dialect: 'postgres',
    skipped: undefined,
    connect: async () => ({
      connection: new Connection(pgliteDriver(await PGlite.create())),
      cleanup: none,
    }),
    connectAgain: () => Promise.reject(new Error('PGlite has a single connection.')),
  },
  {
    name: 'sqlite',
    dialect: 'sqlite',
    skipped: undefined,
    connect: async () => ({ connection: new Connection(sqliteDriver(':memory:')), cleanup: none }),
    connectAgain: () =>
      Promise.reject(new Error('An in-memory SQLite database has one connection.')),
  },
]

/** The describe title, with the skip reason when there is one (so a skipped run says why). */
export function engineTitle(engine: Engine): string {
  return engine.skipped === undefined ? engine.name : `${engine.name} (skipped: ${engine.skipped})`
}

/**
 * Set up an engine for the surrounding describe block. Returns a getter for the connection.
 *
 * @example
 * describe.each(engines)('$name', (engine) => { const db = useEngine(engine) })
 */
export function useEngine(engine: Engine): () => Connection {
  let connection: Connection | undefined
  let cleanup: () => Promise<void> = none
  beforeAll(async () => {
    if (engine.skipped !== undefined) return
    registerSchema(snapshot)
    const opened = await engine.connect()
    connection = opened.connection
    cleanup = opened.cleanup
    await createTables(connection, snapshot)
  })
  beforeEach(async () => {
    if (connection === undefined) return
    // Each describe block runs alone in its file, so pointing the global resolver here is safe.
    useConnection(connection)
    await clearTables(connection)
  })
  afterAll(async () => {
    await connection?.close()
    await cleanup()
  })
  return () => {
    if (connection === undefined) throw new Error(`The ${engine.name} connection is not open.`)
    return connection
  }
}
