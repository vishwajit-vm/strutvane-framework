/**
 * The v2 `Application` and the ORM, end to end: a real app folder with migrations, `node strut
 * migrate` run on it, then an `Application` whose routes read and write rows through models, over
 * HTTP. Found by the skeleton's integration test (2026-11-18): the 0.2.0-next.0 Application opened
 * no connection, so models worked in `node strut` commands but not in a single request.
 *
 * What is proven, on SQLite and on MySQL, MariaDB and PostgreSQL when Docker runs them:
 * - models query the connection from `DB_*` / `config/database.ts`, opened on the first query;
 * - the schema comes from the app's own `.strutvane/schema.json` (not left over from `migrate`);
 * - with `config/tenancy.ts` on, the request's tenant scopes every query;
 * - shutdown closes the connection;
 * - (SQLite) two apps in one process each use their own database, and an app that never queries
 *   never needs one (`/up` with an unreachable server still answers).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../../src/commands.ts'
import { HTTP_HOOKS, type HttpRequestHookPayload } from '../../../src/contracts/http-hooks.ts'
import { EventBusToken, HooksToken } from '../../../src/core/tokens.ts'
import { configureOrm, registerSchema, sql } from '../../../src/database/index.ts'
import { Application } from '../../../src/foundation/application.ts'
import { defineConfig } from '../../../src/foundation/config.ts'
import { DatabaseConnectionToken } from '../../../src/foundation/database.ts'
import { defineRoutes, Route } from '../../../src/routing/route.ts'
import { testClient } from '../../../src/testing/app-client.ts'
import { APP_KEY } from '../../app/helpers.ts'
import { serverDatabase, skipReason } from '../../helpers/server-database.ts'
import { Tag } from './fixtures/app/models/tag.ts'
import { Task } from './fixtures/app/models/task.ts'

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
const TASKS = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('tasks', (t) => {
      t.id()
      t.tenant()
      t.uuid('project_id')
      t.string('title', 200)
      t.boolean('done').default(false)
    })
  },
  down(schema) { schema.dropIfExists('tasks') },
})
`
const A = '0193a0b2-0000-7000-8000-00000000000a'
const B = '0193a0b2-0000-7000-8000-00000000000b'
const PROJECT = '0193a0b2-0000-7000-8000-0000000000ff'

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

function write(root: string, path: string, content: string): void {
  const file = join(root, ...path.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** A migration-first app folder: two migrations and the tenancy switch. */
function appFolder(tenancy: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-app-db-'))
  folders.push(root)
  write(root, 'database/migrations/2026_01_01_000000_create_tags_table.ts', TAGS)
  if (tenancy) {
    write(root, 'database/migrations/2026_01_02_000000_create_tasks_table.ts', TASKS)
    write(root, 'config/tenancy.ts', "export default { enabled: true, column: 'tenant_id' }\n")
  }
  return root
}

/** Run `node strut migrate` on the folder, as the CLI does. */
async function migrate(root: string, env: Readonly<Record<string, string>>): Promise<void> {
  const command = commands.find((candidate) => candidate.name === 'migrate')
  if (command === undefined) throw new Error('no migrate command')
  const ctx: CommandContextLike = {
    flags: {},
    appEnv: 'testing',
    // The gate loads every core: give the sandboxed replay room (the default is 10 s).
    services: { env: { ...env, APP_ENV: 'testing', DB_MIGRATION_REPLAY_TIMEOUT: '2min' } },
    requireProject: () => ({ root }),
    out: {
      line: () => undefined,
      success: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      table: () => undefined,
    },
  }
  await command.run(ctx)
  // Forget what `migrate` told the ORM: the application must load the schema and tenancy itself.
  registerSchema({ version: 1, tables: {} })
  configureOrm({ tenancy: false })
}

/** The tenant a request names in `x-tenant`, as an auth package's hook would resolve it. */
const tenantFromHeader = {
  name: 'test.tenant',
  register: () => undefined,
  boot: (app: Application) => {
    app.make(HooksToken).on(
      HTTP_HOOKS.request,
      (payload) => {
        const request = payload as HttpRequestHookPayload
        const id = request.request.headers.get('x-tenant')
        return id === null ? undefined : { ...request, tenant: { id, strategy: 'column' as const } }
      },
      { name: 'test.tenant' },
    )
  },
}

/** An app whose routes use the fixture models. */
function application(root: string, env: Readonly<Record<string, string>>): Application {
  return Application.configure({
    basePath: root,
    env: { APP_ENV: 'testing', APP_DEBUG: 'true', APP_KEY, ...env },
  })
    .withProviders([tenantFromHeader])
    .withRouting({
      api: defineRoutes([
        Route.get('/tags', async (ctx) => {
          const tags = await Tag.query().orderBy('name').get()
          return ctx.json(tags.map((tag) => tag.toJSON()))
        }),
        Route.post('/tags', async (ctx) => {
          // Untrusted input: the model's fillable list decides what is accepted, at run time.
          const tag = await Tag.create((await ctx.body()) as { name: string })
          return ctx.json(tag.toJSON(), 201)
        }),
        Route.get('/tasks', async (ctx) => {
          const tasks = await Task.query().orderBy('id').get()
          return ctx.json(tasks.map((task) => task.title))
        }),
        Route.post('/tasks', async (ctx) => {
          const task = await Task.create(
            (await ctx.body()) as { project_id: string; title: string },
          )
          return ctx.json({ id: task.id }, 201)
        }),
      ]),
    })
    .create()
}

interface EngineCase {
  readonly name: 'sqlite' | 'postgres' | 'mysql' | 'mariadb'
  readonly skipped: string | undefined
  /** The DB_* keys for a fresh database, and how to drop it. */
  database(root: string): Promise<{ env: Record<string, string>; drop: () => Promise<void> }>
}

const server =
  (engine: 'postgres' | 'mysql' | 'mariadb'): EngineCase['database'] =>
  async () => {
    const db = await serverDatabase(engine)
    const connection = engine === 'postgres' ? 'pgsql' : engine
    return { env: { DB_CONNECTION: connection, DB_URL: db.url }, drop: () => db.drop() }
  }

const ENGINES: readonly EngineCase[] = [
  {
    name: 'sqlite',
    skipped: undefined,
    database: async () => ({
      env: { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' },
      drop: async () => undefined,
    }),
  },
  { name: 'postgres', skipped: skipReason('postgres'), database: server('postgres') },
  { name: 'mysql', skipped: skipReason('mysql'), database: server('mysql') },
  { name: 'mariadb', skipped: skipReason('mariadb'), database: server('mariadb') },
]

describe.each(ENGINES)('an application reads and writes rows over HTTP on $name', (engine) => {
  const title = (text: string): string =>
    engine.skipped === undefined ? text : `${text} (skipped: ${engine.skipped})`

  test.skipIf(engine.skipped !== undefined)(
    title('models use the connection from DB_*, tenant-scoped per request; shutdown closes it'),
    async () => {
      const root = appFolder(true)
      const { env, drop } = await engine.database(root)
      try {
        await migrate(root, env)
        const app = application(root, env)
        const client = testClient(app).withoutCsrf()
        const created = await client.postJson('/api/tags', { name: 'typescript' })
        created.assertStatus(201)
        expect(created.json).toMatchObject({ id: expect.anything(), name: 'typescript' })
        await client.postJson('/api/tags', { name: 'laravel' })
        expect((await client.getJson('/api/tags')).json).toMatchObject([
          { name: 'laravel' },
          { name: 'typescript' },
        ])
        // Mass assignment is the model's rule, inside requests too.
        const refused = await client.postJson('/api/tags', { name: 'x', id: 99 })
        expect(refused.status).toBeGreaterThanOrEqual(400)
        expect(refused.status).not.toBe(201)

        const asA = client.withHeaders({ 'x-tenant': A })
        const asB = client.withHeaders({ 'x-tenant': B })
        ;(await asA.postJson('/api/tasks', { project_id: PROJECT, title: 'A1' })).assertStatus(201)
        ;(await asA.postJson('/api/tasks', { project_id: PROJECT, title: 'A2' })).assertStatus(201)
        ;(await asB.postJson('/api/tasks', { project_id: PROJECT, title: 'B1' })).assertStatus(201)
        expect((await asA.getJson('/api/tasks')).json).toEqual(['A1', 'A2'])
        expect((await asB.getJson('/api/tasks')).json).toEqual(['B1'])
        // No tenant: tenant tables refuse to be read (fail closed), never answer unscoped.
        expect((await client.getJson('/api/tasks')).status).toBeGreaterThanOrEqual(400)

        const connection = app.make(DatabaseConnectionToken)
        await app.shutdown()
        await expect(connection.run(sql`SELECT 1`)).rejects.toThrow(/closed/)
      } finally {
        await drop()
      }
    },
  )
})

describe('the application connection on SQLite', () => {
  test("model events reach the app's event bus after commit, with the request's tenant", async () => {
    const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' }
    const root = appFolder(true)
    await migrate(root, env)
    const app = application(root, env)
    await app.boot()
    const seen: { type: string; tenantId: string | undefined; name: unknown }[] = []
    const bus = app.make(EventBusToken)
    for (const type of ['tag.created', 'task.created'])
      bus.on(type, (event) => {
        const payload = event.payload as { record: Record<string, unknown> }
        seen.push({
          type: event.type,
          tenantId: event.tenantId,
          name: payload.record['name'] ?? payload.record['title'],
        })
      })
    const client = testClient(app).withoutCsrf()
    ;(await client.postJson('/api/tags', { name: 'events' })).assertStatus(201)
    ;(
      await client
        .withHeaders({ 'x-tenant': A })
        .postJson('/api/tasks', { project_id: PROJECT, title: 'scoped' })
    ).assertStatus(201)
    expect(seen).toEqual([
      { type: 'tag.created', tenantId: undefined, name: 'events' },
      { type: 'task.created', tenantId: A, name: 'scoped' },
    ])
    await app.shutdown()
  })

  test('two apps in one process each use their own database', async () => {
    const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' }
    const first = appFolder(false)
    const second = appFolder(false)
    await migrate(first, env)
    await migrate(second, env)
    const one = application(first, env)
    const two = application(second, env)
    const oneClient = testClient(one).withoutCsrf()
    const twoClient = testClient(two).withoutCsrf()
    ;(await oneClient.postJson('/api/tags', { name: 'only-in-one' })).assertStatus(201)
    expect((await twoClient.getJson('/api/tags')).json).toEqual([])
    expect((await oneClient.getJson('/api/tags')).json).toMatchObject([{ name: 'only-in-one' }])
    await Promise.all([one.shutdown(), two.shutdown()])
  })

  test('config/database.ts wins over .env, and APP_ENV=testing uses test_database', async () => {
    const root = appFolder(false)
    await migrate(root, { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/testing.sqlite' })
    const app = Application.configure({
      basePath: root,
      // .env names a database that doesn't exist: the config file must win.
      env: { APP_ENV: 'testing', APP_KEY, DB_CONNECTION: 'mysql', DB_DATABASE: 'nope' },
    })
      .withConfig({
        database: defineConfig(() => ({
          default: 'sqlite',
          database: 'database/local.sqlite',
          test_database: 'database/testing.sqlite',
        })),
      })
      .withRouting({
        api: defineRoutes([
          Route.get('/tags', async (ctx) => ctx.json((await Tag.all()).map((tag) => tag.name))),
        ]),
      })
      .create()
    const response = await testClient(app).getJson('/api/tags')
    response.assertStatus(200)
    expect(response.json).toEqual([])
    await app.shutdown()
  })

  test('an app that never queries never opens the database (lazy, Laravel-style)', async () => {
    // A port nothing listens on: opening would fail at once.
    const port = await freePort()
    const root = appFolder(false)
    // The schema exists (generated on SQLite); the configured server does not answer.
    await migrate(root, { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' })
    const env = { DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: String(port) }
    const app = application(root, env)
    const client = testClient(app).withoutCsrf()
    ;(await client.getJson('/up')).assertStatus(200)
    // The first query is what fails, as a 500 for that request only, and the app keeps serving.
    // (The log shows `connect ECONNREFUSED`; the response stays a plain 500 problem.)
    expect((await client.getJson('/api/tags')).status).toBe(500)
    ;(await client.getJson('/up')).assertStatus(200)
    await app.shutdown()
  })

  test('a provider (or test) binding wins over the default connection', async () => {
    const root = appFolder(false)
    await migrate(root, { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/other.sqlite' })
    const app = application(root, { DB_CONNECTION: 'mysql', DB_PORT: '1' })
    const { Connection, sqliteDriver } = await import('../../../src/database/index.ts')
    const own = new Connection(sqliteDriver(join(root, 'database', 'other.sqlite')))
    app.container.value(DatabaseConnectionToken, own)
    const client = testClient(app).withoutCsrf()
    ;(await client.postJson('/api/tags', { name: 'bound' })).assertStatus(201)
    const { rows } = await own.run(sql`SELECT name FROM tags`)
    expect(rows).toEqual([{ name: 'bound' }])
    await app.shutdown()
    await own.close()
  })
})

/** A TCP port that is free right now (nothing will answer on it). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}
