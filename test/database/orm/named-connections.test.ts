/**
 * Several databases at once (CONSISTENCY #132, RFC-0007), below the application: the prefixed
 * `DB_<NAME>_*` settings, the declarations in `config/database.ts`, the connection resolver
 * (`db.connection()`, `useConnection(…, name)`), and models on a named connection (`connection`
 * option, `Model.on()`), with SQLite and PGlite used side by side in one process.
 *
 * Every failure is a stable lowercase code whose message or hint names the key to fix.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { EnvValidationError } from '../../../src/core/index.ts'
import { databaseEngineOf, databaseSettings } from '../../../src/database/config.ts'
import {
  Connection,
  configureOrm,
  connectionNamed,
  DEFAULT_CONNECTION,
  db,
  forgetConnection,
  isConnectionName,
  Model,
  OrmUsageError,
  pgliteDriver,
  registerSchema,
  runWithConnection,
  runWithConnections,
  sql,
  sqliteDriver,
  useConnection,
} from '../../../src/database/index.ts'
import { ModelBase } from '../../../src/database/orm/model.ts'
import { BootError } from '../../../src/foundation/boot-error.ts'
import {
  connectionEnvPrefix,
  DatabaseManager,
  declaredConnections,
  namedConnectionSettings,
  readConnectionsFromConfig,
} from '../../../src/foundation/database-connections.ts'
import { snapshot } from './fixtures/schema.ts'
import { createTables } from './support/ddl.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'sv-named-conn-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))

/** Run `fn` and return the error it throws (fails the test when it doesn't throw). */
function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected an error')
}

function bootError(fn: () => unknown): BootError {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(BootError)
  return error as BootError
}

describe('databaseSettings with a prefix (an extra connection)', () => {
  test('reads DB_<NAME>_* and names those keys in every problem', () => {
    const settings = databaseSettings(
      {
        DB_REPORTS_DRIVER: 'pgsql',
        DB_REPORTS_HOST: 'reports.internal',
        DB_REPORTS_DATABASE: 'reports',
        DB_REPORTS_PASSWORD: 'secret',
        // The default connection's keys are not read.
        DB_HOST: 'wrong',
      },
      ROOT,
      { prefix: 'DB_REPORTS_', driverKey: 'DB_REPORTS_DRIVER' },
    )
    expect(settings).toMatchObject({
      connection: 'pgsql',
      host: 'reports.internal',
      port: 5432,
      database: 'reports',
      username: 'postgres',
      password: 'secret',
    })
    const error = thrown(() =>
      databaseSettings(
        { DB_REPORTS_DRIVER: 'oracle', DB_REPORTS_PORT: 'x', DB_REPORTS_SSLMODE: 'maybe' },
        ROOT,
        { prefix: 'DB_REPORTS_', driverKey: 'DB_REPORTS_DRIVER' },
      ),
    )
    expect(error).toBeInstanceOf(EnvValidationError)
    expect((error as EnvValidationError).problems.map((problem) => problem.key)).toEqual([
      'DB_REPORTS_DRIVER',
      'DB_REPORTS_PORT',
      'DB_REPORTS_SSLMODE',
    ])
  })

  test('without a prefix it is the default DB_* connection, as before', () => {
    expect(databaseSettings({ DB_CONNECTION: 'sqlite' }, ROOT).filename).toBe(
      join(ROOT, 'database', 'database.sqlite'),
    )
  })

  test('databaseEngineOf knows the engine names and nothing else', () => {
    expect(databaseEngineOf('postgres')).toBe('pgsql')
    expect(databaseEngineOf('MySQL')).toBe('mysql')
    expect(databaseEngineOf('reports')).toBeUndefined()
    expect(databaseEngineOf('constructor')).toBeUndefined()
  })
})

describe('declaredConnections (config/database.ts → connections)', () => {
  test('no connections is an empty map; each declaration is kept with its text values', () => {
    expect(declaredConnections(undefined).size).toBe(0)
    expect(declaredConnections(null).size).toBe(0)
    const declared = declaredConnections({
      pgsql: {},
      reports: { driver: 'sqlite', database: 'r.sqlite', port: 5433, host: '', socket: undefined },
    })
    expect([...declared.keys()]).toEqual(['pgsql', 'reports'])
    // Empty and absent values are "not set": the .env key is read instead.
    expect(declared.get('reports')).toEqual({
      driver: 'sqlite',
      database: 'r.sqlite',
      port: '5433',
    })
  })

  test.each([
    ['a list', [], 'invalid_database_config'],
    ['text', 'pgsql', 'invalid_database_config'],
    ['a connection called default', { default: {} }, 'invalid_connection_name'],
    ['an upper-case name', { Reports: {} }, 'invalid_connection_name'],
    ['a name with a dash', { 'my-db': {} }, 'invalid_connection_name'],
    ['a declaration that is not an object', { reports: 'pgsql' }, 'invalid_database_config'],
    ['a typo in a key', { reports: { hots: 'x' } }, 'invalid_database_config'],
    ['a value that is not text', { reports: { port: true } }, 'invalid_database_config'],
    ['a password', { reports: { password: 'p' } }, 'secret_in_config'],
    ['a url', { reports: { url: 'postgres://u:p@h/db' } }, 'secret_in_config'],
  ])('refuses %s', (_name, value, code) => {
    const error = bootError(() => declaredConnections(value))
    expect(error.code).toBe(code)
    expect(error.hint.length).toBeGreaterThan(10)
  })

  test('the secret hint names the .env key to use instead', () => {
    const error = bootError(() => declaredConnections({ reports: { password: 'p' } }))
    expect(error.hint).toContain('DB_REPORTS_PASSWORD')
    // The secret itself is never echoed.
    expect(`${error.message} ${error.hint}`).not.toContain("'p'")
  })
})

describe('namedConnectionSettings', () => {
  test('a connection named after an engine uses it; the database key is required', () => {
    const error = bootError(() => namedConnectionSettings('pgsql', {}, {}, ROOT, 'local'))
    expect(error.code).toBe('database_not_configured')
    expect(error.message).toContain('DB_PGSQL_DATABASE')
    expect(error.hint).toContain('DB_PGSQL_DATABASE')
    expect(error.message).not.toContain('DB_PGSQL_DRIVER')
    expect(
      namedConnectionSettings('pgsql', {}, { DB_PGSQL_DATABASE: 'app' }, ROOT, 'local'),
    ).toMatchObject({ connection: 'pgsql', database: 'app', port: 5432 })
  })

  test('an app-chosen name needs its driver too, and both missing keys are named at once', () => {
    const error = bootError(() => namedConnectionSettings('reports', {}, {}, ROOT, 'local'))
    expect(error.code).toBe('database_not_configured')
    expect(error.message).toContain('DB_REPORTS_DRIVER and DB_REPORTS_DATABASE are empty')
  })

  test('empty keys count as not set', () => {
    const env = { DB_REPORTS_DRIVER: '  ', DB_REPORTS_DATABASE: '' }
    const error = bootError(() => namedConnectionSettings('reports', {}, env, ROOT, 'local'))
    expect(error.code).toBe('database_not_configured')
  })

  test('a server URL carries the database (and its engine); a SQLite connection always needs its file', () => {
    expect(
      namedConnectionSettings(
        'reports',
        {},
        { DB_REPORTS_URL: 'postgres://u:p@db.internal:5433/reports' },
        ROOT,
        'local',
      ),
    ).toMatchObject({ connection: 'pgsql', url: 'postgres://u:p@db.internal:5433/reports' })
    const error = bootError(() =>
      namedConnectionSettings('cache', { driver: 'sqlite' }, { DB_CACHE_URL: 'x' }, ROOT, 'local'),
    )
    expect(error.message).toContain('DB_CACHE_DATABASE')
  })

  test('config/database.ts wins over .env; the password comes from .env only', () => {
    const settings = namedConnectionSettings(
      'reports',
      { driver: 'mysql', host: 'from-config', port: '3307', database: 'reports' },
      {
        DB_REPORTS_DRIVER: 'pgsql',
        DB_REPORTS_HOST: 'from-env',
        DB_REPORTS_USERNAME: 'reporter',
        DB_REPORTS_PASSWORD: 'secret',
      },
      ROOT,
      'local',
    )
    expect(settings).toMatchObject({
      connection: 'mysql',
      host: 'from-config',
      port: 3307,
      database: 'reports',
      username: 'reporter',
      password: 'secret',
    })
  })

  test('APP_ENV=testing switches to the test database, other environments never do', () => {
    const env = { DB_REPORTS_DATABASE: 'reports', DB_REPORTS_TEST_DATABASE: 'reports_test' }
    const declared = { driver: 'pgsql' }
    expect(namedConnectionSettings('reports', declared, env, ROOT, 'testing').database).toBe(
      'reports_test',
    )
    expect(namedConnectionSettings('reports', declared, env, ROOT, 'local').database).toBe(
      'reports',
    )
    expect(
      namedConnectionSettings(
        'cache',
        { driver: 'sqlite' },
        { DB_CACHE_DATABASE: 'c.sqlite' },
        ROOT,
        'testing',
      ).filename,
    ).toBe(join(ROOT, 'c.sqlite'))
  })

  test('a bad value is invalid_database_config naming the prefixed key, with the env problem as cause', () => {
    const error = bootError(() =>
      namedConnectionSettings(
        'reports',
        { driver: 'pgsql', database: 'r' },
        { DB_REPORTS_PORT: '99999', DB_REPORTS_SSL_CA: 'missing-ca.pem' },
        ROOT,
        'local',
      ),
    )
    expect(error.code).toBe('invalid_database_config')
    expect(error.message).toContain('DB_REPORTS_PORT')
    expect(error.message).toContain('DB_REPORTS_SSL_CA')
    expect(error.hint).toContain('DB_REPORTS_PORT, DB_REPORTS_SSL_CA')
    expect(error.cause).toBeInstanceOf(EnvValidationError)
  })

  test('the prefix is the upper-cased name', () => {
    expect(connectionEnvPrefix('legacy_mysql')).toBe('DB_LEGACY_MYSQL_')
  })
})

describe('DatabaseManager', () => {
  const managers: DatabaseManager[] = []
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.close()))
  })

  function manager(
    connections: unknown,
    env: Readonly<Record<string, string>> = {},
  ): DatabaseManager {
    const main = new Connection(sqliteDriver(':memory:'))
    const created = new DatabaseManager({
      basePath: ROOT,
      environment: 'local',
      env: () => env,
      connections: () => connections,
      defaultConnection: () => main,
    })
    managers.push(created)
    return created
  }

  test('the default connection without a name or with "default"', () => {
    const created = manager(undefined)
    expect(created.connection()).toBe(created.connection(DEFAULT_CONNECTION))
  })

  test('opens nothing until the first statement, and returns one connection per name', async () => {
    const created = manager(
      { reports: { driver: 'sqlite' } },
      { DB_REPORTS_DATABASE: join(ROOT, 'manager-reports.sqlite') },
    )
    const reports = created.connection('reports')
    expect(created.connection('reports')).toBe(reports)
    await reports.run(sql`CREATE TABLE t (id INTEGER)`)
    await created.close()
    await expect(reports.run(sql`SELECT 1`)).rejects.toThrow(/closed/)
    expect(bootError(() => created.connection('reports')).code).toBe('connection_closed')
    // close() twice is fine.
    await created.close()
  })

  test('an undeclared name is unknown_connection, listing the declared ones', () => {
    expect(bootError(() => manager(undefined).connection('reports')).hint).toContain(
      "connections: { reports: { driver: 'pgsql' } }",
    )
    const error = bootError(() => manager({ pgsql: {}, mysql: {} }).connection('reprots'))
    expect(error.code).toBe('unknown_connection')
    expect(error.hint).toContain('pgsql, mysql')
  })

  test('a bad name is refused before anything is looked up', () => {
    expect(bootError(() => manager(undefined).connection('Reports')).code).toBe(
      'invalid_connection_name',
    )
  })

  test('a connection that is not configured fails on use and is not cached, so fixing .env works', () => {
    const env: Record<string, string> = {}
    const created = new DatabaseManager({
      basePath: ROOT,
      environment: 'local',
      env: () => env,
      connections: () => ({ pgsql: {} }),
      defaultConnection: () => new Connection(sqliteDriver(':memory:')),
    })
    managers.push(created)
    expect(bootError(() => created.connection('pgsql')).code).toBe('database_not_configured')
    env['DB_PGSQL_DATABASE'] = 'app'
    expect(created.connection('pgsql').grammar.dialect).toBe('postgres')
    expect([...created.declarations().keys()]).toEqual(['pgsql'])
  })
})

describe('the connection resolver outside an application', () => {
  afterEach(() => {
    forgetConnection('reports')
    forgetConnection()
  })

  test('connection names', () => {
    expect(isConnectionName('reports')).toBe(true)
    expect(isConnectionName('r2_d2')).toBe(true)
    expect(isConnectionName('2fast')).toBe(false)
    expect(isConnectionName('a'.repeat(64))).toBe(false)
  })

  test('useConnection(connection, name) registers a named one; unknown names are refused', async () => {
    const main = new Connection(sqliteDriver(':memory:'))
    const reports = new Connection(sqliteDriver(':memory:'))
    useConnection(main)
    useConnection(reports, 'reports')
    expect(db.connection()).toBe(main)
    expect(db.connection('default')).toBe(main)
    expect(db.connection('reports')).toBe(reports)
    const error = thrown(() => db.connection('archive'))
    expect(error).toBeInstanceOf(OrmUsageError)
    expect((error as OrmUsageError).code).toBe('unknown_connection')
    expect((error as Error).message).toContain('DB_ARCHIVE_*')
    expect((thrown(() => db.connection('Bad')) as OrmUsageError).code).toBe(
      'invalid_connection_name',
    )
    forgetConnection('reports')
    expect((thrown(() => connectionNamed('reports')) as OrmUsageError).code).toBe(
      'unknown_connection',
    )
    await Promise.all([main.close(), reports.close()])
  })

  test('runWithConnection provides only a default connection; runWithConnections provides both', () => {
    const main = new Connection(sqliteDriver(':memory:'))
    const reports = new Connection(sqliteDriver(':memory:'))
    // A process-wide named one is hidden inside a scope: the scope decides.
    useConnection(reports, 'reports')
    runWithConnection(
      () => main,
      () => {
        expect(db.connection()).toBe(main)
        expect((thrown(() => db.connection('reports')) as OrmUsageError).code).toBe(
          'unknown_connection',
        )
      },
    )
    runWithConnections(
      {
        default: () => main,
        named: (name) => {
          if (name === 'reports') return reports
          throw new Error(`no ${name}`)
        },
      },
      () => {
        expect(db.connection('reports')).toBe(reports)
        expect(() => db.connection('other')).toThrow('no other')
      },
    )
  })
})

describe('models on a named connection', () => {
  test('a bad connection option is refused when the model class is made', () => {
    const error = thrown(() => Model('tags', { connection: 'Not Valid' }))
    expect((error as OrmUsageError).code).toBe('invalid_connection_name')
    expect((thrown(() => ModelBase.on('x-y')) as OrmUsageError).code).toBe(
      'invalid_connection_name',
    )
  })

  test('Model.on() is a cached subclass with the same name, bound to the connection', () => {
    class Tag extends Model('tags', { fillable: ['name'] }) {}
    const onReports = Tag.on('reports')
    expect(Tag.on('reports')).toBe(onReports)
    expect(Tag.on('archive')).not.toBe(onReports)
    expect(onReports.name).toBe('Tag')
    expect(onReports.make()).toBeInstanceOf(Tag)
  })
})

describe('two engines in one process: SQLite (default) and PGlite (named)', () => {
  class Tag extends Model('tags', { fillable: ['name'] }) {}
  class ReportTag extends Model('tags', { fillable: ['name'], connection: 'reports' }) {}
  let main: Connection
  let reports: Connection
  const resolver = {
    default: () => main,
    named: (name: string): Connection => {
      if (name === 'reports') return reports
      throw new Error(`no ${name}`)
    },
  }
  const inApp = <T>(work: () => Promise<T>): Promise<T> => runWithConnections(resolver, work)

  beforeAll(async () => {
    registerSchema(snapshot)
    configureOrm({ tenancy: false })
    main = new Connection(sqliteDriver(':memory:'))
    reports = new Connection(pgliteDriver(await PGlite.create()))
    await createTables(main, snapshot)
    await createTables(reports, snapshot)
  })
  afterAll(async () => {
    await Promise.all([main.close(), reports.close()])
  })

  test('each model writes to its own engine; Model.on() reaches the other one', async () => {
    await inApp(async () => {
      await Tag.create({ name: 'on-sqlite' })
      await ReportTag.create({ name: 'on-pglite' })
      await Tag.on('reports').create({ name: 'also-on-pglite' })
      expect((await Tag.all()).map((tag) => tag.name)).toEqual(['on-sqlite'])
      expect((await ReportTag.query().orderBy('name').get()).map((tag) => tag.name)).toEqual([
        'also-on-pglite',
        'on-pglite',
      ])
      expect(ReportTag.connection()).toBe(reports)
      expect(Tag.on('reports').connection()).toBe(reports)
      // `default` is the DB_* connection, even for a model declared elsewhere.
      expect(ReportTag.on('default').connection()).toBe(main)
      expect(Tag.connection().grammar.dialect).toBe('sqlite')
      expect(ReportTag.connection().grammar.dialect).toBe('postgres')
    })
  })

  test('a transaction on one connection never covers the other', async () => {
    await inApp(async () => {
      // Rolled back on reports; the default connection's write is not part of it and stays.
      await expect(
        db.connection('reports').transaction(async () => {
          await Tag.create({ name: 'default-kept' })
          await ReportTag.create({ name: 'reports-rolled-back' })
          expect(db.connection('reports').inTransaction()).toBe(true)
          expect(db.connection().inTransaction()).toBe(false)
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      // And the other way round.
      await expect(
        db.transaction(async () => {
          await Tag.create({ name: 'default-rolled-back' })
          await ReportTag.create({ name: 'reports-kept' })
          throw new Error('bang')
        }),
      ).rejects.toThrow('bang')
      const names = async (model: typeof Tag | typeof ReportTag): Promise<string[]> =>
        (await model.query().orderBy('name').get()).map((tag) => tag.name)
      expect(await names(Tag)).toContain('default-kept')
      expect(await names(Tag)).not.toContain('default-rolled-back')
      expect(await names(ReportTag)).toContain('reports-kept')
      expect(await names(ReportTag)).not.toContain('reports-rolled-back')
    })
  })

  test('afterCommit on a named model waits for its own connection to commit', async () => {
    await inApp(async () => {
      const seen: string[] = []
      await db.connection('reports').transaction(async () => {
        await db.connection('reports').afterCommit(() => {
          seen.push('reports committed')
        })
        expect(seen).toEqual([])
      })
      expect(seen).toEqual(['reports committed'])
    })
  })
})

describe('readConnectionsFromConfig (what the CLI reads)', () => {
  test('runs a defineConfig-shaped file with the env, accepts a plain object, and is undefined without a file', async () => {
    const withBuild = mkdtempSync(join(ROOT, 'cfg-'))
    const plain = mkdtempSync(join(ROOT, 'cfg-'))
    const none = mkdtempSync(join(ROOT, 'cfg-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(withBuild, 'config'))
    mkdirSync(join(plain, 'config'))
    writeFileSync(
      join(withBuild, 'config', 'database.ts'),
      "export default { build: (env) => ({ connections: { reports: { driver: env.string('REPORTS_ENGINE', 'pgsql') } } }) }\n",
    )
    writeFileSync(
      join(plain, 'config', 'database.ts'),
      "export default { connections: { legacy: { driver: 'mysql' } } }\n",
    )
    expect(await readConnectionsFromConfig(withBuild, { REPORTS_ENGINE: 'sqlite' })).toEqual({
      reports: { driver: 'sqlite' },
    })
    expect(await readConnectionsFromConfig(plain, {})).toEqual({ legacy: { driver: 'mysql' } })
    expect(await readConnectionsFromConfig(none, {})).toBeUndefined()
  })
})
