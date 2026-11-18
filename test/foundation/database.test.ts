/**
 * The pieces the application's data layer is built from: where the `DB_*` values come from,
 * loading `.strutvane/schema.json`, the tenancy switch, and the model connection outside an app.
 * The end-to-end proof (rows over HTTP on every engine) is test/database/orm/app-database.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { createContainer } from '../../src/core/container.ts'
import { Connection } from '../../src/database/db/connection.ts'
import { defaultConnection, runWithConnection } from '../../src/database/db/manager.ts'
import { sqliteDriver } from '../../src/database/db/sqlite-driver.ts'
import { configureOrm, ormConfig } from '../../src/database/orm/config.ts'
import { allTables, registerSchema } from '../../src/database/schema/registry.ts'
import { Application } from '../../src/foundation/application.ts'
import { loadConfig } from '../../src/foundation/config.ts'
import {
  bindDatabase,
  configureTenancy,
  DatabaseConnectionToken,
  databaseEnv,
  loadSchemaSnapshot,
} from '../../src/foundation/database.ts'
import { defineConfig } from '../../src/index.ts'
import { APP_KEY } from '../app/helpers.ts'

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})
afterEach(() => {
  configureOrm({ tenancy: false })
  registerSchema({ version: 1, tables: {} })
})

function folder(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-foundation-db-'))
  folders.push(root)
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split('/'))
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  return root
}

describe('databaseEnv: config/database.ts over .env, secrets from the environment', () => {
  const config = (values: Record<string, unknown>) =>
    loadConfig({ database: defineConfig(() => values) }, {})

  test('config keys map onto DB_* and win over .env', () => {
    const env = databaseEnv(
      config({
        default: 'pgsql',
        host: 'db.internal',
        port: 6543,
        database: 'app',
        username: 'web',
        socket: '',
        sslmode: 'require',
      }),
      { DB_CONNECTION: 'mysql', DB_HOST: 'localhost', DB_PASSWORD: 'from-env', DB_URL: undefined },
      'production',
    )
    expect(env).toMatchObject({
      DB_CONNECTION: 'pgsql',
      DB_HOST: 'db.internal',
      DB_PORT: '6543',
      DB_DATABASE: 'app',
      DB_USERNAME: 'web',
      DB_SSLMODE: 'require',
      DB_PASSWORD: 'from-env',
    })
    // An empty config value doesn't erase the environment's.
    expect(env['DB_SOCKET']).toBeUndefined()
  })

  test('test_database is used only with APP_ENV=testing', () => {
    const files = config({ database: 'app', test_database: 'app_test' })
    expect(databaseEnv(files, {}, 'testing')['DB_DATABASE']).toBe('app_test')
    expect(databaseEnv(files, {}, 'local')['DB_DATABASE']).toBe('app')
  })

  test('without config/database.ts the environment is used as it is', () => {
    const env = databaseEnv(loadConfig({}, {}), { DB_CONNECTION: 'sqlite' }, 'testing')
    expect(env).toEqual({ DB_CONNECTION: 'sqlite' })
  })
})

describe('bindDatabase', () => {
  test('binds a lazy connection that reads the settings only when first resolved', () => {
    const container = createContainer()
    let reads = 0
    bindDatabase(container, {
      basePath: tmpdir(),
      env: () => {
        reads += 1
        return { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }
      },
    })
    expect(reads).toBe(0)
    const connection = container.make(DatabaseConnectionToken)
    expect(reads).toBe(1)
    expect(connection.grammar.dialect).toBe('sqlite')
  })

  test('keeps a connection bound earlier (a provider or a test double)', () => {
    const container = createContainer()
    const own = new Connection(sqliteDriver(':memory:'))
    container.value(DatabaseConnectionToken, own)
    bindDatabase(container, { basePath: tmpdir(), env: () => ({}) })
    expect(container.make(DatabaseConnectionToken)).toBe(own)
  })

  test('invalid DB_* keys fail on first use, naming the key', () => {
    const container = createContainer()
    bindDatabase(container, { basePath: tmpdir(), env: () => ({ DB_CONNECTION: 'oracle' }) })
    expect(() => container.make(DatabaseConnectionToken)).toThrow(/DB_CONNECTION|oracle/)
  })
})

describe('loadSchemaSnapshot', () => {
  test('no .strutvane/schema.json: nothing to load', () => {
    expect(loadSchemaSnapshot(folder())).toBe(false)
  })

  test('registers the snapshot for the ORM', () => {
    const root = folder({
      '.strutvane/schema.json': JSON.stringify({
        version: 1,
        tables: {
          notes: {
            name: 'notes',
            global: true,
            columns: [{ name: 'id', kind: 'id', nullable: false }],
            indexes: [],
          },
        },
      }),
    })
    expect(loadSchemaSnapshot(root)).toBe(true)
    expect(allTables()).toEqual(['notes'])
  })

  test.each([
    ['not JSON', '{'],
    ['a wrong shape', JSON.stringify({ version: 9, tables: [] })],
  ])('%s stops the boot with the fix', (_, content) => {
    const root = folder({ '.strutvane/schema.json': content })
    expect(() => loadSchemaSnapshot(root)).toThrow(
      expect.objectContaining({ code: 'invalid_schema_snapshot' }),
    )
  })
})

describe('configureTenancy', () => {
  test('config/tenancy.ts turns tenancy on with its column', async () => {
    const root = folder({
      'config/tenancy.ts': "export default { enabled: true, column: 'team_id' }\n",
    })
    expect(await configureTenancy(root, loadConfig({}, {}))).toBe('team_id')
    expect(ormConfig().tenancy).toEqual({ column: 'team_id' })
  })

  test('a tenancy config in the tree wins; enabled without a column means tenant_id', async () => {
    const root = folder({ 'config/tenancy.ts': 'export default { enabled: false }\n' })
    const config = loadConfig({ tenancy: defineConfig(() => ({ enabled: true })) }, {})
    expect(await configureTenancy(root, config)).toBe('tenant_id')
  })

  test('disabled turns it off; no setting at all leaves the ORM as it is', async () => {
    configureOrm({ tenancy: { column: 'tenant_id' } })
    expect(await configureTenancy(folder(), loadConfig({}, {}))).toBe('tenant_id')
    const off = folder({ 'config/tenancy.ts': 'export default { enabled: false }\n' })
    expect(await configureTenancy(off, loadConfig({}, {}))).toBeUndefined()
    expect(ormConfig().tenancy).toBe(false)
  })
})

describe('the model connection inside and outside an application', () => {
  test('runWithConnection wins over the process-wide connection, only inside', () => {
    const inside = new Connection(sqliteDriver(':memory:'))
    expect(
      runWithConnection(
        () => inside,
        () => defaultConnection(),
      ),
    ).toBe(inside)
  })

  test('querying in a provider register() (before the kernel binds it) says what to do', async () => {
    let caught: unknown
    const app = Application.configure({
      basePath: folder(),
      env: { APP_ENV: 'testing', APP_KEY },
    })
      .withProviders([
        {
          name: 'too.early',
          register: () => {
            try {
              defaultConnection()
            } catch (error) {
              caught = error
            }
          },
        },
      ])
      .create()
    await app.boot()
    expect(caught).toMatchObject({ code: 'no_connection' })
    expect(String((caught as Error).message)).toContain('boot()')
    // After boot it resolves, without opening anything.
    expect(app.run(() => defaultConnection())).toBe(app.make(DatabaseConnectionToken))
    await app.shutdown()
  })
})
