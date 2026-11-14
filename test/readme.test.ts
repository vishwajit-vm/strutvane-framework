/**
 * The README examples, executed (only the database URL differs: in-memory instead of a file).
 * Update this file and README.md together.
 */

import { describe, expect, it } from 'vitest'
import { createApp, PermissionProviderToken } from '../src/core/index.ts'
import {
  allowAllPermissions,
  createHttpApp,
  DatabaseToken,
  defineModel,
  field,
  frameworkProvider,
  migrate,
  migrationSource,
  planMigration,
  serializeListParams,
} from '../src/index.ts'
import { createTestApp } from '../src/testing/index.ts'

const Customer = defineModel(
  'Customer',
  {
    name: field.string(120).searchable().sortable(),
    email: field.email().unique(),
    invoices: field.hasMany('Invoice'),
  },
  { tenant: true },
)

const Invoice = defineModel(
  'Invoice',
  {
    number: field.string(32).unique().searchable().sortable(),
    amount: field.decimal(12, 2).min(0).sortable().filterable(),
    status: field.enum(['draft', 'sent', 'paid']).default('draft').filterable(),
    customer: field.belongsTo('Customer').filterable(),
    notes: field.text().optional(),
  },
  { tenant: true, softDeletes: true },
)

const tenantId = '0190a000-0000-7000-8000-0000000000aa'

describe('README', () => {
  it('quick start: boots, migrates and serves the API', async () => {
    const app = createApp({
      config: {},
      providers: [
        frameworkProvider({
          database: { driver: 'sqlite', url: ':memory:' },
          models: [Customer, Invoice],
        }),
      ],
    })
    app.container.value(PermissionProviderToken, allowAllPermissions())
    await app.boot()
    const db = app.make(DatabaseToken)
    const plan = await planMigration({
      dialect: 'sqlite',
      previous: [],
      next: [Customer.definition, Invoice.definition],
    })
    await migrate(db, [migrationSource('0001_init', plan.statements)])
    const http = createHttpApp(app, { resources: [Customer, Invoice] })
    for (const path of ['/.well-known/strutvane.json', '/health', '/ready']) {
      expect((await http.request(path)).status, path).toBe(200)
    }
    // Outside APP_ENV=local, /openapi.json needs an identified caller (the `openapi` option).
    expect((await http.request('/openapi.json')).status).toBe(401)
    // Without an http.onRequest hook (auth) there is no tenant: tenant models fail closed.
    expect((await http.request('/api/v1/invoices')).status).toBe(403)
    expect(
      serializeListParams({ filter: { status: { in: ['draft', 'sent'] } }, sort: ['-amount'] }),
    ).toBe('filter%5Bstatus%5D%5Bin%5D=draft&filter%5Bstatus%5D%5Bin%5D=sent&sort=-amount')
    await app.shutdown()
  })

  it('testing: createTestApp, actingAs and the typed resource client', async () => {
    const t = await createTestApp({ resources: [Customer, Invoice] })
    const alice = t.actingAs({ id: 'u1', type: 'user', roles: [], attrs: {} }, { tenantId })
    const res = await alice.resource(Customer).create({ name: 'Acme', email: 'billing@acme.test' })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Acme')
    await t.refreshDatabase()
    await t.close()
  })
})
