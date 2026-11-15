/**
 * A `hasMany` include is capped (one batched query per page, at most
 * {@link MAX_INCLUDED_CHILDREN} children). Over the cap the response used to stop silently, so a
 * client showed "1000 lines" as if that were all of them. Now it says so: `meta.truncated` on a
 * list, the `Strutvane-Truncated-Includes` header on a single record, naming the relations.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defineResource } from '../../src/http/resource.ts'
import { MAX_INCLUDED_CHILDREN } from '../../src/http/resource-routes.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'

const Order = defineModel('Order', {
  ref: field.string(20).filterable(),
  lines: field.hasMany('Line'),
})
const Line = defineModel('Line', { order: field.belongsTo('Order'), qty: field.integer() })

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** Insert `count` lines for `orderId` in one statement per 500 rows. */
async function lines(app: TestApp, orderId: string, count: number): Promise<void> {
  const now = '2026-11-15T00:00:00.000Z'
  for (let start = 0; start < count; start += 500) {
    const n = Math.min(500, count - start)
    const values = Array.from({ length: n }, () => '(?, ?, ?, ?, ?)').join(', ')
    const params = Array.from({ length: n }, () => [
      crypto.randomUUID(),
      orderId,
      1,
      now,
      now,
    ]).flat()
    await app.db.execute(
      `INSERT INTO "lines" ("id", "order_id", "qty", "created_at", "updated_at") VALUES ${values}`,
      params,
    )
  }
}

async function boot(): Promise<TestApp> {
  t = await createTestApp({ resources: [defineResource(Order, { includes: ['lines'] }), Line] })
  return t
}

describe('hasMany includes over the cap say they are truncated', () => {
  it('a list response carries meta.truncated with the relation name', async () => {
    const app = await boot()
    const order = await app.repository(Order).create({ ref: 'big' })
    await lines(app, order.id, MAX_INCLUDED_CHILDREN + 5)
    const res = await app.request<{
      data: { included: { lines: unknown[] } }[]
      meta: { truncated?: string[] }
    }>('GET', '/api/v1/orders?include=lines')
    expect(res.status).toBe(200)
    expect(res.body.data[0]?.included.lines).toHaveLength(MAX_INCLUDED_CHILDREN)
    expect(res.body.meta.truncated).toEqual(['lines'])
  })

  it('a single record says so in a header; under the cap nothing is flagged', async () => {
    const app = await boot()
    const big = await app.repository(Order).create({ ref: 'big' })
    await lines(app, big.id, MAX_INCLUDED_CHILDREN + 1)
    const res = await app.request<{ included: { lines: unknown[] } }>(
      'GET',
      `/api/v1/orders/${big.id}?include=lines`,
    )
    expect(res.body.included.lines).toHaveLength(MAX_INCLUDED_CHILDREN)
    expect(res.headers.get('strutvane-truncated-includes')).toBe('lines')

    const small = await app.repository(Order).create({ ref: 'small' })
    await lines(app, small.id, 3)
    const one = await app.request('GET', `/api/v1/orders/${small.id}?include=lines`)
    expect(one.headers.get('strutvane-truncated-includes')).toBeNull()
    const list = await app.request<{ meta: { truncated?: string[] } }>(
      'GET',
      `/api/v1/orders?include=lines&filter[ref][eq]=small`,
    )
    expect(list.body.meta.truncated).toBeUndefined()
  })
})
