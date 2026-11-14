// Units added for the app runtime: route definitions, policySchema, defineResource forms and
// defineFactory (fake data + saving through a test app).
import { describe, expect, test } from 'vitest'
import { defineResource } from '../../src/http/resource.ts'
import { isRouteDefinition, route } from '../../src/http/route.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { policySchema } from '../../src/model/policy-schema.ts'
import { createFake, defineFactory } from '../../src/testing/define-factory.ts'
import { createTestApp } from '../../src/testing/test-app.ts'
import { Customer, Invoice } from '../helpers/models.ts'

describe('route', () => {
  test('defines frozen routes for every method', () => {
    const handler = () => ({})
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const r = route[m]('/x/:id', { handler })
      expect(r).toMatchObject({ method: m, path: '/x/:id' })
      expect(Object.isFrozen(r)).toBe(true)
      expect(isRouteDefinition(r)).toBe(true)
    }
    expect(isRouteDefinition({ method: 'get' })).toBe(false)
    expect(isRouteDefinition(null)).toBe(false)
  })

  test('rejects unsafe paths, missing handlers and malformed permissions at definition time', () => {
    const handler = () => ({})
    for (const path of ['', 'x', '/a//b', '/a/../b', '/a b', '/a?x=1']) {
      expect(() => route.get(path, { handler })).toThrow(/path must start/)
    }
    expect(() => route.get('/x', {} as never)).toThrow(/handler/)
    expect(() => route.get('/x', { handler, permission: 'nope' })).toThrow(/permission/)
    expect(route.get('/x', { handler, permission: 'report.view' }).permission).toBe('report.view')
  })

  test('duplicate routes stop the app at boot', async () => {
    const Thing = defineModel('Thing', { name: field.string() })
    const r = route.get('/dup', { public: true, handler: () => ({}) })
    await expect(
      (async () => {
        const t = await createTestApp({ resources: [Thing] })
        try {
          const { createHttpApp } = await import('../../src/http/create-http-app.ts')
          createHttpApp(t.app, { resources: [Thing], routes: [r, r], env: 'testing' })
        } finally {
          await t.close()
        }
      })(),
    ).rejects.toThrow(/Duplicate route/)
  })
})

describe('policySchema', () => {
  test('describes columns with portable types, including system and relation columns', () => {
    const s = policySchema(Invoice)
    expect(s.table).toBe('invoices')
    expect(s.columns['id']).toEqual({ column: 'id', type: 'uuid' })
    expect(s.columns['tenantId']).toEqual({ column: 'tenant_id', type: 'uuid' })
    expect(s.columns['customer']).toEqual({ column: 'customer_id', type: 'uuid' })
    expect(s.columns['amount']).toEqual({ column: 'amount', type: 'float8' })
    expect(s.columns['status']?.type).toBe('text')
    expect(s.columns['issuedOn']).toEqual({ column: 'issued_on', type: 'text' })
    expect(policySchema(Customer.definition).columns['createdAt']).toEqual({
      column: 'created_at',
      type: 'text',
    })
    const WithJson = defineModel('Doc', {
      body: field.json(),
      n: field.integer(),
      ok: field.boolean(),
    })
    const d = policySchema(WithJson)
    expect((d.columns as Record<string, unknown>)['body']).toBeUndefined()
    expect(d.columns['n']?.type).toBe('int4')
    expect(d.columns['ok']?.type).toBe('bool')
  })
})

describe('defineResource', () => {
  test('accepts (model, config) and ({ model, ... }) equivalently', () => {
    expect(defineResource(Invoice, { includes: ['customer'] })).toEqual({
      includes: ['customer'],
      model: Invoice,
    })
    expect(defineResource(Invoice)).toEqual({ model: Invoice })
    const config = { model: Invoice, includes: ['customer'] }
    expect(defineResource(config)).toBe(config)
  })
})

describe('defineFactory', () => {
  const Thing = defineModel(
    'Thing',
    {
      name: field.string(),
      score: field.decimal(8, 2),
      kind: field.enum(['a', 'b']),
      owner: field.belongsTo('Owner').optional(),
    },
    {},
  )
  const Owner = defineModel('Owner', { name: field.string() })

  test('fake data is deterministic per seed and covers every helper', () => {
    const a = createFake(42)
    const b = createFake(42)
    const sample = (f: ReturnType<typeof createFake>) => [
      f.words(),
      f.words(1),
      f.paragraph(),
      f.email(),
      f.url(),
      f.phone(),
      f.slug(),
      f.password(),
      f.color(),
      f.uuid(),
      f.ulid(),
      f.address(),
      f.geoPoint(),
      f.boolean(),
      f.date(),
      f.time(),
      f.datetime(),
      f.duration(),
      f.integer(),
      f.integer({ min: 5, max: 5 }),
      f.float({ min: 1, max: 2 }),
      f.decimal({ scale: 3 }),
      f.money(),
      f.money({ currency: 'EUR' }),
      f.pick(['x', 'y']),
      f.subset([1, 2, 3]),
    ]
    expect(sample(a)).toEqual(sample(b))
    const f = createFake(1)
    expect(f.integer({ min: 5, max: 5 })).toBe(5)
    expect(f.email()).toMatch(/@example\.test$/)
    expect(f.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(f.decimal({ min: 1, max: 1, scale: 2 })).toBe('1.00')
    expect(() => f.pick([])).toThrow(/at least one/)
  })

  test('attributes() builds values without saving and drops related markers', () => {
    const factory = defineFactory(Thing, ({ fake, related, sequence }) => ({
      name: `thing-${sequence}`,
      score: fake.decimal({ min: 0, max: 10 }),
      kind: fake.pick(['a', 'b']),
      owner: related('Owner'),
    }))
    const attrs = factory.attributes({ kind: 'b' })
    expect(attrs['name']).toBe('thing-1')
    expect(attrs['kind']).toBe('b')
    expect('owner' in attrs).toBe(false)
  })

  test('create / createMany save through a test app and create related parents', async () => {
    const t = await createTestApp({ resources: [Thing, Owner] })
    try {
      const factory = defineFactory(Thing, ({ fake, related, sequence }) => ({
        name: `thing-${sequence}`,
        score: fake.decimal({ min: 0, max: 10 }),
        kind: 'a',
        owner: related('Owner'),
      }))
      const one = (await factory.create(t, { name: 'first' })) as unknown as Record<string, unknown>
      expect(one['name']).toBe('first')
      expect(typeof one['owner']).toBe('string')
      expect(await factory.createMany(t, 2)).toHaveLength(2)
      expect(await factory.createMany(t, 0)).toEqual([])
      await expect(factory.createMany(t, -1)).rejects.toThrow(/non-negative/)
      const list = await t.request<{ data: unknown[] }>('GET', '/api/v1/things')
      expect(list.body.data).toHaveLength(3)
    } finally {
      await t.close()
    }
  })
})
