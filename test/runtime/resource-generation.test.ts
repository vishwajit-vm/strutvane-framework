/**
 * `node strut migrate` generates the CRUD API (acceptance FW-4, 2026-11-20): after
 * `make:migration create_products_table` and `migrate`, the demo app had no
 * `routes/resources.gen.ts`, `route:list` showed 4 routes and `GET /api/products` was a 404.
 *
 * Proven here on a skeleton-shaped app: the machine-owned routes file is written and linked into
 * `routes/api.ts` once, the DX contract's `registered:` line is printed for new resources only,
 * a second migrate changes nothing, the developer's files win (own controller, opt-out, removed
 * link), internal tables never get an API, and the generated routes serve real requests (admins
 * only until the app writes a policy, deny by default).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../src/commands.ts'
import { configureOrm, registerSchema } from '../../src/database/index.ts'
import { Application } from '../../src/foundation/application.ts'
import type { AuthUser } from '../../src/foundation/registry.ts'
import { defineRoutes, type RouteEntry } from '../../src/routing/route.ts'
import { testClient } from '../../src/testing/app-client.ts'
import { APP_KEY } from '../app/helpers.ts'

const SRC = pathToFileURL(join(import.meta.dirname, '..', '..', 'src')).href
const migration = (body: string): string => `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
${body}
  },
  down(schema) {},
})
`
const CUSTOMERS = migration(`    schema.create('customers', (t) => {
      t.id()
      t.string('name', 100)
      t.string('email').unique()
      t.timestamps()
      t.softDeletes()
    })`)
const ORDER_ITEMS = migration(`    schema.create('order_items', (t) => {
      t.id()
      t.string('sku', 40)
      t.integer('quantity').default(1)
    })`)
const USERS = migration(`    schema.create('users', (t) => {
      t.id()
      t.string('name')
      t.string('email').unique()
    })`)
const FILLABLE: Readonly<Record<string, string>> = {
  users: "['name', 'email']",
  customers: "['name', 'email']",
  order_items: "['sku', 'quantity']",
}
const model = (name: string, table: string, extra = ''): string =>
  `import { Model } from '${SRC}/database/index.ts'

export class ${name} extends Model('${table}', { fillable: ${FILLABLE[table] ?? '[]'} }) {${extra}}
`
const API_ROUTES = `// API routes, served under /api.
import { defineRoutes, Route } from '@strutvane/framework'
import { HealthController } from '../app/http/controllers/health.controller.ts'

export default defineRoutes([Route.get('/health', HealthController).name('api.health')])
`

const ADMIN = { id: '1', type: 'user', roles: ['admin'], attrs: {} } as AuthUser
const MEMBER = { id: '2', type: 'user', roles: ['member'], attrs: {} } as AuthUser
const ENV = { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' }

const folders: string[] = []
const apps: Application[] = []
afterEach(async () => {
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

function read(root: string, path: string): string {
  return readFileSync(join(root, ...path.split('/')), 'utf8')
}

/** A skeleton-shaped app: routes/api.ts as `create-strutvane` writes it, plus models. */
function appFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-gen-'))
  folders.push(root)
  write(root, 'routes/api.ts', API_ROUTES)
  write(root, 'config/api.ts', "export default { prefix: '/api' }\n")
  write(root, 'database/migrations/2026_01_01_000000_create_users_table.ts', USERS)
  write(root, 'database/migrations/2026_01_02_000000_create_customers_table.ts', CUSTOMERS)
  write(root, 'app/models/user.ts', model('User', 'users'))
  write(root, 'app/models/customer.ts', model('Customer', 'customers'))
  return root
}

interface Output {
  readonly success: string[]
  readonly info: string[]
  readonly warn: string[]
}

async function migrate(root: string): Promise<Output> {
  const command = commands.find((candidate) => candidate.name === 'migrate')
  if (command === undefined) throw new Error('no migrate command')
  const output: Output = { success: [], info: [], warn: [] }
  const ctx: CommandContextLike = {
    flags: {},
    appEnv: 'testing',
    services: { env: { ...ENV, APP_ENV: 'testing', DB_MIGRATION_REPLAY_TIMEOUT: '2min' } },
    requireProject: () => ({ root }),
    out: {
      line: () => undefined,
      success: (text: string) => output.success.push(text),
      info: (text: string) => output.info.push(text),
      warn: (text: string) => output.warn.push(text),
      table: () => undefined,
    },
  }
  await command.run(ctx)
  registerSchema({ version: 1, tables: {} })
  configureOrm({ tenancy: false })
  return output
}

describe('migrate generates the CRUD API (FW-4)', () => {
  test('writes routes/resources.gen.ts, links it once, and announces new resources', async () => {
    const root = appFolder()
    const first = await migrate(root)
    expect(first.success).toContain(
      'registered: API /api/customers · UI /customers · menu "Customers"',
    )
    // Identity tables never get an auto API (security review F-01).
    expect(first.success.join('\n')).not.toContain('/api/users')
    const generated = read(root, 'routes/resources.gen.ts')
    expect(generated).toContain("import { Customer } from '../app/models/customer.ts'")
    expect(generated).toContain('const CustomerController = resourceController(Customer)')
    expect(generated).toContain("Route.apiResource('customers', CustomerController)")
    expect(generated).toContain("Route.post('/customers/{customer}/restore'")
    expect(generated).not.toContain('users')
    const api = read(root, 'routes/api.ts')
    expect(api).toContain("import resources from './resources.gen.ts'")
    expect(api).toContain('...resources,')
    expect(first.info).toEqual(
      expect.arrayContaining(['Updated routes/resources.gen.ts', 'Updated routes/api.ts']),
    )

    // Idempotent: nothing new, nothing written, nothing announced.
    const second = await migrate(root)
    expect(second.success.filter((line) => line.startsWith('registered:'))).toEqual([])
    expect(second.info.filter((line) => line.includes('routes/'))).toEqual([])
    expect(read(root, 'routes/resources.gen.ts')).toBe(generated)

    // A new table: only it is announced; a dashed path gets an explicit parameter name.
    write(root, 'database/migrations/2026_01_03_000000_create_order_items_table.ts', ORDER_ITEMS)
    write(root, 'app/models/order-item.ts', model('OrderItem', 'order_items'))
    const third = await migrate(root)
    expect(third.success.filter((line) => line.startsWith('registered:'))).toEqual([
      'registered: API /api/order-items · UI /order-items · menu "Order items"',
    ])
    expect(read(root, 'routes/resources.gen.ts')).toContain(
      "Route.apiResource('order-items', OrderItemController, { parameter: 'order_item' })",
    )
  })

  test("the developer's files win: own controller, opt-out, and a removed link stays removed", async () => {
    const root = appFolder()
    write(
      root,
      'app/http/controllers/customer.controller.ts',
      'export class CustomerController {}\n',
    )
    write(root, 'app/models/user.ts', model('User', 'users'))
    await migrate(root)
    const generated = read(root, 'routes/resources.gen.ts')
    expect(generated).toContain(
      "import { CustomerController } from '../app/http/controllers/customer.controller.ts'",
    )
    expect(generated).not.toContain('resourceController(Customer)')

    // Opt out with `static readonly api = false`.
    write(
      root,
      'app/models/customer.ts',
      model('Customer', 'customers', '\n  static readonly api = false\n'),
    )
    await migrate(root)
    expect(read(root, 'routes/resources.gen.ts')).not.toContain('customers')

    // The developer unlinks the generated routes: migrate never adds them back.
    write(root, 'routes/api.ts', API_ROUTES)
    await migrate(root)
    expect(read(root, 'routes/api.ts')).toBe(API_ROUTES)
  })

  test('an api.ts of another shape is left alone, with the lines to add printed', async () => {
    const root = appFolder()
    const custom =
      "import { defineRoutes } from '@strutvane/framework'\nconst routes = defineRoutes([])\nexport default routes\n"
    write(root, 'routes/api.ts', custom)
    const output = await migrate(root)
    expect(read(root, 'routes/api.ts')).toBe(custom)
    expect(output.warn.join('\n')).toContain("import resources from './resources.gen.ts'")
    expect(existsSync(join(root, 'routes', 'resources.gen.ts'))).toBe(true)
  })

  test('the generated routes serve requests: admins only until a policy exists', async () => {
    const root = appFolder()
    await migrate(root)
    // Load the generated file as the app would, with the package name pointed at this checkout.
    const source = read(root, 'routes/resources.gen.ts').replace(
      "from '@strutvane/framework'",
      `from '${SRC}/index.ts'`,
    )
    write(root, 'routes/resources.loaded.ts', source)
    const loaded = (await import(
      pathToFileURL(join(root, 'routes', 'resources.loaded.ts')).href
    )) as {
      default: readonly RouteEntry[]
    }
    const app = Application.configure({
      basePath: root,
      env: { APP_ENV: 'testing', APP_KEY, ...ENV },
    })
      .withRouting({ api: defineRoutes([...loaded.default]) })
      .create()
    apps.push(app)
    await app.boot()
    const client = testClient(app).withoutCsrf()
    // Signed out: the `auth` middleware answers first.
    expect((await client.getJson('/api/customers')).status).toBe(401)
    // Signed in without a policy file: deny by default, except admins.
    expect((await client.actingAs(MEMBER).getJson('/api/customers')).status).toBe(403)
    const admin = client.actingAs(ADMIN)
    ;(await admin.postJson('/api/customers', { name: 'Acme', email: 'a@acme.test' })).assertStatus(
      201,
    )
    const list = await admin.getJson('/api/customers')
    list.assertStatus(200)
    expect(list.json).toMatchObject({ data: [{ name: 'Acme' }], meta: { page: { number: 1 } } })
    const id = String((list.json as { data: { id: number }[] }).data[0]?.id)
    ;(await admin.deleteJson(`/api/customers/${id}`)).assertStatus(204)
    ;(await admin.postJson(`/api/customers/${id}/restore`, {})).assertStatus(200)

    // A policy file wins over the admin-only default.
    write(
      root,
      'app/policies/customer.policy.ts',
      'export default class CustomerPolicy { viewAny(user) { return user !== null } }\n',
    )
    const withPolicy = Application.configure({
      basePath: root,
      env: { APP_ENV: 'testing', APP_KEY, ...ENV },
    })
      .withRouting({ api: defineRoutes([...loaded.default]) })
      .create()
    apps.push(withPolicy)
    ;(await testClient(withPolicy).actingAs(MEMBER).getJson('/api/customers')).assertStatus(200)
  })
})
