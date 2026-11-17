import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../../src/contracts/index.ts'
import {
  createApp,
  createMessages,
  defineMessages,
  ErrorRegistryToken,
  EventBusToken,
  ForbiddenError,
  HooksToken,
  LoggerToken,
  PermissionProviderToken,
  ValidationError,
} from '../../src/core/index.ts'
import { connectDatabase, NotImplementedError } from '../../src/database/connect.ts'
import { type PgClientLike, type PgPoolLike, pgDatabase } from '../../src/database/drivers.ts'
import { createHttpApp } from '../../src/http/create-http-app.ts'
import {
  type ListQueryRules,
  parseListQuery,
  serializeListParams,
} from '../../src/http/list-query.ts'
import {
  allowAllPermissions,
  MissingPermissionProviderError,
  resolvePermissionProvider,
} from '../../src/http/permissions.ts'
import { defineResource } from '../../src/http/resource.ts'
import { acceptRequestId, securityHeaders } from '../../src/http/security.ts'
import {
  FRAMEWORK_ERRORS,
  registerFrameworkErrors,
  withFrameworkMessages,
} from '../../src/messages.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { frameworkProvider } from '../../src/provider.ts'
import { queryFields } from '../../src/query/fields.ts'
import { createMemoryDisk } from '../../src/storage/memory-disk.ts'
import { createTestApp } from '../../src/testing/index.ts'
import { DatabaseToken, ModelRegistryToken, StorageManagerToken } from '../../src/tokens.ts'
import { Customer, Invoice } from '../helpers/models.ts'
import { TENANT_A, TENANT_B } from '../helpers/setup.ts'

const rules: ListQueryRules = { fields: queryFields(Invoice.definition), includes: ['customer'] }
const parse = (qs: string) => parseListQuery(new URLSearchParams(qs), rules)

describe('list query protocol', () => {
  it('round-trips through the shared serializer', () => {
    const qs = serializeListParams({
      filter: {
        status: { in: ['draft', 'sent'] },
        amount: { between: ['1', '9.5'] },
        notes: { eq: undefined },
        issuedOn: { isNull: true },
      },
      sort: ['-amount', 'number'],
      page: { size: 10, cursor: 'abc', total: true },
      search: 'acme, inc',
      include: ['customer'],
    })
    expect(qs).toContain('filter%5Bstatus%5D%5Bin%5D=draft&filter%5Bstatus%5D%5Bin%5D=sent')
    const parsed = parseListQuery(new URLSearchParams(qs), rules)
    expect(parsed).toEqual({
      ok: true,
      query: {
        filter: {
          op: 'and',
          filters: [
            { op: 'between', field: 'amount', from: '1.00', to: '9.50' },
            { op: 'isNull', field: 'issuedOn' },
            { op: 'in', field: 'status', values: ['draft', 'sent'] },
          ],
        },
        sort: [
          { field: 'amount', direction: 'desc' },
          { field: 'number', direction: 'asc' },
        ],
        page: { kind: 'cursor', size: 10, cursor: 'abc' },
        search: 'acme, inc',
        include: ['customer'],
        withTotal: true,
      },
    })
    expect(serializeListParams({ page: { number: 2 } })).toBe('page%5Bnumber%5D=2')
  })

  it('reports every kind of invalid parameter', () => {
    const codes = (qs: string) => {
      const r = parse(qs)
      return r.ok ? [] : r.issues.map((i) => i.code)
    }
    expect(codes('filter[customer.name][eq]=x')).toEqual(['relation_path_unsupported'])
    expect(codes('filter[issuedOn][isNull]=false')).toEqual(['invalid_filter_value'])
    expect(codes('filter[number][contains]=')).toEqual(['invalid_filter_value'])
    expect(codes('filter[amount][between]=1')).toEqual(['invalid_filter_value'])
    expect(codes('filter[amount][eq]=1&filter[amount][eq]=2')).toEqual(['invalid_filter_value'])
    expect(
      codes(`filter[status][in]=${new Array(101).fill('draft').join('&filter[status][in]=')}`),
    ).toEqual(['invalid_filter_value'])
    expect(codes('filter[number][wat]=1')).toEqual(['operator_not_allowed'])
    expect(codes('sort=a,b,c,d,e,f')).toEqual(['too_many_sorts'])
    expect(codes('page[number]=0')).toEqual(['invalid_page_number'])
    expect(codes('page[cursor]=***')).toEqual(['invalid_cursor'])
    expect(codes('page[total]=maybe')).toEqual(['invalid_type'])
    expect(codes(`search=${'x'.repeat(201)}`)).toEqual(['too_long'])
    expect(codes('sort=amount&sort=number')).toEqual(['duplicate_parameter'])
    expect(codes(Array.from({ length: 101 }, (_, i) => `p${i}=1`).join('&'))).toEqual([
      'too_many_parameters',
    ])
    const offset = parse('page[number]=3&page[size]=5&search=%20')
    expect(offset.ok && offset.query.page).toEqual({ kind: 'offset', size: 5, number: 3 })
    expect(offset.ok && offset.query.search).toBeUndefined()
    const custom = parseListQuery(new URLSearchParams(''), {
      ...rules,
      defaultPageSize: 10,
      maxPageSize: 20,
    })
    expect(custom.ok && custom.query.page).toEqual({ kind: 'cursor', size: 10 })
  })
})

describe('messages and errors', () => {
  it('layers the framework catalog under the app catalog', () => {
    const app = createMessages({
      app: [
        defineMessages('en', { 'validation.unknown_field': 'App says: {attribute}?' }),
        defineMessages('fr', { hello: 'Bonjour' }),
      ],
    })
    const m = withFrameworkMessages(app)
    expect(m.format('validation.unknown_field', { attribute: 'X' })).toBe('App says: X?')
    expect(m.format('validation.invalid_page_size', { max: 100 })).toBe(
      'Page size must be between 1 and 100.',
    )
    expect(m.format('validation.invalid_page_size', { max: 100 }, { locale: 'fr-CA' })).toBe(
      'Page size must be between 1 and 100.',
    )
    expect(m.has('errors.record_in_use.title')).toBe(true)
    expect(m.resolve('errors.record_in_use.title')).toBe('Record in use')
    expect(m.format('nothing.here')).toBe('nothing.here')
    expect(m.locales()).toEqual(expect.arrayContaining(['en', 'fr']))
    expect(m.missingKeys('fr')).toEqual(app.missingKeys('fr'))
  })
  it('registers error codes idempotently', () => {
    const app = createApp({ config: {} })
    const registry = app.make(ErrorRegistryToken)
    registerFrameworkErrors(registry)
    registerFrameworkErrors(registry)
    for (const def of FRAMEWORK_ERRORS) expect(registry.get(def.code)?.status).toBe(def.status)
  })
})

describe('permission resolution', () => {
  it('uses the bound provider, allows all only locally or explicitly, and refuses otherwise', () => {
    const app = createApp({ config: {} })
    const warn = vi.fn()
    const logger = { ...app.make(LoggerToken), warn }
    expect(() => resolvePermissionProvider(app, { env: 'production', logger })).toThrow(
      MissingPermissionProviderError,
    )
    resolvePermissionProvider(app, { env: 'local', logger })
    resolvePermissionProvider(app, { env: 'staging', publicApi: true, logger })
    expect(warn).toHaveBeenCalledTimes(2)
    const provider = allowAllPermissions()
    app.container.value(PermissionProviderToken, provider)
    expect(resolvePermissionProvider(app, { env: 'production' })).toBe(provider)
  })

  it('createHttpApp refuses to start in production without a provider', async () => {
    const db = await connectDatabase({ driver: 'sqlite', url: ':memory:' })
    const app = createApp({
      config: {},
      providers: [frameworkProvider({ database: db, models: [Customer, Invoice] })],
    })
    await app.boot()
    expect(() => createHttpApp(app, { resources: [Customer, Invoice], env: 'production' })).toThrow(
      MissingPermissionProviderError,
    )
    const local = createHttpApp(app, {
      resources: [Customer, Invoice],
      env: 'local',
      openapi: false,
      basePath: '/api/v2/',
    })
    expect((await local.request('/openapi.json')).status).toBe(404)
    expect((await local.request('/api/v2/customers')).status).toBe(403) // tenant_required: no tenant resolved
    expect(local.openApiDocument().paths?.['/api/v2/customers']).toBeDefined()
    await app.shutdown()
  })
})

describe('security helpers', () => {
  it('adds HSTS over HTTPS only and keeps handler cache headers', async () => {
    const { Hono } = await import('hono')
    const h = new Hono()
    h.use('*', securityHeaders({ hstsMaxAge: 60 }))
    h.get('/', (c) =>
      c.text('ok', 200, {
        'cache-control': 'max-age=5',
        'content-security-policy': "default-src 'self'",
      }),
    )
    const https = await h.request('https://x.test/')
    expect(https.headers.get('strict-transport-security')).toBe('max-age=60; includeSubDomains')
    expect(https.headers.get('cache-control')).toBe('max-age=5')
    expect(https.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect((await h.request('http://x.test/')).headers.get('strict-transport-security')).toBeNull()
    expect(acceptRequestId('ok-123456', () => 'gen')).toBe('ok-123456')
    expect(acceptRequestId('bad id with spaces', () => 'gen')).toBe('gen')
    expect(acceptRequestId(undefined, () => 'gen')).toBe('gen')
  })
})

describe('provider and database connection', () => {
  it('binds the database, registry and storage, and closes on shutdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sv-prov-'))
    try {
      const memory = createMemoryDisk()
      const app = createApp({
        config: {},
        providers: [
          frameworkProvider({
            database: {
              driver: 'sqlite',
              url: `file:${join(dir, 'app.db').replaceAll('\\', '/')}`,
            },
            models: [Customer, Invoice],
            storage: { default: 'memory', disks: [memory] },
          }),
        ],
      })
      expect(() => app.make(DatabaseToken)).toThrow()
      await app.boot()
      expect(await app.make(DatabaseToken).query('SELECT 1 AS one')).toEqual([{ one: 1n }])
      expect(app.make(ModelRegistryToken).get('Invoice')).toBeDefined()
      expect(app.make(StorageManagerToken).disk()).toBe(memory)
      await app.shutdown()
    } finally {
      // libSQL may release the native file handle lazily on Windows; temp cleanup is best-effort.
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  })

  it('defaults storage to a local disk and rejects invalid model sets at boot', async () => {
    const db = await connectDatabase({ driver: 'sqlite', url: ':memory:' })
    const app = createApp({
      config: {},
      providers: [frameworkProvider({ database: db, models: [Customer, Invoice] })],
    })
    await app.boot()
    expect(app.make(StorageManagerToken).defaultDisk).toBe('local')
    await app.shutdown()
    const broken = createApp({
      config: {},
      providers: [frameworkProvider({ database: db, models: [Customer] })],
    })
    await expect(broken.boot()).rejects.toThrow(/Invalid models/)
  })

  it('opens PGlite and reports deferred drivers clearly', async () => {
    const pg = await connectDatabase({ driver: 'pglite' })
    expect(await pg.query('SELECT 1 AS one')).toEqual([{ one: 1 }])
    await pg.close()
    await pg.close() // idempotent
    await expect(connectDatabase({ driver: 'mysql' })).rejects.toBeInstanceOf(NotImplementedError)
    await expect(
      connectDatabase({ driver: 'postgres', host: 'db', auth: { kind: 'azure-entra' } }),
    ).rejects.toBeInstanceOf(NotImplementedError)
    // Creating a pool does not connect; closing it is safe.
    const pool = await connectDatabase({
      driver: 'postgres',
      url: 'postgres://u:p@127.0.0.1:1/db',
      ssl: true,
      pool: { max: 2, statementTimeoutMs: 1000 },
    })
    expect(pool.dialect).toBe('postgres')
    await pool.close()
    const discrete = await connectDatabase({
      driver: 'postgres',
      host: '127.0.0.1',
      port: 1,
      database: 'd',
      user: 'u',
      password: 'p',
      ssl: { rejectUnauthorized: true },
    })
    await discrete.close()
  })
})

describe('node-postgres adapter (connection lifecycle)', () => {
  // These fakes model only the pool/connection lifecycle (not SQL): they prove that the tenant is
  // set transaction-locally, that errors roll back, and that broken connections are destroyed.
  function fakePool(options: { failOn?: string; breakDuringQuery?: boolean } = {}) {
    const log: string[] = []
    const released: (Error | boolean | undefined)[] = []
    let errorListener: ((e: Error) => void) | undefined
    const client: PgClientLike = {
      async query<R>(sql: string, params?: unknown[]) {
        log.push(params?.length ? `${sql} ${JSON.stringify(params)}` : sql)
        if (options.breakDuringQuery && sql === 'SELECT boom')
          errorListener?.(new Error('connection terminated'))
        if (options.failOn && sql.startsWith(options.failOn)) throw new Error(`failed: ${sql}`)
        return { rows: [] as R[], rowCount: 3 }
      },
      release: (err) => released.push(err),
      on: (_e, l) => {
        errorListener = l
      },
      off: () => {
        errorListener = undefined
      },
    }
    const pool: PgPoolLike = {
      query: async <R>() => ({ rows: [{ ok: true }] as R[], rowCount: null }),
      connect: async () => client,
      end: async () => undefined,
    }
    return { pool, log, released }
  }

  it('sets the tenant with set_config(..., true) inside BEGIN/COMMIT and returns the connection', async () => {
    const { pool, log, released } = fakePool()
    const db = pgDatabase(pool)
    expect(await db.query('SELECT 1')).toEqual([{ ok: true }])
    expect(await db.execute('UPDATE x')).toBe(0)
    const n = await db.transaction(
      async (tx) => {
        await tx.query('SELECT 2')
        return tx.transaction((inner) => inner.execute('UPDATE y'))
      },
      { tenantId: TENANT_A },
    )
    expect(n).toBe(3)
    expect(log).toEqual([
      'BEGIN',
      `SELECT set_config('app.tenant_id', $1, true) ["${TENANT_A}"]`,
      'SELECT 2',
      'UPDATE y',
      'COMMIT',
    ])
    expect(released).toEqual([false])
    await db.close()
    await db.close()
  })

  it('rolls back on error and destroys a connection that broke', async () => {
    const failing = fakePool()
    await expect(
      pgDatabase(failing.pool).transaction(async () => {
        throw new Error('app error')
      }),
    ).rejects.toThrow('app error')
    expect(failing.log).toEqual(['BEGIN', 'ROLLBACK'])
    expect(failing.released).toEqual([false])

    const broken = fakePool({ breakDuringQuery: true, failOn: 'ROLLBACK' })
    await expect(
      pgDatabase(broken.pool).transaction((tx) =>
        tx.query('SELECT boom').then(() => {
          throw new Error('after break')
        }),
      ),
    ).rejects.toThrow('after break')
    expect(broken.released[0]).toBeInstanceOf(Error)

    const rollbackFails = fakePool({ failOn: 'ROLLBACK' })
    await expect(
      pgDatabase(rollbackFails.pool).transaction(async () => {
        throw new Error('x')
      }),
    ).rejects.toThrow('x')
    expect(rollbackFails.released[0]).toBeInstanceOf(Error)

    await expect(
      pgDatabase(fakePool().pool).transaction(async () => 1, { tenantId: 'nope' }),
    ).rejects.toThrow(/UUID/)
  })
})

describe('resource hooks, events and global hooks', () => {
  it('runs per-resource hooks, emits domain events and lets global hooks shape responses', async () => {
    const calls: string[] = []
    const t = await createTestApp({
      resources: [
        defineResource({
          model: Customer,
          hooks: {
            beforeList: () => {
              calls.push('beforeList')
            },
            beforeShow: () => {
              calls.push('beforeShow')
            },
            beforeCreate: (input) => ({ ...input, name: String(input['name']).trim() }),
            afterCreate: () => {
              calls.push('afterCreate')
            },
            beforeUpdate: (patch, existing) => {
              calls.push(`beforeUpdate:${existing['name']}`)
              return patch
            },
            afterUpdate: (_r, previous) => {
              calls.push(`afterUpdate:${previous['name']}`)
            },
            beforeDelete: () => {
              calls.push('beforeDelete')
            },
            afterDelete: () => {
              calls.push('afterDelete')
            },
            transformResponse: (record) => ({
              ...record,
              display: `${record['name']} <${record['email']}>`,
            }),
          },
        }),
        Invoice,
      ],
    })
    try {
      const events: string[] = []
      const bus = t.app.make(EventBusToken)
      for (const e of ['customer.created', 'customer.updated', 'customer.deleted']) {
        bus.on(e, (event) => {
          events.push(`${event.type}:${(event.payload as { tenantId: string }).tenantId}`)
        })
      }
      t.app.make(HooksToken).on(
        'resource.serialize',
        (p) => {
          const payload = p as { record: Record<string, unknown> }
          const { email: _email, ...rest } = payload.record
          return { ...payload, record: { ...rest, email: 'redacted' } }
        },
        { name: 'test.redact' },
      )
      const actor: Actor = { id: 'u', type: 'user', roles: [], attrs: {} }
      const client = t.actingAs(actor, { tenantId: TENANT_A })
      const created = await client.request<Record<string, string>>('POST', '/api/v1/customers', {
        body: { name: '  Acme  ', email: 'a@a.test' },
      })
      expect(created.body['name']).toBe('Acme')
      expect(created.body['email']).toBe('redacted')
      expect(created.body['display']).toBe('Acme <redacted>')
      const id = created.body['id'] as string
      await client.request('GET', `/api/v1/customers/${id}`)
      await client.request('GET', '/api/v1/customers')
      await client.request('PATCH', `/api/v1/customers/${id}`, { body: { name: 'Acme 2' } })
      await client.request('DELETE', `/api/v1/customers/${id}`)
      expect(calls).toEqual([
        'afterCreate',
        'beforeShow',
        'beforeList',
        'beforeUpdate:Acme',
        'afterUpdate:Acme',
        'beforeDelete',
        'afterDelete',
      ])
      expect(events).toEqual([
        `customer.created:${TENANT_A}`,
        `customer.updated:${TENANT_A}`,
        `customer.deleted:${TENANT_A}`,
      ])
    } finally {
      await t.close()
    }
  })

  it('resource.beforeWrite sees every create and update, and a refusal is the handler problem (never a 500)', async () => {
    const t = await createTestApp({ resources: [Customer, Invoice] })
    try {
      const seen: unknown[] = []
      const hooks = t.app.make(HooksToken)
      hooks.on(
        'resource.beforeWrite',
        (p) => {
          const payload = p as { type: string; action: string; input: Record<string, unknown> }
          seen.push({
            type: payload.type,
            action: payload.action,
            keys: Object.keys(payload.input),
          })
          if ('email' in payload.input && payload.action === 'update') throw new ForbiddenError()
          return undefined
        },
        { name: 'test.fieldWrite' },
      )
      const client = t.actingAs(
        { id: 'u', type: 'user', roles: [], attrs: {} },
        { tenantId: TENANT_A },
      )
      const created = await client.request<Record<string, string>>('POST', '/api/v1/customers', {
        body: { name: 'Acme', email: 'a@a.test' },
      })
      expect(created.status).toBe(201)
      const id = created.body['id'] as string
      expect(
        (await client.request('PATCH', `/api/v1/customers/${id}`, { body: { name: 'B' } })).status,
      ).toBe(200)
      const refused = await client.request<{ code: string }>('PATCH', `/api/v1/customers/${id}`, {
        body: { email: 'evil@x.test' },
      })
      expect(refused.status).toBe(403)
      expect(refused.body.code).toBe('forbidden')
      // The refused write never reached the database.
      const after = await client.request<Record<string, string>>('GET', `/api/v1/customers/${id}`)
      expect(after.body['email']).toBe('a@a.test')
      expect(seen).toEqual([
        { type: 'customer', action: 'create', keys: ['name', 'email'] },
        { type: 'customer', action: 'update', keys: ['name'] },
        { type: 'customer', action: 'update', keys: ['email'] },
      ])
    } finally {
      await t.close()
    }
  })

  it('a Strutvane error thrown by any hook handler keeps its status (serialize, beforeQuery)', async () => {
    const t = await createTestApp({ resources: [Customer, Invoice] })
    try {
      const hooks = t.app.make(HooksToken)
      const types: unknown[] = []
      hooks.on(
        'resource.serialize',
        (p) => {
          types.push((p as { type?: unknown }).type)
          return undefined
        },
        { name: 'test.type' },
      )
      const client = t.actingAs(
        { id: 'u', type: 'user', roles: [], attrs: {} },
        { tenantId: TENANT_A },
      )
      await client.request('POST', '/api/v1/customers', {
        body: { name: 'Acme', email: 'a@a.test' },
      })
      expect(types).toEqual(['customer'])
      hooks.on(
        'resource.beforeQuery',
        () => {
          throw new ValidationError([{ path: ['query'], code: 'invalid_filter' }])
        },
        { name: 'test.refuse' },
      )
      const res = await client.request<{ code: string }>('GET', '/api/v1/customers')
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('validation_failed')
    } finally {
      await t.close()
    }
  })

  it('hooks reach other models, the request scope and the app (e.g. totals, storage clean-up)', async () => {
    const t = await createTestApp({
      resources: [
        defineResource({
          model: Customer,
          hooks: {
            afterCreate: async (record, ctx) => {
              expect(ctx.app.make(StorageManagerToken).defaultDisk).toBeTypeOf('string')
              await ctx.repositoryFor('Invoice').create(
                {
                  number: `WELCOME-${String(record['name'])}`,
                  amount: '0.00',
                  customer: record.id,
                },
                ctx.scope,
              )
            },
          },
        }),
        Invoice,
      ],
    })
    try {
      const client = t.actingAs(
        { id: 'u', type: 'user', roles: [], attrs: {} },
        { tenantId: TENANT_A },
      )
      const res = await client.request('POST', '/api/v1/customers', {
        body: { name: 'Acme', email: 'a@a.test' },
      })
      expect(res.status).toBe(201)
      const list = await client.request<{ data: { number: string }[] }>('GET', '/api/v1/invoices')
      expect(list.body.data.map((i) => i.number)).toEqual(['WELCOME-Acme'])
      // The scope carries the request's tenant: another tenant sees nothing.
      const other = t.actingAs(
        { id: 'u', type: 'user', roles: [], attrs: {} },
        { tenantId: TENANT_B },
      )
      expect(
        (await other.request<{ data: unknown[] }>('GET', '/api/v1/invoices')).body.data,
      ).toEqual([])
    } finally {
      await t.close()
    }
  })

  it('validates resource includes and disabled routes', async () => {
    await expect(
      createTestApp({
        resources: [defineResource({ model: Customer, includes: ['email'] }), Invoice],
      }),
    ).rejects.toThrow(/not a belongsTo field or hasMany relation/)
    const t = await createTestApp({
      resources: [
        defineResource({ model: Customer, routes: { delete: false, create: false } }),
        Invoice,
      ],
    })
    try {
      const client = t.actingAs(
        { id: 'u', type: 'user', roles: [], attrs: {} },
        { tenantId: TENANT_A },
      )
      expect((await client.request('POST', '/api/v1/customers', { body: {} })).status).toBe(404)
    } finally {
      await t.close()
    }
  })
})

describe('testing helpers', () => {
  const Team = defineModel(
    'Team',
    { name: field.string(20).min(3), members: field.hasMany('Member') },
    { tenant: true },
  )
  const Member = defineModel(
    'Member',
    {
      team: field.belongsTo('Team'),
      email: field.email(),
      age: field.integer().min(18).max(99),
      score: field.decimal(5, 1).optional(),
      big: field.bigInteger(),
      ratio: field.float(),
      active: field.boolean(),
      role: field.enum(['owner', 'member']),
      joined: field.date(),
      seen: field.datetime(),
      meta: field.json(),
      site: field.url(),
      ref: field.uuid(),
      bio: field.text(),
    },
    { tenant: true },
  )

  it('factories build valid records, create parents and respect tenants and state', async () => {
    const t = await createTestApp({ resources: [Team, Member], dialect: 'postgres' })
    try {
      const members = await t
        .factory(Member, { tenantId: TENANT_A })
        .state({ role: 'owner' })
        .count(2)
        .createMany()
      expect(members).toHaveLength(2)
      expect(members[0]).toMatchObject({ role: 'owner', active: expect.any(Boolean) })
      expect(t.factory(Team).make()).toHaveProperty('name')
      const team = await t.factory(Team).forTenant(TENANT_A).create()
      expect(team.name.length).toBeGreaterThanOrEqual(3)
      expect(() => t.factory(Team).count(0)).toThrow(RangeError)
      const listed = await t
        .actingAs({ id: 'u', type: 'user', roles: [], attrs: {} }, { tenantId: TENANT_A })
        .resource(Member)
        .list()
      expect(listed.body.data).toHaveLength(2)
      await t.refreshDatabase()
      expect(await t.repository('Member').count(undefined, { tenantId: TENANT_A })).toBe(0)
      expect(await t.repository(Team).count(undefined, { tenantId: TENANT_A })).toBe(0)
    } finally {
      await t.close()
    }
  })

  it('the typed resource client covers every route', async () => {
    const t = await createTestApp({ resources: [Customer, Invoice] })
    try {
      const c = t.actingAs({ id: 'u', type: 'user', roles: [], attrs: {} }, { tenantId: TENANT_A })
      const created = await c.resource(Customer).create({ name: 'A', email: 'a@a.test' } as never)
      const id = (created.body as { id: string }).id
      expect((await c.resource(Customer).show(id)).status).toBe(200)
      expect((await c.resource(Customer).update(id, { name: 'B' } as never)).status).toBe(200)
      expect((await c.resource(Customer).list()).status).toBe(200)
      expect((await c.resource(Customer).delete(id)).status).toBe(204)
      expect((await c.resource(Customer).restore(id)).status).toBe(404)
      expect(
        (await t.request('GET', '/health', { query: new URLSearchParams({ a: '1' }) })).body,
      ).toEqual({ status: 'ok' })
      const text = await t.request('POST', '/api/v1/customers', {
        body: 'not json',
        headers: { 'content-type': 'text/plain' },
      })
      expect(text.status).toBe(415)
    } finally {
      await t.close()
    }
  })
})
