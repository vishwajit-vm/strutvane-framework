/**
 * Several databases in one application, end to end (CONSISTENCY #132, RFC-0007): a real app
 * folder, `node strut migrate` on the default connection and `--database=<name>` on extra ones,
 * then an `Application` whose routes use both at the same time.
 *
 * What is proven:
 * - the default connection is SQLite; each extra one is a different engine (another SQLite file,
 *   and MySQL, MariaDB and PostgreSQL when Docker runs them), declared in `config/database.ts`
 *   and configured by its own `DB_<NAME>_*` keys;
 * - a model's `connection` option and `Model.on()` write to the right database, and a transaction
 *   on one connection never covers or rolls back the other;
 * - shutdown closes every connection that was opened;
 * - boot succeeds with every optional key empty (the app's whole `.env` listed, Laravel-style); a
 *   connection whose keys are empty fails on first use with `database_not_configured` naming the
 *   key, and the app keeps serving;
 * - the CLI refuses an undeclared `--database` name.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../../src/commands.ts'
import { ValidationError } from '../../../src/core/index.ts'
import { configureOrm, db, Model, registerSchema, sql } from '../../../src/database/index.ts'
import { Application } from '../../../src/foundation/application.ts'
import { BootError } from '../../../src/foundation/boot-error.ts'
import { defineConfig } from '../../../src/foundation/config.ts'
import { DatabaseConnectionToken } from '../../../src/foundation/database.ts'
import { DatabaseManagerToken } from '../../../src/foundation/database-connections.ts'
import { defineRoutes, Route } from '../../../src/routing/route.ts'
import { testClient } from '../../../src/testing/app-client.ts'
import { APP_KEY } from '../../app/helpers.ts'
import { serverDatabase, skipReason } from '../../helpers/server-database.ts'

const TAGS = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('tags', (t) => {
      t.id()
      t.string('name', 50).unique()
    }, { global: true })
  },
  down(schema) { schema.dropIfExists('tags') },
})
`

/** Tags on the default (`DB_*`) connection. */
class Tag extends Model('tags', { fillable: ['name'] }) {}
/** Tags on the `extra` connection, declared by the model. */
class ExtraTag extends Model('tags', { fillable: ['name'], connection: 'extra' }) {}

/** The framework's `/database` entry, by absolute path, for code written into the app folder. */
const ENTRY = JSON.stringify(
  fileURLToPath(new URL('../../../src/entries/database.ts', import.meta.url)).replace(/\\/g, '/'),
)

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

function write(root: string, path: string, content: string): void {
  const file = join(root, ...path.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/**
 * An app folder with one migration and a `config/database.ts` the CLI reads (plain JS in a .ts
 * file: the temp folder has no node_modules to import the framework from).
 */
function appFolder(driver: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-app-conns-'))
  folders.push(root)
  write(root, 'database/migrations/2026_01_01_000000_create_tags_table.ts', TAGS)
  write(
    root,
    'config/database.ts',
    `export default { build: () => ({ connections: { extra: { driver: '${driver}' }, mysql: {}, pgsql: {}, sqlite: {} } }) }\n`,
  )
  return root
}

const quietOut: CommandContextLike['out'] = {
  line: () => undefined,
  success: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  table: () => undefined,
}

/** Run a `node strut` command on the folder, as the CLI does. */
async function strut(
  name: string,
  root: string,
  env: Readonly<Record<string, string>>,
  flags: Readonly<Record<string, string | boolean>> = {},
): Promise<unknown> {
  const command = commands.find((candidate) => candidate.name === name)
  if (command === undefined) throw new Error(`no ${name} command`)
  const result = await command.run({
    flags,
    appEnv: 'local',
    // The gate loads every core: give the sandboxed replay room (the default is 10 s).
    services: { env: { ...env, APP_ENV: 'local', DB_MIGRATION_REPLAY_TIMEOUT: '2min' } },
    requireProject: () => ({ root }),
    out: quietOut,
  })
  // Forget what the command told the ORM: the application loads the schema itself.
  registerSchema({ version: 1, tables: {} })
  configureOrm({ tenancy: false })
  return result
}

/** The routes: each one uses the default and the extra connection. */
function application(
  root: string,
  env: Readonly<Record<string, string>>,
  driver: string,
): Application {
  return Application.configure({
    basePath: root,
    env: { APP_ENV: 'testing', APP_DEBUG: 'true', APP_KEY, ...env },
  })
    .withConfig({
      database: defineConfig((reader) => ({
        default: reader.string('DB_CONNECTION', 'sqlite'),
        connections: { extra: { driver }, mysql: {}, pgsql: {}, sqlite: {} },
      })),
    })
    .withRouting({
      api: defineRoutes([
        Route.post('/both', async (ctx) => {
          const { name } = (await ctx.body()) as { name: string }
          await Tag.create({ name: `default-${name}` })
          await ExtraTag.create({ name: `extra-${name}` })
          return ctx.json({ ok: true }, 201)
        }),
        Route.post('/extra-fails', async (ctx) => {
          // The extra connection's transaction rolls back; the default write is not part of it.
          try {
            await db.connection('extra').transaction(async () => {
              await Tag.create({ name: 'default-survives' })
              await Tag.on('extra').create({ name: 'extra-rolled-back' })
              throw new Error('boom')
            })
          } catch {
            // expected
          }
          return ctx.json({ ok: true })
        }),
        Route.get('/tags', async (ctx) => {
          const names = async (model: typeof Tag): Promise<string[]> =>
            (await model.query().orderBy('name').get()).map((tag) => tag.name)
          return ctx.json({ default: await names(Tag), extra: await names(ExtraTag) })
        }),
        Route.get('/mysql', async (ctx) => {
          await db.connection('mysql').run(sql`SELECT 1`)
          return ctx.json({ ok: true })
        }),
      ]),
    })
    .create()
}

interface ExtraEngine {
  readonly name: 'sqlite' | 'postgres' | 'mysql' | 'mariadb'
  /** The `driver` of the extra connection. */
  readonly driver: string
  readonly skipped: string | undefined
  /** The DB_EXTRA_* keys for a fresh database, and how to drop it. */
  database(): Promise<{ env: Record<string, string>; drop: () => Promise<void> }>
}

const server =
  (engine: 'postgres' | 'mysql' | 'mariadb'): ExtraEngine['database'] =>
  async () => {
    const created = await serverDatabase(engine)
    return { env: { DB_EXTRA_URL: created.url }, drop: () => created.drop() }
  }

const EXTRA_ENGINES: readonly ExtraEngine[] = [
  {
    name: 'sqlite',
    driver: 'sqlite',
    skipped: undefined,
    database: async () => ({
      env: { DB_EXTRA_DATABASE: 'database/extra.sqlite' },
      drop: async () => undefined,
    }),
  },
  {
    name: 'postgres',
    driver: 'pgsql',
    skipped: skipReason('postgres'),
    database: server('postgres'),
  },
  { name: 'mysql', driver: 'mysql', skipped: skipReason('mysql'), database: server('mysql') },
  {
    name: 'mariadb',
    driver: 'mariadb',
    skipped: skipReason('mariadb'),
    database: server('mariadb'),
  },
]

const DEFAULT_ENV = { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' }

describe.each(EXTRA_ENGINES)('SQLite by default, $name as an extra connection', (engine) => {
  const title = (text: string): string =>
    engine.skipped === undefined ? text : `${text} (skipped: ${engine.skipped})`

  test.skipIf(engine.skipped !== undefined)(
    title('migrate --database, both connections in one request, separate transactions, shutdown'),
    async () => {
      const root = appFolder(engine.driver)
      const { env: extraEnv, drop } = await engine.database()
      const env = { ...DEFAULT_ENV, ...extraEnv }
      try {
        await strut('migrate', root, env)
        await strut('migrate', root, env, { database: 'extra' })
        const status = (await strut('migrate:status', root, env, { database: 'extra' })) as {
          data: { ran: readonly { migration: string }[]; pending: readonly string[] }
        }
        expect(status.data.ran.map((ran) => ran.migration)).toEqual([
          '2026_01_01_000000_create_tags_table',
        ])
        expect(status.data.pending).toEqual([])

        const app = application(root, env, engine.driver)
        const client = testClient(app).withoutCsrf()
        ;(await client.postJson('/api/both', { name: 'one' })).assertStatus(201)
        ;(await client.postJson('/api/extra-fails', {})).assertStatus(200)
        expect((await client.getJson('/api/tags')).json).toEqual({
          default: ['default-one', 'default-survives'],
          extra: ['extra-one'],
        })

        const extra = app.make(DatabaseManagerToken).connection('extra')
        expect(extra.grammar.dialect).toBe(engine.name === 'postgres' ? 'postgres' : engine.name)
        const main = app.make(DatabaseConnectionToken)
        await app.shutdown()
        await expect(extra.run(sql`SELECT 1`)).rejects.toThrow(/closed/)
        await expect(main.run(sql`SELECT 1`)).rejects.toThrow(/closed/)

        // migrate:rollback on the extra connection leaves the default one alone.
        await strut('migrate:rollback', root, env, { database: 'extra' })
        const after = (await strut('migrate:status', root, env, { database: 'extra' })) as {
          data: { pending: readonly string[] }
        }
        expect(after.data.pending).toEqual(['2026_01_01_000000_create_tags_table'])
        const defaultStatus = (await strut('migrate:status', root, env)) as {
          data: { pending: readonly string[] }
        }
        expect(defaultStatus.data.pending).toEqual([])
      } finally {
        await drop()
      }
    },
  )
})

describe('an empty key never breaks boot (#132)', () => {
  /** Every key a generated app lists in .env, empty, except the one root secret. */
  const EMPTY: Readonly<Record<string, string>> = Object.fromEntries(
    [
      'APP_NAME',
      'APP_DEBUG',
      'APP_URL',
      'APP_PORT',
      'APP_PREVIOUS_KEYS',
      'APP_LOCALE',
      'APP_TIMEZONE',
      'APP_CURRENCY',
      'DB_CONNECTION',
      'DB_URL',
      'DB_HOST',
      'DB_PORT',
      'DB_DATABASE',
      'DB_TEST_DATABASE',
      'DB_USERNAME',
      'DB_PASSWORD',
      'DB_SOCKET',
      'DB_SSLMODE',
      'DB_SSL_CA',
      'DB_MIGRATION_LOCK_TIMEOUT',
      ...['MYSQL', 'PGSQL', 'SQLITE'].flatMap((name) =>
        [
          'DRIVER',
          'URL',
          'HOST',
          'PORT',
          'DATABASE',
          'TEST_DATABASE',
          'USERNAME',
          'PASSWORD',
          'SOCKET',
          'SSLMODE',
          'SSL_CA',
        ].map((key) => `DB_${name}_${key}`),
      ),
      'LOG_CHANNEL',
      'LOG_STACK',
      'LOG_LEVEL',
      'LOG_DAILY_DAYS',
      'LOG_FORMAT',
      'LOG_PATH',
      'LOG_SLACK_WEBHOOK_URL',
      'CACHE_STORE',
      'CACHE_PREFIX',
      'FILESYSTEM_DISK',
      'SESSION_DRIVER',
      'SESSION_LIFETIME',
      'SESSION_COOKIE',
      'QUEUE_CONNECTION',
      'MAIL_MAILER',
      'MAIL_HOST',
      'MAIL_PORT',
      'MAIL_USERNAME',
      'MAIL_PASSWORD',
      'MAIL_FROM_ADDRESS',
      'BROADCAST_CONNECTION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_DEFAULT_REGION',
      'AWS_BUCKET',
      'REDIS_URL',
      'REDIS_HOST',
      'REDIS_PASSWORD',
      'REDIS_PORT',
      'REDIS_DB',
    ].map((key) => [key, '']),
  )

  /** The skeleton's config files, in the shape it ships them (see strutvane-skeleton). */
  const configs = {
    app: defineConfig((env) => ({
      name: env.string('APP_NAME', 'Blog'),
      env: env.oneOf('APP_ENV', ['local', 'testing', 'staging', 'production'], 'production'),
      debug: env.boolean('APP_DEBUG', false),
      url: env.url('APP_URL', 'http://localhost:3000'),
      port: env.integer('APP_PORT', 3000),
      key: env.string('APP_KEY'),
      previous_keys: env.string('APP_PREVIOUS_KEYS', ''),
    })),
    cache: defineConfig((env) => ({
      default: env.string('CACHE_STORE', 'file'),
      stores: {
        file: { driver: 'file', path: 'storage/framework/cache' },
        memory: { driver: 'memory' },
      },
    })),
    database: defineConfig((env) => ({
      default: env.oneOf(
        'DB_CONNECTION',
        ['mysql', 'mariadb', 'pgsql', 'postgres', 'sqlite'],
        'sqlite',
      ),
      host: env.string('DB_HOST', '127.0.0.1'),
      port: env.optional('DB_PORT'),
      database: env.string('DB_DATABASE', 'database/database.sqlite'),
      username: env.string('DB_USERNAME', ''),
      socket: env.optional('DB_SOCKET'),
      sslmode: env.optional('DB_SSLMODE'),
      ssl_ca: env.optional('DB_SSL_CA'),
      test_database: env.optional('DB_TEST_DATABASE'),
      connections: { mysql: {}, pgsql: {}, sqlite: {} },
    })),
    filesystems: defineConfig((env) => ({
      default: env.string('FILESYSTEM_DISK', 'local'),
      disks: { local: { driver: 'local', root: 'storage/app', visibility: 'private' } },
    })),
    session: defineConfig((env) => ({
      driver: env.oneOf('SESSION_DRIVER', ['file'], 'file'),
      lifetime: env.integer('SESSION_LIFETIME', 120),
      cookie: env.string('SESSION_COOKIE', 'blog_session'),
    })),
  }

  test('boot and /up work; an unconfigured connection fails its first use, naming the key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sv-empty-env-'))
    folders.push(root)
    const app = Application.configure({
      basePath: root,
      env: { ...EMPTY, APP_ENV: 'local', APP_KEY },
    })
      .withConfig(configs)
      .withRouting({
        health: '/up',
        api: defineRoutes([
          Route.get('/mysql', async (ctx) => {
            await db.connection('mysql').run(sql`SELECT 1`)
            return ctx.json({ ok: true })
          }),
        ]),
      })
      .create()
    await app.boot()
    const client = testClient(app)
    ;(await client.get('/up')).assertStatus(200)
    // Nothing was opened: an empty DB_* means the SQLite default, created only on first query.
    expect(existsSync(join(root, 'database', 'database.sqlite'))).toBe(false)

    for (const name of ['mysql', 'pgsql', 'sqlite']) {
      const error = await app.run(async () => {
        try {
          db.connection(name)
        } catch (caught) {
          return caught
        }
        return undefined
      })
      expect(error).toBeInstanceOf(BootError)
      expect((error as BootError).code).toBe('database_not_configured')
      expect((error as BootError).hint).toContain(`DB_${name.toUpperCase()}_DATABASE`)
    }
    // In a request it is a 500 for that request only; the app keeps serving.
    expect((await client.getJson('/api/mysql')).status).toBe(500)
    ;(await client.get('/up')).assertStatus(200)
    await app.shutdown()
  })
})

describe('node strut … --database', () => {
  test('an undeclared or malformed name is refused before anything is opened', async () => {
    const root = appFolder('sqlite')
    for (const [name, code] of [
      ['reports', 'unknown_connection'],
      ['Bad-Name', 'invalid_connection_name'],
    ] as const) {
      const error = await strut('migrate', root, DEFAULT_ENV, { database: name }).catch(
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(JSON.stringify((error as ValidationError).issues)).toContain(code)
    }
    expect(existsSync(join(root, 'database', 'database.sqlite'))).toBe(false)
  })

  test('a declared connection with empty keys fails with database_not_configured', async () => {
    const root = appFolder('sqlite')
    const error = await strut('migrate', root, DEFAULT_ENV, { database: 'pgsql' }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BootError)
    expect((error as BootError).code).toBe('database_not_configured')
    expect((error as BootError).hint).toContain('DB_PGSQL_DATABASE')
  })

  test('--database=default is the DB_* connection', async () => {
    const root = appFolder('sqlite')
    await strut('migrate', root, DEFAULT_ENV, { database: 'default' })
    expect(existsSync(join(root, 'database', 'database.sqlite'))).toBe(true)
  })

  test('db:seed --database runs the seeders on that connection, and a model declaring it finds it', async () => {
    const root = appFolder('sqlite')
    const env = { ...DEFAULT_ENV, DB_EXTRA_DATABASE: 'database/extra.sqlite' }
    await strut('migrate', root, env, { database: 'extra' })
    write(
      root,
      'database/seeders/database.seeder.ts',
      `import { defineSeeder, Model } from ${ENTRY}
class ExtraTag extends Model('tags', { fillable: ['name'], connection: 'extra' }) {}
export default defineSeeder({ async run() { await ExtraTag.create({ name: 'seeded' }) } })
`,
    )
    expect(await strut('db:seed', root, env, { database: 'extra' })).toMatchObject({
      data: { ran: ['DatabaseSeeder'] },
    })
    const { Connection, sqliteDriver } = await import('../../../src/database/index.ts')
    const extra = new Connection(sqliteDriver(join(root, 'database', 'extra.sqlite')))
    expect((await extra.run(sql`SELECT name FROM tags`)).rows).toEqual([{ name: 'seeded' }])
    await extra.close()
    // The default database was never touched.
    expect(existsSync(join(root, 'database', 'database.sqlite'))).toBe(false)
  })
})
