/**
 * `Idempotency-Key` (IETF httpapi draft behaviour; ported from spike 12). A client that retries a
 * create, a delete or a custom POST with the same key and body gets the first response replayed
 * instead of running the action twice; the same key with a different body is a 422. The UI relies
 * on this for its "retry is safe" promise.
 *
 * The class covered: every unsafe route that creates or destroys something (CRUD create, delete,
 * restore, custom POST and DELETE), keys scoped per caller, bounded storage with a TTL.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Actor } from '../../src/contracts/index.ts'
import type { HttpAppOptions } from '../../src/http/create-http-app.ts'
import {
  IDEMPOTENCY_TTL_MS,
  IdempotencyStoreToken,
  MemoryIdempotencyStore,
} from '../../src/http/idempotency.ts'
import { route } from '../../src/http/route.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createTestApp, type TestApp, type TestClient } from '../../src/testing/index.ts'

const BASE = '/api/v1'
const Order = defineModel('Order', { ref: field.string(40) }, { softDeletes: true })
const alice: Actor = { id: 'alice', type: 'user', roles: [], attrs: {} }
const bob: Actor = { id: 'bob', type: 'user', roles: [], attrs: {} }

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

interface Problem {
  status: number
  code: string
}

async function boot(
  http: Omit<HttpAppOptions, 'resources' | 'registry' | 'database'> = {},
): Promise<{ app: TestApp; charges: () => number }> {
  let charges = 0
  t = await createTestApp({
    resources: [Order],
    http: {
      routes: [
        route.post('/payments', {
          handler: async (c) => {
            charges++
            const body = await c.json<{ amount: number }>()
            return new Response(JSON.stringify({ charge: charges, amount: body.amount }), {
              status: 201,
              headers: {
                'content-type': 'application/json',
                location: `/payments/${charges}`,
                'set-cookie': 'per-request=1',
              },
            })
          },
        }),
        route.post('/flaky', {
          handler: () => {
            charges++
            throw new Error('boom')
          },
        }),
      ],
      ...http,
    },
  })
  return { app: t, charges: () => charges }
}

const pay = (client: TestClient, key: string, amount = 10) =>
  client.request<{ charge: number; amount: number }>('POST', `${BASE}/payments`, {
    body: { amount },
    headers: { 'idempotency-key': key },
  })

describe('Idempotency-Key: a retry never runs the action twice', () => {
  it('a custom POST retried with the same key and body is replayed, not re-run', async () => {
    const { app, charges } = await boot()
    const a = app.actingAs(alice)
    const first = await pay(a, 'k-1')
    const retry = await pay(a, 'k-1')
    expect(first.status).toBe(201)
    expect(retry.status).toBe(201)
    expect(retry.body).toEqual(first.body)
    expect(charges()).toBe(1)
    expect(retry.headers.get('idempotent-replayed')).toBe('true')
    expect(retry.headers.get('location')).toBe('/payments/1')
    // Per-request headers are never replayed.
    expect(retry.headers.getSetCookie()).not.toContain('per-request=1')
    expect(first.headers.get('idempotent-replayed')).toBeNull()
  })

  it('CRUD create, delete and restore are honoured', async () => {
    const { app } = await boot()
    const a = app.actingAs(alice)
    const headers = { 'idempotency-key': 'create-1' }
    const created = await a.request<{ id: string }>('POST', `${BASE}/orders`, {
      body: { ref: 'A' },
      headers,
    })
    const again = await a.request<{ id: string }>('POST', `${BASE}/orders`, {
      body: { ref: 'A' },
      headers,
    })
    expect(again.body.id).toBe(created.body.id)
    expect(await app.repository(Order).count()).toBe(1)

    const del = { 'idempotency-key': 'delete-1' }
    expect(
      (await a.request('DELETE', `${BASE}/orders/${created.body.id}`, { headers: del })).status,
    ).toBe(204)
    const delAgain = await a.request('DELETE', `${BASE}/orders/${created.body.id}`, {
      headers: del,
    })
    // Without the key the second delete would be a 404; with it, the first answer.
    expect(delAgain.status).toBe(204)
    expect(delAgain.headers.get('idempotent-replayed')).toBe('true')

    const restore = { 'idempotency-key': 'restore-1' }
    const r1 = await a.request('POST', `${BASE}/orders/${created.body.id}/restore`, {
      headers: restore,
    })
    const r2 = await a.request('POST', `${BASE}/orders/${created.body.id}/restore`, {
      headers: restore,
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r2.headers.get('idempotent-replayed')).toBe('true')
  })

  it('the same key with a different body (or another endpoint) is 422 idempotency_key_reused', async () => {
    const { app, charges } = await boot()
    const a = app.actingAs(alice)
    await pay(a, 'k-2', 10)
    const changed = await a.request<Problem>('POST', `${BASE}/payments`, {
      body: { amount: 9999 },
      headers: { 'idempotency-key': 'k-2' },
    })
    expect(changed.status).toBe(422)
    expect(changed.body.code).toBe('idempotency_key_reused')
    const elsewhere = await a.request<Problem>('POST', `${BASE}/orders`, {
      body: { ref: 'x' },
      headers: { 'idempotency-key': 'k-2' },
    })
    expect(elsewhere.status).toBe(422)
    expect(charges()).toBe(1)
  })

  it('keys are scoped per caller: another user never gets the stored response', async () => {
    const { app, charges } = await boot()
    await pay(app.actingAs(alice), 'shared-key', 10)
    const theirs = await pay(app.actingAs(bob), 'shared-key', 10)
    expect(theirs.headers.get('idempotent-replayed')).toBeNull()
    expect(theirs.body.charge).toBe(2)
    expect(charges()).toBe(2)
  })

  it('a failure (5xx) is not stored: the retry runs for real', async () => {
    const { app, charges } = await boot()
    const a = app.actingAs(alice)
    const headers = { 'idempotency-key': 'flaky-1' }
    expect((await a.request('POST', `${BASE}/flaky`, { headers })).status).toBe(500)
    expect((await a.request('POST', `${BASE}/flaky`, { headers })).status).toBe(500)
    expect(charges()).toBe(2)
  })

  it('a concurrent duplicate while the first still runs gets 409 idempotency_in_progress', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    t = await createTestApp({
      resources: [Order],
      http: {
        routes: [
          route.post('/slow', {
            handler: async () => {
              await gate
              return { ok: true }
            },
          }),
        ],
      },
    })
    const a = t.actingAs(alice)
    const headers = { 'idempotency-key': 'slow-1' }
    const first = a.request('POST', `${BASE}/slow`, { headers })
    await new Promise((r) => setTimeout(r, 20))
    const second = await a.request<Problem>('POST', `${BASE}/slow`, { headers })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('idempotency_in_progress')
    expect(second.headers.get('retry-after')).toBe('1')
    release()
    expect((await first).status).toBe(200)
  })

  it('malformed keys are 400; requests without a key run normally; reads are never stored', async () => {
    const { app, charges } = await boot()
    const a = app.actingAs(alice)
    for (const key of ['', 'x'.repeat(256), 'has space', 'naïve']) {
      const res = await a.request<Problem>('POST', `${BASE}/payments`, {
        body: { amount: 1 },
        headers: { 'idempotency-key': key },
      })
      expect(res.status, JSON.stringify(key)).toBe(400)
      expect(res.body.code).toBe('idempotency_key_invalid')
    }
    await a.request('POST', `${BASE}/payments`, { body: { amount: 1 } })
    await a.request('POST', `${BASE}/payments`, { body: { amount: 1 } })
    expect(charges()).toBe(2)
    // POST /<resource>/query is a read: never replayed from the store.
    const q = { 'idempotency-key': 'query-1' }
    await a.request('POST', `${BASE}/orders/query`, { body: {}, headers: q })
    await app.repository(Order).create({ ref: 'later' })
    const fresh = await a.request<{ data: unknown[] }>('POST', `${BASE}/orders/query`, {
      body: {},
      headers: q,
    })
    expect(fresh.body.data).toHaveLength(1)
    expect(fresh.headers.get('idempotent-replayed')).toBeNull()
  })

  it('stored responses expire after the TTL (idempotency.ttlMs)', async () => {
    const { app, charges } = await boot({ idempotency: { ttlMs: 50 } })
    const a = app.actingAs(alice)
    await pay(a, 'ttl-1')
    expect((await pay(a, 'ttl-1')).headers.get('idempotent-replayed')).toBe('true')
    await new Promise((r) => setTimeout(r, 120))
    const after = await pay(a, 'ttl-1')
    expect(after.headers.get('idempotent-replayed')).toBeNull()
    expect(charges()).toBe(2)
    expect(IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('a store bound in the container is used (a shared store for a cluster)', async () => {
    const store = new MemoryIdempotencyStore()
    t = await createTestApp({ resources: [Order], http: { idempotency: { store } } })
    await t.actingAs(alice).request('POST', `${BASE}/orders`, {
      body: { ref: 'A' },
      headers: { 'idempotency-key': 'k' },
    })
    expect(store.size).toBe(1)
    expect(t.app.make(IdempotencyStoreToken)).toBe(store)
  })
})

describe('MemoryIdempotencyStore: bounded storage', () => {
  it('never holds more than maxEntries keys (oldest go first) and sweeps expired ones', async () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 3, ttlMs: 1000 })
    for (const key of ['a', 'b', 'c', 'd']) {
      expect(await store.begin(key, 'f', 0)).toEqual({ kind: 'new' })
      await store.complete(key, { status: 201, headers: [], body: key }, 0)
    }
    expect(store.size).toBe(3)
    expect(await store.begin('a', 'f', 0)).toEqual({ kind: 'new' })
    expect((await store.begin('d', 'f', 0)).kind).toBe('replay')
    expect(await store.begin('d', 'f', 5000)).toEqual({ kind: 'new' })
    expect(store.size).toBeLessThanOrEqual(3)
  })

  it('rejects nonsensical limits', () => {
    expect(() => new MemoryIdempotencyStore({ maxEntries: 0 })).toThrow(RangeError)
    expect(() => new MemoryIdempotencyStore({ ttlMs: -1 })).toThrow(RangeError)
  })
})
