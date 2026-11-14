/**
 * End-to-end HTTP through the real Hono app (`app.request`), on a real database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor, PermissionProvider, QueryFilter } from '../../src/contracts/index.ts'
import { defineResource } from '../../src/http/resource.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { DIALECTS } from '../helpers/engines.ts'
import { Customer, Invoice } from '../helpers/models.ts'
import { TENANT_A, TENANT_B } from '../helpers/setup.ts'

const user = (id: string, tenantId = TENANT_A): Actor => ({
  id,
  type: 'user',
  tenantId,
  roles: ['member'],
  attrs: {},
})
const BASE = '/api/v1'

interface Problem {
  status: number
  code: string
  title: string
  issues?: { path: (string | number)[]; code: string; message: string }[]
  traceId?: string
}

describe.each(DIALECTS)('HTTP CRUD on %s', (dialect) => {
  let t: TestApp
  beforeEach(async () => {
    t = await createTestApp({
      dialect,
      resources: [
        defineResource({ model: Customer, includes: ['invoices'] }),
        defineResource({ model: Invoice, includes: ['customer'], allowTotal: true }),
      ],
    })
  })
  afterEach(async () => {
    await t.close()
  })

  const asA = () => t.actingAs(user('u-a'), { tenantId: TENANT_A })
  const asB = () => t.actingAs(user('u-b', TENANT_B), { tenantId: TENANT_B })

  async function createCustomer(
    client = asA(),
    body: Record<string, unknown> = { name: 'Acme', email: 'billing@acme.test' },
  ) {
    const res = await client.request<{ id: string }>('POST', `${BASE}/customers`, { body })
    expect(res.status).toBe(201)
    return res.body
  }

  it('runs the full lifecycle: create, show, list, update, delete, restore', async () => {
    const client = asA()
    const customer = await createCustomer(client)
    const created = await client
      .resource(Invoice)
      .create({ number: 'INV-1', amount: '12.5', customer: customer.id } as never)
    expect(created.status).toBe(201)
    expect(created.headers.get('location')).toBe(
      `${BASE}/invoices/${(created.body as { id: string }).id}`,
    )
    const id = (created.body as { id: string }).id
    expect(created.body).toMatchObject({
      number: 'INV-1',
      amount: '12.50',
      status: 'draft',
      deletedAt: null,
    })

    const shown = await client.resource(Invoice).show(id)
    expect(shown.status).toBe(200)
    expect(shown.body).toEqual(created.body)

    const listed = await client.resource(Invoice).list('filter[status][eq]=draft&sort=-amount')
    expect(listed.status).toBe(200)
    expect(listed.body.data.map((r) => (r as { id: string }).id)).toEqual([id])
    expect(listed.body.meta.page).toMatchObject({ size: 25, hasMore: false })

    const updated = await client.resource(Invoice).update(id, { status: 'paid' } as never)
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({ status: 'paid' })

    expect((await client.resource(Invoice).delete(id)).status).toBe(204)
    expect((await client.resource(Invoice).show(id)).status).toBe(404)
    const restored = await client.resource(Invoice).restore(id)
    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ id, deletedAt: null })
    expect((await client.resource(Invoice).restore(id)).status).toBe(404)
  })

  it('returns 422 problems with catalog messages and field labels', async () => {
    const res = await asA().request<Problem>('POST', `${BASE}/customers`, {
      body: { name: '', email: 'not-an-email', admin: true },
      headers: { 'accept-language': 'en' },
    })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect(res.body.code).toBe('VALIDATION_FAILED')
    const byPath = Object.fromEntries((res.body.issues ?? []).map((i) => [i.path.join('.'), i]))
    expect(byPath['email']?.code).toBe('invalid_email')
    expect(byPath['email']?.message).toBe('Email must be a valid email address.')
    expect(byPath['admin']?.code).toBe('unknown_field')
    expect(byPath['admin']?.message).toBe('Admin is not a known field.')
    const missing = await asA().request<Problem>('POST', `${BASE}/customers`, { body: {} })
    expect(missing.body.issues?.map((i) => `${i.path.join('.')}:${i.code}`).sort()).toEqual([
      'email:required',
      'name:required',
    ])
  })

  it('rejects malformed JSON (400), non-JSON bodies (415) and oversize bodies (413)', async () => {
    const malformed = await asA().request<Problem>('POST', `${BASE}/customers`, {
      body: '{"name":',
      headers: { 'content-type': 'application/json' },
    })
    expect(malformed.status).toBe(400)
    expect(malformed.body.code).toBe('MALFORMED_REQUEST')
    const form = await asA().request<Problem>('POST', `${BASE}/customers`, {
      body: 'name=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(form.status).toBe(415)
    const huge = await asA().request<Problem>('POST', `${BASE}/customers`, {
      body: { name: 'x'.repeat(1_100_000), email: 'a@b.test' },
    })
    expect(huge.status).toBe(413)
    expect(huge.body.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('treats unknown, malformed and other-tenant ids as 404 (no enumeration)', async () => {
    const customer = await createCustomer()
    expect((await asA().request<Problem>('GET', `${BASE}/customers/not-a-uuid`)).status).toBe(404)
    expect(
      (await asA().request('GET', `${BASE}/customers/0190a000-0000-7000-8000-0000000000ff`)).status,
    ).toBe(404)
    const b = asB()
    expect((await b.request('GET', `${BASE}/customers/${customer.id}`)).status).toBe(404)
    expect(
      (await b.request('PATCH', `${BASE}/customers/${customer.id}`, { body: { name: 'pwned' } }))
        .status,
    ).toBe(404)
    expect((await b.request('DELETE', `${BASE}/customers/${customer.id}`)).status).toBe(404)
    const list = await b.request<{ data: unknown[] }>('GET', `${BASE}/customers`)
    expect(list.body.data).toEqual([])
    // and A still sees its record unchanged
    expect(
      (await asA().request<{ name: string }>('GET', `${BASE}/customers/${customer.id}`)).body.name,
    ).toBe('Acme')
  })

  it('never lets the payload choose the tenant or system fields', async () => {
    const res = await asA().request<Problem>('POST', `${BASE}/customers`, {
      body: {
        name: 'X',
        email: 'x@x.test',
        tenantId: TENANT_B,
        id: '0190a000-0000-7000-8000-000000000001',
        createdAt: '2000-01-01T00:00:00Z',
      },
    })
    expect(res.status).toBe(422)
    expect(res.body.issues?.map((i) => i.path.join('.')).sort()).toEqual([
      'createdAt',
      'id',
      'tenantId',
    ])
  })

  it('requires a tenant for tenant-scoped resources (403 TENANT_REQUIRED)', async () => {
    const res = await t.actingAs(user('u'), {}).request<Problem>('GET', `${BASE}/customers`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('TENANT_REQUIRED')
  })

  it('rejects invalid list queries with every issue at once', async () => {
    const res = await asA().request<Problem>(
      'GET',
      `${BASE}/invoices?filter[notes][eq]=x&filter[amount][contains]=1&filter[status][in]=nope&sort=notes&page[size]=500&bogus=1&page[cursor]=abc&page[number]=2`,
    )
    expect(res.status).toBe(422)
    const codes = (res.body.issues ?? []).map((i) => i.code).sort()
    expect(codes).toEqual(
      [
        'conflicting_pagination',
        'filter_not_allowed',
        'invalid_page_size',
        'operator_not_allowed',
        'sort_not_allowed',
        'unknown_parameter',
      ].sort(),
    )
    const bad = await asA().request<Problem>(
      'GET',
      `${BASE}/invoices?filter[issuedOn][eq]=2026-02-30`,
    )
    expect(bad.body.issues?.[0]).toMatchObject({
      path: ['query', 'filter', 'issuedOn', 'eq'],
      code: 'invalid_filter_value',
    })
    const cursor = await asA().request<Problem>(
      'GET',
      `${BASE}/invoices?page[cursor]=${Buffer.from('{"v":1}').toString('base64url')}`,
    )
    expect(cursor.status).toBe(422)
    expect(cursor.body.issues?.[0]?.code).toBe('invalid_cursor')
  })

  it('paginates with cursors and links, offsets with totals, search and includes', async () => {
    const client = asA()
    const customer = await createCustomer(client)
    for (let i = 1; i <= 5; i++) {
      await client.request('POST', `${BASE}/invoices`, {
        body: { number: `INV-${i}`, amount: String(i), customer: customer.id },
      })
    }
    const first = await client.request<{
      data: { number: string }[]
      meta: { page: { nextCursor?: string } }
      links?: { next: string }
    }>('GET', `${BASE}/invoices?sort=amount&page[size]=2`)
    expect(first.body.data.map((r) => r.number)).toEqual(['INV-1', 'INV-2'])
    expect(first.body.links?.next).toContain('page%5Bcursor%5D=')
    const second = await client.request<{ data: { number: string }[] }>(
      'GET',
      `${BASE}/invoices?sort=amount&page[size]=2&page[cursor]=${first.body.meta.page.nextCursor}`,
    )
    expect(second.body.data.map((r) => r.number)).toEqual(['INV-3', 'INV-4'])
    const offset = await client.request<{ meta: { page: unknown } }>(
      'GET',
      `${BASE}/invoices?page[number]=2&page[size]=2&page[total]=true`,
    )
    expect(offset.body.meta.page).toEqual({ size: 2, hasMore: true, number: 2, total: 5 })
    const search = await client.request<{ data: { number: string }[] }>(
      'GET',
      `${BASE}/invoices?search=inv-5`,
    )
    expect(search.body.data.map((r) => r.number)).toEqual(['INV-5'])

    const withCustomer = await client.request<{
      data: { included: { customer: { name: string } } }[]
    }>('GET', `${BASE}/invoices?include=customer&page[size]=1`)
    expect(withCustomer.body.data[0]?.included.customer.name).toBe('Acme')
    const withInvoices = await client.request<{ included: { invoices: unknown[] } }>(
      'GET',
      `${BASE}/customers/${customer.id}?include=invoices`,
    )
    expect(withInvoices.body.included.invoices).toHaveLength(5)
    const notAllowed = await client.request<Problem>(
      'GET',
      `${BASE}/customers/${customer.id}?include=secrets`,
    )
    expect(notAllowed.status).toBe(422)
    expect((await client.request<Problem>('GET', `${BASE}/customers?include=nope`)).status).toBe(
      422,
    )
  })

  it('accepts filter trees on POST /query and validates them', async () => {
    const client = asA()
    const customer = await createCustomer(client)
    for (const [n, status] of [
      ['A', 'draft'],
      ['B', 'paid'],
      ['C', 'sent'],
    ] as const) {
      await client.request('POST', `${BASE}/invoices`, {
        body: { number: n, amount: '1', customer: customer.id, status },
      })
    }
    const filter: QueryFilter = {
      op: 'or',
      filters: [
        { op: 'eq', field: 'status', value: 'paid' },
        { op: 'eq', field: 'number', value: 'A' },
      ],
    }
    const res = await client.request<{ data: { number: string }[] }>(
      'POST',
      `${BASE}/invoices/query`,
      {
        body: {
          filter,
          sort: [{ field: 'number', direction: 'asc' }],
          page: { size: 10 },
          total: true,
        },
      },
    )
    expect(res.status).toBe(200)
    expect(res.body.data.map((r) => r.number)).toEqual(['A', 'B'])
    const bad = await client.request<Problem>('POST', `${BASE}/invoices/query`, {
      body: { filter: { op: 'eq', field: 'notes', value: 'x' } },
    })
    expect(bad.status).toBe(422)
    expect(bad.body.issues?.[0]).toMatchObject({ path: ['filter'], code: 'filter_not_allowed' })
    const deep = { op: 'not', filter: {} } as Record<string, unknown>
    let node = deep
    for (let i = 0; i < 40; i++) {
      const next = { op: 'not', filter: {} }
      node['filter'] = next
      node = next
    }
    node['filter'] = { op: 'true' }
    expect(
      (await client.request<Problem>('POST', `${BASE}/invoices/query`, { body: { filter: deep } }))
        .body.issues?.[0]?.code,
    ).toBe('filter_too_complex')
    expect(
      (
        await client.request<Problem>('POST', `${BASE}/invoices/query`, {
          body: { page: { size: 1000 } },
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await client.request<Problem>('POST', `${BASE}/invoices/query`, {
          body: { include: ['secrets'] },
        })
      ).status,
    ).toBe(422)
  })

  it('maps unique and reference conflicts', async () => {
    const client = asA()
    await createCustomer(client)
    const dup = await client.request<Problem>('POST', `${BASE}/customers`, {
      body: { name: 'Again', email: 'billing@acme.test' },
    })
    expect(dup.status).toBe(422)
    expect(dup.body.issues?.[0]).toMatchObject({
      path: ['email'],
      code: 'unique',
      message: 'This Email is already taken.',
    })
    const otherTenantCustomer = await createCustomer(asB(), { name: 'B', email: 'b@b.test' })
    const crossRef = await client.request<Problem>('POST', `${BASE}/invoices`, {
      body: { number: 'X', amount: '1', customer: otherTenantCustomer.id },
    })
    expect(crossRef.status).toBe(422)
    expect(crossRef.body.issues?.[0]).toMatchObject({ path: ['customer'], code: 'not_found' })
    const customer = await createCustomer(client, { name: 'C', email: 'c@c.test' })
    await client.request('POST', `${BASE}/invoices`, {
      body: { number: 'Y', amount: '1', customer: customer.id },
    })
    const inUse = await client.request<Problem>('DELETE', `${BASE}/customers/${customer.id}`)
    expect(inUse.status).toBe(409)
    expect(inUse.body.code).toBe('RECORD_IN_USE')
  })

  it('serves problems for unknown routes and sets security headers and request ids', async () => {
    const res = await asA().request<Problem>('GET', '/nope', {
      headers: { 'x-request-id': 'req-12345678' },
    })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const ok = await asA().request('GET', `${BASE}/customers`, {
      headers: { 'x-request-id': 'req-12345678' },
    })
    // a client-chosen id is not believed without a trusted proxy (no forged correlation ids)
    expect(ok.headers.get('x-request-id')).not.toBe('req-12345678')
    expect(ok.headers.get('permissions-policy')).toContain('camera=()')
    const unsafe = await asA().request('GET', `${BASE}/customers`, {
      headers: { 'x-request-id': '<script>' },
    })
    expect(unsafe.headers.get('x-request-id')).not.toBe('<script>')
  })

  it('serves /health and /ready', async () => {
    expect((await t.request<{ status: string }>('GET', '/health')).body).toEqual({ status: 'ok' })
    const ready = await t.request<{ status: string; checks: Record<string, string> }>(
      'GET',
      '/ready',
    )
    expect(ready.status).toBe(200)
    expect(ready.body).toEqual({ status: 'ready', checks: { database: 'ok' } })
  })
})

describe('permissions', () => {
  const recordingProvider = (
    rules: Record<string, boolean>,
    filter: QueryFilter = { op: 'true' },
  ) => {
    const calls: string[] = []
    const provider: PermissionProvider = {
      async can(_actor, action) {
        calls.push(action)
        return { allowed: rules[action] ?? false, reason: 'test' }
      },
      async filterFor() {
        return filter
      },
    }
    return { provider, calls }
  }

  it('denies by default: 401 for anonymous, 403 for an authenticated actor', async () => {
    const t = await createTestApp({ resources: [Customer, Invoice], permissions: 'deny' })
    try {
      const anon = await t.request<Problem>('GET', `${BASE}/customers`)
      expect(anon.status).toBe(401)
      expect(anon.body.code).toBe('UNAUTHENTICATED')
      const denied = await t
        .actingAs(user('u'), { tenantId: TENANT_A })
        .request<Problem>('POST', `${BASE}/customers`, {
          body: { name: 'x', email: 'x@x.test' },
        })
      expect(denied.status).toBe(403)
      expect(denied.body.code).toBe('FORBIDDEN')
    } finally {
      await t.close()
    }
  })

  it('checks the action permission and applies the row filter to show/update/delete', async () => {
    const { provider, calls } = recordingProvider(
      {
        'customer.viewAny': true,
        'customer.view': true,
        'customer.create': true,
        'customer.update': true,
        'customer.delete': false,
      },
      { op: 'eq', field: 'name', value: { $actor: 'attrs.team' } },
    )
    const t = await createTestApp({ resources: [Customer, Invoice], permissions: provider })
    try {
      const alice = t.actingAs({ ...user('alice'), attrs: { team: 'Red' } }, { tenantId: TENANT_A })
      const bob = t.actingAs({ ...user('bob'), attrs: { team: 'Blue' } }, { tenantId: TENANT_A })
      const red = await alice.request<{ id: string }>('POST', `${BASE}/customers`, {
        body: { name: 'Red', email: 'r@r.test' },
      })
      expect(red.status).toBe(201)
      expect(calls).toContain('customer.create')
      expect((await alice.request('GET', `${BASE}/customers/${red.body.id}`)).status).toBe(200)
      expect((await bob.request('GET', `${BASE}/customers/${red.body.id}`)).status).toBe(404)
      expect(
        (
          await bob.request('PATCH', `${BASE}/customers/${red.body.id}`, {
            body: { email: 'x@x.test' },
          })
        ).status,
      ).toBe(404)
      expect(
        (await bob.request<{ data: unknown[] }>('GET', `${BASE}/customers`)).body.data,
      ).toEqual([])
      expect((await alice.request('DELETE', `${BASE}/customers/${red.body.id}`)).status).toBe(403)
      // a missing actor attribute fails closed (500), never open
      const noAttr = t.actingAs(user('carol'), { tenantId: TENANT_A })
      expect((await noAttr.request('GET', `${BASE}/customers`)).status).toBe(500)
    } finally {
      await t.close()
    }
  })

  it('serves the manifest with per-actor capabilities', async () => {
    const { provider } = recordingProvider({ 'customer.viewAny': true, 'customer.view': true })
    const t = await createTestApp({ resources: [Customer, Invoice], permissions: provider })
    try {
      const res = await t.request<{
        manifestVersion: number
        resources: {
          name: string
          capabilities: Record<string, boolean>
          fields: { name: string }[]
        }[]
      }>('GET', '/.well-known/strutvane.json')
      expect(res.status).toBe(200)
      expect(res.body.manifestVersion).toBe(1)
      const customer = res.body.resources.find((r) => r.name === 'Customer')
      expect(customer?.capabilities).toEqual({
        list: true,
        view: true,
        create: false,
        update: false,
        delete: false,
        restore: false,
        export: false,
      })
      expect(customer?.fields.map((f) => f.name)).toEqual([
        'id',
        'name',
        'email',
        'createdAt',
        'updatedAt',
        'invoices',
      ])
    } finally {
      await t.close()
    }
  })
})
