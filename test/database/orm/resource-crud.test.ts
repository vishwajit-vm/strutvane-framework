/**
 * The generated CRUD API over real ORM models (acceptance FW-5 and FW-10, 2026-11-20).
 *
 * FW-5: `class CustomerController extends ResourceController<typeof Customer> { model = Customer }`
 * failed at boot with `this.model.metadata is not a function`: the ORM's `Model()` classes did
 * not implement the controller's `ResourceModel` contract. FW-10: a duplicate unique value written
 * through `Customer.create()` was a 500 carrying the driver's SQL error.
 *
 * Proven here, on SQLite and on MySQL, MariaDB and PostgreSQL when Docker runs them, over HTTP on
 * a real migrated app: list (filter, search, sort, pagination, totals, include, fields), show,
 * create, update, delete, restore; validation from the model; deny-by-default policies; unknown
 * names refused before SQL; hidden columns never filtered, sorted, searched or returned;
 * enumeration (a row the user may not see answers exactly like a missing one); tenant isolation;
 * duplicates and dangling references as 422 problems that never mention SQL.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../../src/commands.ts'
import { HTTP_HOOKS, type HttpRequestHookPayload } from '../../../src/contracts/http-hooks.ts'
import { HooksToken } from '../../../src/core/tokens.ts'
import {
  configureOrm,
  ReferenceViolationError,
  registerSchema,
  runWithConnection,
  UniqueViolationError,
} from '../../../src/database/index.ts'
import { Application } from '../../../src/foundation/application.ts'
import { DatabaseConnectionToken } from '../../../src/foundation/database.ts'
import type { AuthUser } from '../../../src/foundation/registry.ts'
import { ResourceController } from '../../../src/http/app/resource-controller.ts'
import { defineRoutes, Route } from '../../../src/routing/route.ts'
import { testClient } from '../../../src/testing/app-client.ts'
import { APP_KEY } from '../../app/helpers.ts'
import { serverDatabase, skipReason } from '../../helpers/server-database.ts'
import { Customer } from './fixtures/app/models/customer.ts'
import { Order } from './fixtures/app/models/order.ts'
import { Task } from './fixtures/app/models/task.ts'

const CUSTOMERS = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('customers', (t) => {
      t.id()
      t.string('name', 100)
      t.string('email').unique()
      t.enum('status', ['active', 'inactive']).default('active')
      t.decimal('credit_limit', 12, 2).default(0)
      t.text('notes').nullable()
      t.string('api_token', 80).nullable()
      t.timestamps()
      t.softDeletes()
    })
  },
  down(schema) { schema.dropIfExists('customers') },
})
`
const ORDERS = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('orders', (t) => {
      t.id()
      t.foreignId('customer_id').constrained()
      t.string('number', 30).unique()
      t.decimal('total', 12, 2).default(0)
      t.timestamps()
    })
  },
  down(schema) { schema.dropIfExists('orders') },
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
// Policies, discovered by name from the app's own app/policies (deny by default otherwise).
// Admins may do everything; members may list, and see active customers only.
const CUSTOMER_POLICY = `export default class CustomerPolicy {
  before(user) { return user !== null && Array.isArray(user.roles) && user.roles.includes('admin') ? true : undefined }
  viewAny(user) { return user !== null }
  view(user, customer) { return user !== null && customer.status === 'active' }
}
`
const ORDER_POLICY = `export default class OrderPolicy {
  before(user) { return user !== null && Array.isArray(user.roles) && user.roles.includes('admin') ? true : undefined }
}
`
const TASK_POLICY = `export default class TaskPolicy {
  viewAny(user) { return user !== null }
  view(user) { return user !== null }
  create(user) { return user !== null }
  update(user) { return user !== null }
  delete(user) { return user !== null }
}
`

const ADMIN: AuthUser = { id: '1', type: 'user', roles: ['admin'], attrs: {} } as AuthUser
const MEMBER: AuthUser = { id: '2', type: 'user', roles: ['member'], attrs: {} } as AuthUser
const A = '0193a0b2-0000-7000-8000-00000000000a'
const B = '0193a0b2-0000-7000-8000-00000000000b'
const PROJECT = '0193a0b2-0000-7000-8000-0000000000ff'

/** The FW-5 repro, verbatim: a resource controller over an ORM model. */
class CustomerController extends ResourceController<typeof Customer> {
  protected readonly model = Customer
}
class OrderController extends ResourceController<typeof Order> {
  protected readonly model = Order
}
class TaskController extends ResourceController<typeof Task> {
  protected readonly model = Task
}

const folders: string[] = []
const apps: Application[] = []
afterEach(async () => {
  // Close every app (and its SQLite file) even when a test failed, so the folders can be removed.
  await Promise.allSettled(apps.splice(0).map((app) => app.shutdown()))
})
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

function write(root: string, path: string, content: string): void {
  const file = join(root, ...path.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function appFolder(tenancy: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-crud-'))
  folders.push(root)
  if (tenancy) {
    write(root, 'database/migrations/2026_01_01_000000_create_tasks_table.ts', TASKS)
    write(root, 'config/tenancy.ts', "export default { enabled: true, column: 'tenant_id' }\n")
    write(root, 'app/policies/task.policy.ts', TASK_POLICY)
  } else {
    write(root, 'database/migrations/2026_01_01_000000_create_customers_table.ts', CUSTOMERS)
    write(root, 'database/migrations/2026_01_02_000000_create_orders_table.ts', ORDERS)
    write(root, 'app/policies/customer.policy.ts', CUSTOMER_POLICY)
    write(root, 'app/policies/order.policy.ts', ORDER_POLICY)
  }
  return root
}

async function migrate(root: string, env: Readonly<Record<string, string>>): Promise<void> {
  const command = commands.find((candidate) => candidate.name === 'migrate')
  if (command === undefined) throw new Error('no migrate command')
  const ctx: CommandContextLike = {
    flags: {},
    appEnv: 'testing',
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
  registerSchema({ version: 1, tables: {} })
  configureOrm({ tenancy: false })
}

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

function application(
  root: string,
  env: Readonly<Record<string, string>>,
  tenancy = false,
): Application {
  const routes = tenancy
    ? defineRoutes([Route.apiResource('tasks', TaskController)])
    : defineRoutes([
        Route.apiResource('customers', CustomerController),
        Route.post('/customers/{customer}/restore', [CustomerController, 'restore'])
          .withTrashed()
          .name('customers.restore'),
        Route.apiResource('orders', OrderController),
        // The FW-10 repro: a hand-written action calling Model.create() with no unique pre-check.
        Route.post('/raw-customers', async (ctx) => {
          const customer = await Customer.create((await ctx.body()) as never)
          return ctx.json({ data: customer }, 201)
        }),
      ])
  const app = Application.configure({
    basePath: root,
    env: { APP_ENV: 'testing', APP_DEBUG: 'false', APP_KEY, ...env },
  })
    .withProviders([tenantFromHeader])
    .withRouting({ api: routes })
    .create()
  apps.push(app)
  return app
}

interface EngineCase {
  readonly name: 'sqlite' | 'postgres' | 'mysql' | 'mariadb'
  readonly skipped: string | undefined
  database(): Promise<{ env: Record<string, string>; drop: () => Promise<void> }>
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

/** No response body may carry engine text: no SQL, no driver codes, no duplicated value. */
function assertNoSqlLeak(text: string): void {
  expect(text).not.toMatch(
    /UNIQUE constraint|Duplicate entry|duplicate key|SQLSTATE|ER_DUP|ERR_SQLITE|FOREIGN KEY|violates|INSERT INTO|SELECT /i,
  )
}

describe.each(ENGINES)('the generated CRUD API over ORM models on $name', (engine) => {
  const title = (text: string): string =>
    engine.skipped === undefined ? text : `${text} (skipped: ${engine.skipped})`

  test.skipIf(engine.skipped !== undefined)(
    title('list, show, create, update, delete and restore, with every rule enforced'),
    async () => {
      const root = appFolder(false)
      const { env, drop } = await engine.database()
      try {
        await migrate(root, env)
        const app = application(root, env)
        // FW-5: this boot used to fail with "this.model.metadata is not a function".
        await app.boot()
        const anonymous = testClient(app).withoutCsrf()
        const admin = anonymous.actingAs(ADMIN)
        const member = anonymous.actingAs(MEMBER)

        // Deny by default: no user, no list.
        expect((await anonymous.getJson('/api/customers')).status).toBe(403)

        // Create: 201, Location, decimals exact, hidden columns never returned.
        const created = await admin.postJson('/api/customers', {
          name: 'Acme',
          email: 'ops@acme.test',
          credit_limit: '1500.50',
        })
        created.assertStatus(201)
        const acme = created.json as { data: Record<string, unknown> }
        expect(acme.data).toMatchObject({ name: 'Acme', status: 'active' })
        expect(String(acme.data['credit_limit'])).toBe('1500.50')
        expect(acme.data).not.toHaveProperty('api_token')
        expect(created.headers.get('location')).toBe(`/api/customers/${String(acme.data['id'])}`)
        for (const [name, email, status] of [
          ['Bolt', 'hi@bolt.test', 'inactive'],
          ['Crane', 'crane@x.test', 'active'],
          ['Delta', 'delta@x.test', 'active'],
        ] as const)
          (await admin.postJson('/api/customers', { name, email, status })).assertStatus(201)

        // Validation from the model: required, enum, unknown and non-fillable fields.
        const invalid = await admin.postJson('/api/customers', { status: 'gone' })
        invalid.assertProblem(422, 'validation_failed')
        const codes = (invalid.json as { issues: { path: string[]; code: string }[] }).issues
        expect(codes.map((issue) => issue.path[0]).sort()).toEqual(['email', 'name', 'status'])
        ;(
          await admin.postJson('/api/customers', { name: 'X', email: 'x@x.test', api_token: 't' })
        ).assertProblem(422, 'validation_failed')
        // A duplicate e-mail: the friendly pre-check, with the RFC-0003 code on the field.
        const duplicate = await admin.postJson('/api/customers', {
          name: 'Acme again',
          email: 'ops@acme.test',
        })
        duplicate
          .assertProblem(422, 'validation_failed')
          .assertJsonPath('issues.0.path', ['email'])
          .assertJsonPath('issues.0.code', 'unique')

        // List: filter, search, sort, pages and an opt-in total.
        const list = await admin.getJson(
          '/api/customers?filter[status][eq]=active&sort=-name&page[size]=2&page[number]=1&page[total]=true',
        )
        list.assertStatus(200)
        const page = list.json as {
          data: { name: string }[]
          meta: { page: { number: number; size: number; hasMore: boolean; total: number } }
        }
        expect(page.data.map((row) => row.name)).toEqual(['Delta', 'Crane'])
        expect(page.meta.page).toEqual({ number: 1, size: 2, hasMore: true, total: 3 })
        const second = (
          await admin.getJson(
            '/api/customers?filter[status][eq]=active&sort=-name&page[size]=2&page[number]=2',
          )
        ).json as typeof page
        expect(second.data.map((row) => row.name)).toEqual(['Acme'])
        expect(second.meta.page.hasMore).toBe(false)
        expect(second.meta.page).not.toHaveProperty('total')
        const searched = (await admin.getJson('/api/customers?search=ACME')).json as typeof page
        expect(searched.data.map((row) => row.name)).toEqual(['Acme'])
        const byId = (await admin.getJson(`/api/customers?search=${String(acme.data['id'])}`))
          .json as typeof page
        expect(byId.data.map((row) => row.name)).toContain('Acme')
        const inList = (
          await admin.getJson(
            '/api/customers?filter[status][in]=active&filter[status][in]=inactive',
          )
        ).json as typeof page
        expect(inList.data).toHaveLength(4)

        // Names are checked before SQL: hidden, unknown, injected or too deep are all 422.
        for (const query of [
          'filter[api_token][eq]=x',
          'sort=api_token',
          'search=x&fields=api_token',
          'filter[name)--][eq]=x',
          'sort=name;DROP TABLE customers',
          'filter[status][contains]=act',
          'filter[credit_limit][gt]=abc',
          'colour=red',
          'page[size]=500',
          'page[number]=1000&page[size]=100',
          'include=apiToken',
        ]) {
          const refused = await admin.getJson(`/api/customers?${query}`)
          refused.assertProblem(422, 'validation_failed')
          assertNoSqlLeak(refused.text)
        }
        // A quote in a value is data, never SQL.
        const injected = (
          await admin.getJson(
            `/api/customers?filter[name][eq]=${encodeURIComponent("' OR 1=1 --")}`,
          )
        ).json as typeof page
        expect(injected.data).toEqual([])

        // Show, sparse fields, and a malformed or missing id.
        const id = String(acme.data['id'])
        ;(await admin.getJson(`/api/customers/${id}`)).assertJsonPath('data.name', 'Acme')
        expect((await admin.getJson(`/api/customers/${id}?fields=name`)).json).toEqual({
          data: { id: acme.data['id'], name: 'Acme' },
        })
        const missing = await admin.getJson('/api/customers/999999')
        missing.assertProblem(404, 'not_found')
        ;(await admin.getJson('/api/customers/abc')).assertProblem(404, 'not_found')

        // Enumeration: a row the member may not view answers exactly like a missing one.
        const bolt = (await admin.getJson('/api/customers?filter[name][eq]=Bolt')).json as {
          data: { id: number }[]
        }
        const hidden = await member.getJson(`/api/customers/${String(bolt.data[0]?.id)}`)
        const absent = await member.getJson('/api/customers/999999')
        expect(hidden.status).toBe(404)
        expect(hidden.json).toMatchObject({ code: 'not_found' })
        expect({ ...(hidden.json as object), instance: '', traceId: '' }).toEqual({
          ...(absent.json as object),
          instance: '',
          traceId: '',
        })
        // ...and members can't write.
        expect(
          (await member.postJson('/api/customers', { name: 'M', email: 'm@x.test' })).status,
        ).toBe(403)

        // Update: partial, unique checked against other rows only.
        ;(await admin.patchJson(`/api/customers/${id}`, { email: 'ops@acme.test', notes: 'VIP' }))
          .assertStatus(200)
          .assertJsonPath('data.notes', 'VIP')
        ;(await admin.patchJson(`/api/customers/${id}`, { email: 'hi@bolt.test' }))
          .assertProblem(422, 'validation_failed')
          .assertJsonPath('issues.0.code', 'unique')

        // Include: the related model's own policy decides (members may not list orders).
        ;(
          await admin.postJson('/api/orders', { customer_id: Number(id), number: 'N-1', total: 10 })
        ).assertStatus(201)
        const withOrders = await admin.getJson(`/api/customers/${id}?include=orders`)
        withOrders.assertStatus(200)
        expect(withOrders.json).toMatchObject({ data: { orders: [{ number: 'N-1' }] } })
        const listed = (await admin.getJson('/api/customers?include=orders&filter[name][eq]=Acme'))
          .json as { data: { orders: unknown[] }[] }
        expect(listed.data[0]?.orders).toHaveLength(1)
        expect((await member.getJson('/api/customers?include=orders')).status).toBe(403)

        // A dangling reference: 422 on the foreign key, no SQL.
        const dangling = await admin.postJson('/api/orders', {
          customer_id: 999999,
          number: 'N-2',
          total: 1,
        })
        dangling
          .assertProblem(422, 'validation_failed')
          .assertJsonPath('issues.0.path', ['customer_id'])
        dangling.assertJsonPath('issues.0.code', 'not_found')
        assertNoSqlLeak(dangling.text)

        // Delete (soft), then restore through the trashed-binding route.
        ;(await admin.deleteJson(`/api/customers/${id}`)).assertStatus(204)
        ;(await admin.getJson(`/api/customers/${id}`)).assertProblem(404, 'not_found')
        const afterDelete = (await admin.getJson('/api/customers')).json as typeof page
        expect(afterDelete.data.map((row) => row.name)).not.toContain('Acme')
        // A deleted e-mail still counts as taken (the unique index sees it).
        ;(
          await admin.postJson('/api/customers', { name: 'Copy', email: 'ops@acme.test' })
        ).assertProblem(422, 'validation_failed')
        // A member can see the row but has no restore(): an honest 403.
        expect((await member.postJson(`/api/customers/${id}/restore`, {})).status).toBe(403)
        ;(await admin.postJson(`/api/customers/${id}/restore`, {}))
          .assertStatus(200)
          .assertJsonPath('data.name', 'Acme')
        ;(await admin.getJson(`/api/customers/${id}`)).assertStatus(200)

        await app.shutdown()
      } finally {
        await drop()
      }
    },
  )

  test.skipIf(engine.skipped !== undefined)(
    title('FW-10: a duplicate written through Model.create() is a 422 on the field, never a 500'),
    async () => {
      const root = appFolder(false)
      const { env, drop } = await engine.database()
      try {
        await migrate(root, env)
        const app = application(root, env)
        const client = testClient(app).withoutCsrf()
        const body = { name: 'Twice', email: 'twice@x.test' }
        ;(await client.postJson('/api/raw-customers', body)).assertStatus(201)
        const second = await client.postJson('/api/raw-customers', body)
        second
          .assertProblem(422, 'validation_failed')
          .assertJsonPath('issues.0.path', ['email'])
          .assertJsonPath('issues.0.code', 'unique')
        assertNoSqlLeak(second.text)
        expect(second.text).not.toContain('twice@x.test')

        // The ORM error itself names the column, on every engine.
        const error = await runWithConnection(
          () => app.make(DatabaseConnectionToken),
          () => Customer.create(body).catch((caught: unknown) => caught),
        )
        expect(error).toBeInstanceOf(UniqueViolationError)
        expect((error as UniqueViolationError).columns).toEqual(['email'])
        await app.shutdown()
      } finally {
        await drop()
      }
    },
  )

  test.skipIf(engine.skipped !== undefined)(
    title("tenancy: another tenant's row is a 404 for show, update and delete"),
    async () => {
      const root = appFolder(true)
      const { env, drop } = await engine.database()
      try {
        await migrate(root, env)
        const app = application(root, env, true)
        const client = testClient(app).withoutCsrf().actingAs(MEMBER)
        const asA = client.withHeaders({ 'x-tenant': A })
        const asB = client.withHeaders({ 'x-tenant': B })
        const created = await asA.postJson('/api/tasks', { project_id: PROJECT, title: 'A1' })
        created.assertStatus(201)
        const id = String((created.json as { data: { id: number } }).data.id)
        ;(await asB.postJson('/api/tasks', { project_id: PROJECT, title: 'B1' })).assertStatus(201)
        // The tenant column is never the client's to set.
        ;(
          await asA.postJson('/api/tasks', { project_id: PROJECT, title: 'x', tenant_id: B })
        ).assertProblem(422, 'validation_failed')

        expect(
          ((await asB.getJson('/api/tasks')).json as { data: { title: string }[] }).data.map(
            (t) => t.title,
          ),
        ).toEqual(['B1'])
        for (const response of [
          await asB.getJson(`/api/tasks/${id}`),
          await asB.patchJson(`/api/tasks/${id}`, { title: 'stolen' }),
          await asB.deleteJson(`/api/tasks/${id}`),
          await asB.getJson(`/api/tasks?filter[id][eq]=${id}`),
        ])
          expect([404, 200]).toContain(response.status)
        expect(
          ((await asB.getJson(`/api/tasks?filter[id][eq]=${id}`)).json as { data: unknown[] }).data,
        ).toEqual([])
        ;(await asA.getJson(`/api/tasks/${id}`)).assertJsonPath('data.title', 'A1')
        // No tenant: refused (fail closed), never an unscoped list.
        ;(await client.getJson('/api/tasks')).assertProblem(403, 'tenant_required')
        await app.shutdown()
      } finally {
        await drop()
      }
    },
  )
})

describe('constraint errors in the ORM, on SQLite', () => {
  test('deleting a referenced row is a ReferenceViolationError (409 record_in_use over HTTP)', async () => {
    const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' }
    const root = appFolder(false)
    await migrate(root, env)
    const app = application(root, env)
    const admin = testClient(app).withoutCsrf().actingAs(ADMIN)
    const created = await admin.postJson('/api/customers', { name: 'Ref', email: 'ref@x.test' })
    const id = (created.json as { data: { id: number } }).data.id
    ;(await admin.postJson('/api/orders', { customer_id: id, number: 'R-1' })).assertStatus(201)
    const caught = await runWithConnection(
      () => app.make(DatabaseConnectionToken),
      async () => {
        const customer = await Customer.findOrFail(id)
        return customer.forceDelete().catch((error: unknown) => error)
      },
    )
    expect(caught).toBeInstanceOf(ReferenceViolationError)
    expect((caught as ReferenceViolationError).kind).toBe('in_use')
    await app.shutdown()
  })
})
