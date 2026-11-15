/**
 * Create authorizes anonymous callers before it validates the body. Validation issues describe
 * the resource's schema (field names, types, which are required): an anonymous caller who may not
 * create anything must get a plain 401, not a field-by-field map of the model. An authenticated
 * caller is validated first and then authorized with the input (record-level rules need it).
 *
 * The class covered: every write route with a body answers 401 to anonymous callers before any
 * validation (update already did; create was the gap).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { PermissionProvider } from '../../src/contracts/index.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'

const Secret = defineModel('Secret', {
  codename: field.string(40),
  level: field.integer(),
})

const signedInOnly: PermissionProvider = {
  can: async (actor) => ({ allowed: actor !== null, reason: 'test' }),
  filterFor: async (actor) => (actor === null ? { op: 'false' } : { op: 'true' }),
}

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

interface Problem {
  status: number
  code: string
  issues?: unknown[]
}

describe('create: anonymous callers get 401 before body validation', () => {
  it('an invalid body from an anonymous caller is 401, with no issues listed', async () => {
    t = await createTestApp({ resources: [Secret], permissions: signedInOnly })
    for (const body of [{}, { codename: 1, level: 'x' }, { unknown: true }, '{not json']) {
      const res = await t.request<Problem>('POST', '/api/v1/secrets', { body })
      expect(res.status, JSON.stringify(body)).toBe(401)
      expect(res.body.code).toBe('UNAUTHENTICATED')
      expect(res.body.issues).toBeUndefined()
    }
    const wrongType = await t.request<Problem>('POST', '/api/v1/secrets', {
      body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(wrongType.status).toBe(401)
    for (const body of [{}, { codename: 'x', level: 1 }]) {
      const update = await t.request<Problem>(
        'PATCH',
        '/api/v1/secrets/00000000-0000-4000-8000-000000000001',
        { body },
      )
      expect(update.status).toBe(401)
    }
  })

  it('an authenticated caller is still validated first (422 with issues), then authorized', async () => {
    t = await createTestApp({ resources: [Secret], permissions: signedInOnly })
    const a = t.actingAs({ id: 'u', type: 'user', roles: [], attrs: {} })
    const bad = await a.request<Problem>('POST', '/api/v1/secrets', { body: { level: 'x' } })
    expect(bad.status).toBe(422)
    expect(bad.body.issues?.length).toBeGreaterThan(0)
    const ok = await a.request('POST', '/api/v1/secrets', { body: { codename: 'x', level: 1 } })
    expect(ok.status).toBe(201)
  })

  it('a public create (anonymous allowed) still validates the body', async () => {
    t = await createTestApp({ resources: [Secret], permissions: 'allow' })
    const bad = await t.request<Problem>('POST', '/api/v1/secrets', { body: {} })
    expect(bad.status).toBe(422)
  })
})
