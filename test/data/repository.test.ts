import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundError, ValidationError } from '../../src/core/index.ts'
import { PolicyViolationError, TenantRequiredError } from '../../src/data/repository.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { bindFilter } from '../../src/query/bind.ts'
import { queryFields } from '../../src/query/fields.ts'
import { CursorError } from '../../src/query/sort.ts'
import { DIALECTS } from '../helpers/engines.ts'
import { models } from '../helpers/models.ts'
import { type Fixture, setupDatabase, TENANT_A, TENANT_B } from '../helpers/setup.ts'

const A = { tenantId: TENANT_A }
const B = { tenantId: TENANT_B }

describe.each(DIALECTS)('repository on %s', (dialect) => {
  let fx: Fixture
  beforeEach(async () => {
    fx = await setupDatabase(dialect, models)
  })
  afterEach(async () => {
    await fx.db.close()
  })

  async function seedCustomer(scope = A, name = 'Acme', email = 'billing@acme.test') {
    return fx.repo('Customer').create({ name, email }, scope)
  }

  it('creates, finds, updates and deletes with canonical values and timestamps', async () => {
    const customer = await seedCustomer()
    expect(customer).toMatchObject({ name: 'Acme', email: 'billing@acme.test' })
    expect(customer.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(customer['createdAt']).toMatch(/Z$/)
    const invoices = fx.repo('Invoice')
    const inv = await invoices.create(
      { number: 'INV-1', amount: '10.5', customer: customer.id, issuedOn: '2026-01-31' },
      A,
    )
    expect(inv).toMatchObject({
      number: 'INV-1',
      amount: '10.50',
      status: 'draft',
      issuedOn: '2026-01-31',
      notes: null,
      deletedAt: null,
    })
    expect(await invoices.find(inv.id, A)).toEqual(inv)
    const updated = await invoices.update(inv.id, { status: 'paid', notes: 'thanks' }, A)
    expect(updated).toMatchObject({ status: 'paid', notes: 'thanks', amount: '10.50' })
    expect(await invoices.update(inv.id, {}, A)).toMatchObject({ status: 'paid' })
    expect(await invoices.delete(inv.id, A)).toBe(true)
    expect(await invoices.find(inv.id, A)).toBeUndefined()
    expect(await invoices.delete(inv.id, A)).toBe(false)
    await expect(invoices.findOrFail(inv.id, A)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('soft-deletes and restores, and can list trashed rows', async () => {
    const customer = await seedCustomer()
    const invoices = fx.repo('Invoice')
    const inv = await invoices.create({ number: 'INV-1', amount: '1', customer: customer.id }, A)
    await invoices.delete(inv.id, A)
    expect(await invoices.find(inv.id, { ...A, trashed: 'with' })).toMatchObject({
      deletedAt: expect.any(String),
    })
    expect((await invoices.list({}, { ...A, trashed: 'only' })).data).toHaveLength(1)
    expect(await invoices.restore(inv.id, A)).toMatchObject({ id: inv.id, deletedAt: null })
    expect(await invoices.restore(inv.id, A)).toBeUndefined()
    expect(await invoices.forceDelete(inv.id, A)).toBe(true)
    expect(await invoices.find(inv.id, { ...A, trashed: 'with' })).toBeUndefined()
    expect(await invoices.forceDelete(inv.id, A)).toBe(false)
  })

  it('hard-deletes models without soft deletes and blocks deleting referenced rows', async () => {
    const customer = await seedCustomer()
    await fx.repo('Invoice').create({ number: 'INV-1', amount: '1', customer: customer.id }, A)
    await expect(fx.repo('Customer').delete(customer.id, A)).rejects.toMatchObject({
      code: 'RECORD_IN_USE',
      status: 409,
    })
    const other = await seedCustomer(A, 'Other', 'o@x.test')
    expect(await fx.repo('Customer').delete(other.id, A)).toBe(true)
    expect(await fx.repo('Customer').restore(other.id, A)).toBeUndefined()
  })

  it('isolates tenants: other tenants rows are invisible to every operation', async () => {
    const ca = await seedCustomer(A)
    const cb = await seedCustomer(B, 'Beta', 'b@beta.test')
    const invoices = fx.repo('Invoice')
    const ia = await invoices.create({ number: 'INV-1', amount: '1', customer: ca.id }, A)
    expect(await invoices.find(ia.id, B)).toBeUndefined()
    expect(await invoices.update(ia.id, { status: 'paid' }, B)).toBeUndefined()
    expect(await invoices.delete(ia.id, B)).toBe(false)
    expect((await invoices.list({}, B)).data).toEqual([])
    expect(await invoices.count(undefined, A)).toBe(1)
    // the same unique number is allowed in another tenant
    await expect(
      invoices.create({ number: 'INV-1', amount: '1', customer: cb.id }, B),
    ).resolves.toBeDefined()
    // a reference to another tenant's row is rejected as not found (FKs alone would accept it)
    const err = await invoices
      .create({ number: 'INV-2', amount: '1', customer: cb.id }, A)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).issues).toEqual([{ path: ['customer'], code: 'not_found' }])
  })

  it('fails closed without a tenant', async () => {
    await expect(
      fx.repo('Customer').create({ name: 'x', email: 'x@x.test' }, {}),
    ).rejects.toBeInstanceOf(TenantRequiredError)
    await expect(fx.repo('Customer').list({}, { tenantId: '' })).rejects.toBeInstanceOf(
      TenantRequiredError,
    )
  })

  it('reports unique violations as a field issue', async () => {
    await seedCustomer()
    const err = await seedCustomer(A, 'Again').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).issues).toEqual([{ path: ['email'], code: 'unique' }])
  })

  it('returns undefined / false for malformed ids instead of querying', async () => {
    const r = fx.repo('Invoice')
    expect(await r.find('not-a-uuid', A)).toBeUndefined()
    expect(await r.update("1' OR '1'='1", {}, A)).toBeUndefined()
    expect(await r.delete('x', A)).toBe(false)
    expect(await r.forceDelete('x', A)).toBe(false)
    expect(await r.restore('x', A)).toBeUndefined()
    expect(await r.findMany(['x'], A)).toEqual([])
  })

  it('applies policy filters to reads and writes', async () => {
    const customer = await seedCustomer()
    const invoices = fx.repo('Invoice')
    const draft = await invoices.create({ number: 'D', amount: '1', customer: customer.id }, A)
    const paid = await invoices.create(
      { number: 'P', amount: '1', customer: customer.id, status: 'paid' },
      A,
    )
    const onlyDraft = bindFilter(
      { op: 'eq', field: 'status', value: 'draft' },
      { fields: queryFields(invoices.model), operators: 'any', actor: null },
    )
    const scope = { ...A, filter: onlyDraft }
    expect((await invoices.list({}, scope)).data.map((r) => r.id)).toEqual([draft.id])
    expect(await invoices.find(paid.id, scope)).toBeUndefined()
    expect(await invoices.update(paid.id, { notes: 'x' }, scope)).toBeUndefined()
    expect(await invoices.delete(paid.id, scope)).toBe(false)
    // update cannot move a row outside the caller's policy scope: rolled back, 403
    await expect(invoices.update(draft.id, { status: 'sent' }, scope)).rejects.toBeInstanceOf(
      PolicyViolationError,
    )
    expect(await invoices.find(draft.id, A)).toMatchObject({ status: 'draft' })
    // create cannot forge a row outside the policy either; nothing is left behind
    await expect(
      invoices.create({ number: 'F', amount: '1', customer: customer.id, status: 'paid' }, scope),
    ).rejects.toBeInstanceOf(PolicyViolationError)
    expect((await invoices.list({}, A)).data.map((r) => r['number']).sort()).toEqual(['D', 'P'])
    // an explicit check overrides the default (e.g. a workflow step that hands a row on)
    expect(
      await invoices.update(draft.id, { status: 'sent' }, { ...scope, check: { op: 'true' } }),
    ).toMatchObject({ status: 'sent' })
  })

  it('paginates with cursors across sorts, including nulls and ties, without gaps or overlaps', async () => {
    const customer = await seedCustomer()
    const invoices = fx.repo('Invoice')
    const amounts = ['5', '1', '3', '3', '10', '2.5', '3', '7']
    for (const [i, amount] of amounts.entries()) {
      await invoices.create(
        {
          number: `N${i}`,
          amount,
          customer: customer.id,
          ...(i % 3 === 0 ? {} : { issuedOn: `2026-01-0${(i % 5) + 1}` }),
        },
        A,
      )
    }
    for (const sort of [
      [{ field: 'amount', direction: 'asc' }],
      [{ field: 'amount', direction: 'desc' }],
      [{ field: 'issuedOn', direction: 'asc' }],
      [
        { field: 'issuedOn', direction: 'desc' },
        { field: 'number', direction: 'asc' },
      ],
      [],
    ] as const) {
      const all = await invoices.list({ sort, page: { kind: 'cursor', size: 100 } }, A)
      const seen: string[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await invoices.list(
          { sort, page: { kind: 'cursor', size: 3, ...(cursor ? { cursor } : {}) } },
          A,
        )
        seen.push(...page.data.map((r) => r.id))
        if (!page.page.hasMore) break
        cursor = page.page.nextCursor
      }
      expect(seen).toEqual(all.data.map((r) => r.id))
    }
    const byAmount = await invoices.list({ sort: [{ field: 'amount', direction: 'asc' }] }, A)
    expect(byAmount.data.map((r) => r['amount'])).toEqual([
      '1.00',
      '2.50',
      '3.00',
      '3.00',
      '3.00',
      '5.00',
      '7.00',
      '10.00',
    ])
    const nullsLast = await invoices.list({ sort: [{ field: 'issuedOn', direction: 'desc' }] }, A)
    expect(nullsLast.data.at(-1)?.['issuedOn']).toBeNull()
  })

  it('supports offset pagination with an opt-in total, filters and search', async () => {
    const customer = await seedCustomer()
    const invoices = fx.repo('Invoice')
    for (let i = 1; i <= 7; i++)
      await invoices.create({ number: `INV-${i}`, amount: String(i), customer: customer.id }, A)
    const page2 = await invoices.list(
      { page: { kind: 'offset', size: 3, number: 2 }, withTotal: true },
      A,
    )
    expect(page2.page).toEqual({ size: 3, hasMore: true, number: 2, total: 7 })
    expect(page2.data).toHaveLength(3)
    const fields = queryFields(invoices.model)
    const filter = bindFilter(
      { op: 'gte', field: 'amount', value: '5' },
      { fields, operators: 'declared', actor: null },
    )
    expect((await invoices.list({ filter }, A)).data).toHaveLength(3)
    expect((await invoices.list({ search: 'inv-7' }, A)).data.map((r) => r['number'])).toEqual([
      'INV-7',
    ])
    expect((await invoices.list({ search: '   ' }, A)).data).toHaveLength(7)
    await expect(invoices.list({ search: 'x'.repeat(201) }, A)).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('rejects tampered or mismatched cursors', async () => {
    const customer = await seedCustomer()
    const invoices = fx.repo('Invoice')
    for (let i = 0; i < 3; i++)
      await invoices.create({ number: `I${i}`, amount: '1', customer: customer.id }, A)
    const first = await invoices.list(
      { page: { kind: 'cursor', size: 1 }, sort: [{ field: 'amount', direction: 'asc' }] },
      A,
    )
    const cursor = first.page.nextCursor as string
    await expect(
      invoices.list({ page: { kind: 'cursor', size: 1, cursor } }, A),
    ).rejects.toBeInstanceOf(CursorError)
    for (const bad of [
      '',
      '!!!',
      Buffer.from('{"v":2}').toString('base64url'),
      Buffer.from('nope').toString('base64url'),
    ]) {
      await expect(
        invoices.list(
          {
            page: { kind: 'cursor', size: 1, cursor: bad },
            sort: [{ field: 'amount', direction: 'asc' }],
          },
          A,
        ),
      ).rejects.toBeInstanceOf(CursorError)
    }
    const forged = Buffer.from(
      JSON.stringify({ v: 1, s: 'amount:asc,id:asc', k: ["1' OR 1=1", 'x'] }),
    ).toString('base64url')
    await expect(
      invoices.list(
        {
          page: { kind: 'cursor', size: 1, cursor: forged },
          sort: [{ field: 'amount', direction: 'asc' }],
        },
        A,
      ),
    ).rejects.toBeInstanceOf(CursorError)
  })

  it('loads related rows in scope with findMany and findBy', async () => {
    const customer = await seedCustomer()
    const invoices = fx.repo('Invoice')
    await invoices.create({ number: 'A', amount: '1', customer: customer.id }, A)
    await invoices.create({ number: 'B', amount: '1', customer: customer.id }, A)
    expect(await fx.repo('Customer').findMany([customer.id, customer.id], A)).toHaveLength(1)
    expect(await fx.repo('Customer').findMany([customer.id], B)).toEqual([])
    expect(await invoices.findBy('customer', [customer.id], A)).toHaveLength(2)
    expect(await invoices.findBy('customer', [], A)).toEqual([])
    await expect(invoices.findBy('number', [customer.id], A)).rejects.toThrow(/not a belongsTo/)
  })

  it('handles every field kind round-trip', async () => {
    const Kitchen = defineModel('Kitchen', {
      s: field.string(),
      t: field.text().optional(),
      e: field.email().optional(),
      u: field.url().optional(),
      id2: field.uuid().optional(),
      i: field.integer().optional(),
      big: field.bigInteger().optional(),
      d: field.decimal(10, 3).optional(),
      f: field.float().optional(),
      b: field.boolean().default(false),
      en: field.enum(['x', 'y']).optional(),
      dt: field.date().optional(),
      ts: field.datetime().optional(),
      j: field.json<{ a: number[] }>().optional(),
      parent: field.belongsTo('Kitchen').optional(),
    })
    const local = await setupDatabase(dialect, [Kitchen.definition])
    try {
      const repo = local.repo('Kitchen')
      const parent = await repo.create({ s: 'parent' })
      const row = await repo.create({
        s: 'hello',
        t: 'long',
        e: 'a@b.test',
        u: 'https://x.test/a',
        id2: '0190A000-0000-7000-8000-0000000000FF',
        i: -42,
        big: '9007199254740993',
        d: '-0.5',
        f: 1.25,
        b: true,
        en: 'y',
        dt: '2024-02-29',
        ts: '2026-11-14T13:30:00+01:00',
        j: { a: [1, 2] },
        parent: parent.id,
      })
      expect(row).toMatchObject({
        s: 'hello',
        id2: '0190a000-0000-7000-8000-0000000000ff',
        i: -42,
        big: '9007199254740993',
        d: '-0.500',
        f: 1.25,
        b: true,
        en: 'y',
        dt: '2024-02-29',
        ts: '2026-11-14T12:30:00.000Z',
        j: { a: [1, 2] },
        parent: parent.id,
      })
      expect(parent).toMatchObject({ b: false, j: null, parent: null })
    } finally {
      await local.db.close()
    }
  })
})
