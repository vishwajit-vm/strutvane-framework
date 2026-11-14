/**
 * Attack-style regression tests for the resource API: hidden fields, write-side policy checks,
 * hook widening, query cost, filter injection, reference probing, anonymous discovery, proxy
 * headers and client addresses. Every test is named after the attack it proves impossible.
 */
import type { Actor, PermissionProvider, QueryFilter, ResourceRef } from '@strutvane/contracts'
import { HTTP_HOOKS } from '@strutvane/contracts'
import { createApp, createLogger, HooksToken, PermissionProviderToken } from '@strutvane/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_STATEMENT_TIMEOUT_MS, pgPoolOptions } from '../../src/database/connect.ts'
import { createHttpApp } from '../../src/http/create-http-app.ts'
import { allowAllPermissions } from '../../src/http/permissions.ts'
import {
  clientAddressOf,
  forwardedProtocol,
  parsePublicUrl,
  trustedHops,
} from '../../src/http/proxy.ts'
import { defineResource, resolveResources } from '../../src/http/resource.ts'
import { route } from '../../src/http/route.ts'
import { defineModel, type ModelDefinition } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createModelRegistry } from '../../src/model/registry.ts'
import { modelSchemas } from '../../src/model/schemas.ts'
import { sensitiveFieldKeys } from '../../src/model/sensitive-keys.ts'
import { frameworkProvider } from '../../src/provider.ts'
import { bindFilter } from '../../src/query/bind.ts'
import { clientQueryFields, queryFields } from '../../src/query/fields.ts'
import { resolveSort, SortError } from '../../src/query/sort.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { DIALECTS } from '../helpers/engines.ts'
import { Customer, Invoice } from '../helpers/models.ts'
import { TENANT_A } from '../helpers/setup.ts'

const BASE = '/api/v1'

const Account = defineModel('Account', {
  name: field.string(80).filterable().sortable(),
  owner: field.string(40).filterable(),
  apiSecret: field.string(80).hidden().optional(),
  taxId: field.string(20).sensitive().optional(),
})
const Note = defineModel('Note', {
  body: field.string(200),
  account: field.belongsTo('Account').optional(),
})

const person = (id: string): Actor => ({ id, type: 'user', roles: [], attrs: {} })

interface Problem {
  status: number
  code: string
  issues?: { path: (string | number)[]; code: string }[]
}

/** Rows belong to their `owner`; notes are unrestricted. Records every `can` call. */
function ownerPolicy() {
  const calls: { action: string; record?: Record<string, unknown> }[] = []
  const provider: PermissionProvider = {
    async can(_actor, action, resource?: ResourceRef) {
      calls.push({
        action,
        ...(resource?.record ? { record: resource.record as Record<string, unknown> } : {}),
      })
      return { allowed: true, reason: 'test' }
    },
    async filterFor(_actor, _action, type): Promise<QueryFilter> {
      return type === 'account'
        ? { op: 'eq', field: 'owner', value: { $actor: 'id' } }
        : { op: 'true' }
    },
  }
  return { provider, calls }
}

describe.each(DIALECTS)('resource API attacks on %s', (dialect) => {
  let t: TestApp
  let calls: ReturnType<typeof ownerPolicy>['calls']
  beforeEach(async () => {
    const policy = ownerPolicy()
    calls = policy.calls
    t = await createTestApp({
      dialect,
      resources: [defineResource(Account, { pageSize: { max: 20 } }), Note],
      permissions: policy.provider,
    })
  })
  afterEach(async () => {
    await t?.close()
  })
  const alice = () => t.actingAs(person('alice'))
  const bob = () => t.actingAs(person('bob'))
  const createAccount = async (owner = 'alice') => {
    const res = await t
      .actingAs(person(owner))
      .request<{ id: string }>('POST', `${BASE}/accounts`, { body: { name: `A-${owner}`, owner } })
    expect(res.status).toBe(201)
    return res.body.id
  }

  it('client cannot write a hidden field (create or update)', async () => {
    const created = await alice().request<Problem>('POST', `${BASE}/accounts`, {
      body: { name: 'x', owner: 'alice', apiSecret: 'chosen-by-client' },
    })
    expect(created.status).toBe(422)
    expect(created.body.issues).toEqual([
      expect.objectContaining({ path: ['apiSecret'], code: 'unknown_field' }),
    ])
    const id = await createAccount()
    const patched = await alice().request<Problem>('PATCH', `${BASE}/accounts/${id}`, {
      body: { apiSecret: 'x' },
    })
    expect(patched.status).toBe(422)
    expect(patched.body.issues?.[0]).toMatchObject({ path: ['apiSecret'], code: 'unknown_field' })
    expect(Object.keys(modelSchemas(Account.definition).create.shape)).not.toContain('apiSecret')
    expect(Object.keys(modelSchemas(Account.definition).update.shape)).not.toContain('apiSecret')
  })

  it('client cannot filter, sort or search on a hidden field', async () => {
    await createAccount()
    const res = await alice().request<Problem>(
      'GET',
      `${BASE}/accounts?filter[apiSecret][eq]=x&sort=apiSecret`,
    )
    expect(res.status).toBe(422)
    expect(res.body.issues?.map((i) => i.code).sort()).toEqual([
      'filter_not_allowed',
      'sort_not_allowed',
    ])
    const tree = await alice().request<Problem>('POST', `${BASE}/accounts/query`, {
      body: { filter: { op: 'isNotNull', field: 'apiSecret' } },
    })
    expect(tree.status).toBe(422)
    expect(tree.body.issues?.[0]?.code).toBe('filter_not_allowed')
  })

  it('update cannot move a row outside the actor policy scope', async () => {
    const id = await createAccount()
    const moved = await alice().request<Problem>('PATCH', `${BASE}/accounts/${id}`, {
      body: { owner: 'bob' },
    })
    expect(moved.status).toBe(403)
    expect(moved.body.code).toBe('FORBIDDEN')
    // rolled back: still alice's, still invisible to bob
    expect(
      (await alice().request<{ owner: string }>('GET', `${BASE}/accounts/${id}`)).body.owner,
    ).toBe('alice')
    expect((await bob().request('GET', `${BASE}/accounts/${id}`)).status).toBe(404)
  })

  it('create cannot forge a row outside the actor policy scope', async () => {
    const forged = await alice().request<Problem>('POST', `${BASE}/accounts`, {
      body: { name: 'forged', owner: 'bob' },
    })
    expect(forged.status).toBe(403)
    expect((await bob().request<{ data: unknown[] }>('GET', `${BASE}/accounts`)).body.data).toEqual(
      [],
    )
  })

  it('record-level authorization of an update sees the row as it would be after the change', async () => {
    const id = await createAccount()
    await alice().request('PATCH', `${BASE}/accounts/${id}`, { body: { name: 'renamed' } })
    const update = calls.filter((c) => c.action === 'account.update' && c.record)
    expect(update.at(-1)?.record).toMatchObject({ id, owner: 'alice', name: 'renamed' })
  })

  it('beforeQuery hook cannot widen the policy filter (it can only narrow it)', async () => {
    const id = await createAccount()
    const hooks = t.app.make(HooksToken)
    let hooked: QueryFilter = { op: 'true' }
    hooks.on('resource.beforeQuery', (p) => ({ ...(p as object), filter: hooked }), {
      name: 'test.widen',
    })
    expect((await bob().request('GET', `${BASE}/accounts/${id}`)).status).toBe(404)
    expect((await bob().request<{ data: unknown[] }>('GET', `${BASE}/accounts`)).body.data).toEqual(
      [],
    )
    hooked = { op: 'false' }
    expect((await alice().request('GET', `${BASE}/accounts/${id}`)).status).toBe(404)
  })

  it('create cannot reference a row the actor may not view', async () => {
    const aliceAccount = await createAccount('alice')
    const probe = await bob().request<Problem>('POST', `${BASE}/notes`, {
      body: { body: 'x', account: aliceAccount },
    })
    expect(probe.status).toBe(422)
    expect(probe.body.issues?.[0]).toMatchObject({ path: ['account'], code: 'not_found' })
    const own = await alice().request('POST', `${BASE}/notes`, {
      body: { body: 'x', account: aliceAccount },
    })
    expect(own.status).toBe(201)
    const note = (own.body as { id: string }).id
    const relink = await bob().request<Problem>('PATCH', `${BASE}/notes/${note}`, {
      body: { account: aliceAccount },
    })
    expect(relink.status).toBe(422)
  })

  it('malformed filter trees are 422 invalid_filter, never a server error', async () => {
    for (const filter of [
      5,
      'x',
      [],
      { op: 'not' },
      { op: 'and', filters: [null] },
      { op: 'or', filters: [1, { op: 'true' }] },
    ]) {
      const res = await alice().request<Problem>('POST', `${BASE}/accounts/query`, {
        body: { filter },
      })
      expect(res.status, JSON.stringify(filter)).toBe(422)
      expect(res.body.issues?.[0]?.code).toBe('invalid_filter')
    }
  })

  it('client filters cannot probe actor attributes with $actor references', async () => {
    const res = await alice().request<Problem>('POST', `${BASE}/accounts/query`, {
      body: { filter: { op: 'eq', field: 'owner', value: { $actor: 'attrs.internal' } } },
    })
    expect(res.status).toBe(422)
    expect(res.body.issues?.[0]?.code).toBe('invalid_filter_value')
  })

  it('clients cannot force deep offsets, total counts or oversized pages', async () => {
    const deep = await alice().request<Problem>(
      'GET',
      `${BASE}/accounts?page[number]=600&page[size]=20`,
    )
    expect(deep.status).toBe(422)
    expect(deep.body.issues?.[0]).toMatchObject({
      path: ['query', 'page', 'number'],
      code: 'page_too_deep',
    })
    expect(
      (await alice().request('GET', `${BASE}/accounts?page[number]=500&page[size]=20`)).status,
    ).toBe(200)
    const total = await alice().request<Problem>('GET', `${BASE}/accounts?page[total]=true`)
    expect(total.body.issues?.[0]?.code).toBe('total_not_allowed')
    const body = await alice().request<Problem>('POST', `${BASE}/accounts/query`, {
      body: { page: { number: 10_001, size: 1 }, total: true },
    })
    expect(body.body.issues?.map((i) => i.code).sort()).toEqual([
      'page_too_deep',
      'total_not_allowed',
    ])
    const big = await alice().request<Problem>('POST', `${BASE}/accounts/query`, {
      body: { page: { size: 50 } },
    })
    expect(big.status).toBe(422)
    expect(big.body.issues?.[0]).toMatchObject({ code: 'invalid_page_size' })
  })
})

describe('includes, discovery and custom routes', () => {
  let t: TestApp
  afterEach(async () => {
    await t?.close()
  })

  it('show deduplicates includes and caps their number', async () => {
    t = await createTestApp({
      resources: [defineResource(Invoice, { includes: ['customer'] }), Customer],
    })
    const a = t.actingAs(person('u'), { tenantId: TENANT_A })
    const customer = await a.request<{ id: string }>('POST', `${BASE}/customers`, {
      body: { name: 'C', email: 'c@c.test' },
    })
    const inv = await a.request<{ id: string }>('POST', `${BASE}/invoices`, {
      body: { number: '1', amount: '1', customer: customer.body.id },
    })
    const twice = await a.request<{ included: Record<string, unknown> }>(
      'GET',
      `${BASE}/invoices/${inv.body.id}?include=customer,customer`,
    )
    expect(twice.status).toBe(200)
    expect(Object.keys(twice.body.included)).toEqual(['customer'])
    const many = await a.request<Problem>(
      'GET',
      `${BASE}/invoices/${inv.body.id}?include=${Array.from({ length: 11 }, (_, i) => `r${i}`).join(',')}`,
    )
    expect(many.status).toBe(422)
    expect(many.body.issues?.[0]?.code).toBe('too_many_includes')
  })

  it('anonymous callers do not discover resources or the API schema', async () => {
    const provider: PermissionProvider = {
      can: async (actor) => ({ allowed: actor !== null, reason: 'test' }),
      filterFor: async () => ({ op: 'true' }),
    }
    t = await createTestApp({ resources: [Customer, Invoice], permissions: provider })
    const anon = await t.request<{ resources: unknown[] }>('GET', '/.well-known/strutvane.json')
    expect(anon.body.resources).toEqual([])
    expect((await t.request('GET', '/openapi.json')).status).toBe(401)
    const known = await t
      .actingAs(person('u'))
      .request<{ resources: unknown[] }>('GET', '/.well-known/strutvane.json')
    expect(known.body.resources).toHaveLength(2)
  })

  it('the OpenAPI document is public only when chosen (or in local development)', async () => {
    t = await createTestApp({ resources: [Customer, Invoice], http: { openapi: 'public' } })
    expect((await t.request('GET', '/openapi.json')).status).toBe(200)
    await t.close()
    t = await createTestApp({ resources: [Customer, Invoice], http: { env: 'local' } })
    expect((await t.request('GET', '/openapi.json')).status).toBe(200)
    await t.close()
    t = await createTestApp({ resources: [Customer, Invoice], http: { openapi: false } })
    expect((await t.actingAs(person('u')).request('GET', '/openapi.json')).status).toBe(404)
  })

  it('custom route json() refuses non-JSON bodies (no cross-site form posts as JSON)', async () => {
    t = await createTestApp({
      resources: [Customer, Invoice],
      http: {
        routes: [route.post('/echo', { public: true, handler: async (c) => c.json() })],
      },
    })
    const form = await t.request<Problem>('POST', `${BASE}/echo`, {
      body: '{"a":1}',
      headers: { 'content-type': 'text/plain' },
    })
    expect(form.status).toBe(415)
    const json = await t.request('POST', `${BASE}/echo`, { body: { a: 1 } })
    expect(json.body).toEqual({ a: 1 })
  })
})

describe('model definitions that would expose hidden values', () => {
  it('defineModel rejects hidden fields that are filterable, sortable or searchable', () => {
    expect(() => defineModel('X', { s: field.string().hidden().filterable() })).toThrow(
      /filterable/,
    )
    expect(() => defineModel('X', { s: field.string().hidden().sortable() })).toThrow(/sortable/)
    expect(() => defineModel('X', { s: field.string().hidden().searchable() })).toThrow(
      /searchable/,
    )
  })

  it('hand-written definitions are checked too, and every query layer ignores hidden fields', () => {
    const plain: ModelDefinition = {
      ...Account.definition,
      fields: {
        ...Account.definition.fields,
        apiSecret: {
          ...(Account.definition.fields['apiSecret'] as ModelDefinition['fields'][string]),
          sortable: true,
          searchable: true,
          filterOperators: ['eq'],
        },
      },
    }
    expect(() => createModelRegistry([plain])).toThrow(/apiSecret is hidden/)
    expect(clientQueryFields(plain).has('apiSecret')).toBe(false)
    expect(() =>
      bindFilter(
        { op: 'eq', field: 'apiSecret', value: 'x' },
        { fields: queryFields(plain), operators: 'declared', actor: null },
      ),
    ).toThrow(/non-filterable/)
    expect(() =>
      resolveSort([{ field: 'apiSecret', direction: 'asc' }], queryFields(plain)),
    ).toThrow(SortError)
    const HiddenRef = defineModel('Ref', { account: field.belongsTo('Account').hidden() })
    expect(() => resolveResources([defineResource(HiddenRef, { includes: ['account'] })])).toThrow(
      /hidden/,
    )
  })
})

describe('client address, proxies and request ids', () => {
  let t: TestApp
  let seen: (string | undefined)[]
  const boot = async (http: Parameters<typeof createTestApp>[0]['http'] = {}) => {
    t = await createTestApp({ resources: [Customer, Invoice], http })
    seen = []
    t.app.make(HooksToken).on(
      HTTP_HOOKS.request,
      (p) => {
        seen.push((p as { clientAddress?: string }).clientAddress)
        return undefined
      },
      { name: 'test.seen' },
    )
  }
  afterEach(async () => {
    await t?.close()
  })

  it('X-Forwarded-For cannot spoof the client address without trustProxy', async () => {
    await boot()
    const headers = { 'x-forwarded-for': '6.6.6.6' }
    await t.http.request('/health', { headers }, { clientAddress: '203.0.113.9' })
    await t.http.request(
      '/health',
      { headers },
      { incoming: { socket: { remoteAddress: '::ffff:10.0.0.1' } } },
    )
    await t.http.request('/health', { headers })
    expect(seen).toEqual(['203.0.113.9', '10.0.0.1', undefined])
  })

  it('with trustProxy the nearest trusted X-Forwarded-For hop is the client', async () => {
    await boot({ trustProxy: 1 })
    await t.http.request(
      '/health',
      { headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' } },
      { incoming: { socket: { remoteAddress: '10.0.0.2' } } },
    )
    expect(seen).toEqual(['198.51.100.7'])
  })

  it('X-Request-Id and X-Forwarded-Proto are believed only from a trusted proxy', async () => {
    await boot()
    const spoof = { 'x-request-id': 'req-12345678', 'x-forwarded-proto': 'https' }
    const plain = await t.http.request('/health', { headers: spoof })
    expect(plain.headers.get('x-request-id')).not.toBe('req-12345678')
    expect(plain.headers.get('strict-transport-security')).toBeNull()
    await t.close()
    await boot({ trustProxy: true })
    const proxied = await t.http.request('/health', { headers: spoof })
    expect(proxied.headers.get('x-request-id')).toBe('req-12345678')
    expect(proxied.headers.get('strict-transport-security')).toContain('max-age=')
    await t.close()
    await boot({ publicUrl: 'https://app.example.test' })
    expect((await t.http.request('/health')).headers.get('strict-transport-security')).toContain(
      'max-age=',
    )
  })

  it('http.onResponse gets the route template, never a raw unmatched path', async () => {
    await boot()
    const routes: (string | undefined)[] = []
    t.app.make(HooksToken).on(
      HTTP_HOOKS.response,
      (p) => {
        routes.push((p as { route?: string }).route)
        return undefined
      },
      { name: 'test.route' },
    )
    const a = t.actingAs(person('u'), { tenantId: TENANT_A })
    await a.request('GET', `${BASE}/customers/0190a000-0000-7000-8000-0000000000ff`)
    await a.request('GET', '/no/such/path/secret-token-123')
    await t.request('GET', '/health')
    expect(routes).toEqual([`${BASE}/customers/:id`, undefined, '/health'])
  })

  it('proxy helpers fail closed', () => {
    expect(trustedHops(undefined)).toBe(0)
    expect(trustedHops(true)).toBe(1)
    expect(trustedHops(2)).toBe(2)
    expect(() => trustedHops(-1)).toThrow(RangeError)
    expect(() => trustedHops(1.5)).toThrow(RangeError)
    expect(clientAddressOf('not-an-ip', null, 0)).toBeUndefined()
    expect(clientAddressOf('10.0.0.1', 'garbage', 1)).toBeUndefined()
    expect(clientAddressOf('10.0.0.1', '', 1)).toBe('10.0.0.1')
    expect(clientAddressOf('10.0.0.1', '1.1.1.1', 3)).toBe('1.1.1.1')
    expect(clientAddressOf('10.0.0.1', '1.1.1.1, 2.2.2.2, 3.3.3.3', 2)).toBe('2.2.2.2')
    expect(forwardedProtocol('https', 0, 'http')).toBe('http')
    expect(forwardedProtocol('http, https', 1, 'http')).toBe('https')
    expect(forwardedProtocol('gopher', 1, 'http')).toBe('http')
    expect(forwardedProtocol('http', 1, 'https')).toBe('http')
    expect(parsePublicUrl(undefined)).toBeUndefined()
    expect(parsePublicUrl('https://a.test/x')?.origin).toBe('https://a.test')
    expect(() => parsePublicUrl('not a url')).toThrow(TypeError)
    expect(() => parsePublicUrl('ftp://a.test')).toThrow(TypeError)
  })
})

describe('database cost limits and log redaction', () => {
  it('Postgres pools get a statement timeout by default', () => {
    expect(pgPoolOptions({ driver: 'postgres' })).toMatchObject({
      statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
      max: 10,
    })
    expect(
      pgPoolOptions({ driver: 'postgres', pool: { statementTimeoutMs: 0 } }),
    ).not.toHaveProperty('statement_timeout')
    expect(pgPoolOptions({ driver: 'postgres', ssl: true })).toMatchObject({
      ssl: { rejectUnauthorized: true },
    })
    expect(() => pgPoolOptions({ driver: 'postgres', pool: { statementTimeoutMs: -1 } })).toThrow(
      RangeError,
    )
  })

  it('sensitive and hidden field values never reach the logs (registered at boot)', async () => {
    expect(sensitiveFieldKeys([Account.definition, Note.definition])).toEqual([
      'apiSecret',
      'api_secret',
      'taxId',
      'tax_id',
    ])
    const lines: string[] = []
    // A logger created before boot still redacts the keys registered at boot.
    const log = createLogger({ sink: (line) => lines.push(line) })
    const app = createApp({
      config: {},
      providers: [
        frameworkProvider({
          database: { driver: 'sqlite', url: ':memory:' },
          models: [Account, Note],
        }),
      ],
    })
    app.container.value(PermissionProviderToken, allowAllPermissions())
    await app.boot()
    try {
      log.info('account', { apiSecret: 'canary-1', tax_id: 'canary-2', name: 'visible' })
      await log.flush()
      const out = lines.join(' ')
      expect(out).not.toContain('canary-1')
      expect(out).not.toContain('canary-2')
      expect(out).toContain('visible')
      // and the HTTP app builds on the same container
      expect(createHttpApp(app, { resources: [Account, Note], env: 'local' })).toBeDefined()
    } finally {
      await app.shutdown()
    }
  })
})
