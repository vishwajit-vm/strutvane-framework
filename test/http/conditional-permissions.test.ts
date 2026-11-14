// Conditional permissions ("members update and delete their own records"): a PermissionProvider
// that cannot decide `update` without the record (auth answers `record-required`) must still let
// the owner act on their rows, never on anyone else's, and never widen what lists show.
import type { Actor, Decision, PermissionProvider, QueryFilter } from '@strutvane/contracts'
import { describe, expect, it } from 'vitest'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createTestApp } from '../../src/testing/index.ts'
import { TENANT_A } from '../helpers/setup.ts'

const Doc = defineModel(
  'Doc',
  { title: field.string(), ownerId: field.uuid().optional().readOnly() },
  { tenant: true, softDeletes: true },
)

const ALICE: Actor = {
  id: '0190a000-0000-7000-8000-0000000000a1',
  type: 'user',
  roles: ['member'],
  attrs: {},
}
const BOB: Actor = {
  id: '0190a000-0000-7000-8000-0000000000b1',
  type: 'user',
  roles: ['member'],
  attrs: {},
}
const NOBODY: Actor = {
  id: '0190a000-0000-7000-8000-0000000000c1',
  type: 'user',
  roles: [],
  attrs: {},
}

const own: QueryFilter = { op: 'eq', field: 'ownerId', value: { $actor: 'id' } }

/** Members: view and create anything; update, delete and restore only their own docs. */
const ownership: PermissionProvider = {
  async can(actor, permission, resource): Promise<Decision> {
    if (!actor || !actor.roles.includes('member')) return { allowed: false, reason: 'no-role' }
    const action = String(permission).split('.')[1]
    if (action === 'viewAny' || action === 'view' || action === 'create')
      return { allowed: true, reason: 'ok' }
    const record = resource?.record as { ownerId?: unknown } | undefined
    if (!record) return { allowed: false, reason: 'record-required:own' }
    return record.ownerId === actor.id
      ? { allowed: true, reason: 'ok' }
      : { allowed: false, reason: 'not-owner' }
  },
  async filterFor(actor, permission): Promise<QueryFilter> {
    if (!actor || !actor.roles.includes('member')) return { op: 'false' }
    const action = String(permission).split('.')[1]
    return action === 'viewAny' || action === 'view' ? { op: 'true' } : own
  },
}

describe('conditional (record-dependent) permissions on the CRUD routes', () => {
  it('owners update, delete and restore their rows; others get 404; no-role actors get 403', async () => {
    const t = await createTestApp({ resources: [Doc], permissions: ownership })
    try {
      const alice = t.actingAs(ALICE, { tenantId: TENANT_A })
      const bob = t.actingAs(BOB, { tenantId: TENANT_A })
      const nobody = t.actingAs(NOBODY, { tenantId: TENANT_A })
      const mine = await t
        .repository(Doc)
        .create({ title: 'A', ownerId: ALICE.id }, { tenantId: TENANT_A })
      const theirs = await t
        .repository(Doc)
        .create({ title: 'B', ownerId: BOB.id }, { tenantId: TENANT_A })

      expect((await alice.request('GET', `/api/v1/docs/${theirs.id}`)).status).toBe(200)
      expect(
        (await alice.request('PATCH', `/api/v1/docs/${mine.id}`, { body: { title: 'A2' } })).status,
      ).toBe(200)
      expect(
        (await alice.request('PATCH', `/api/v1/docs/${theirs.id}`, { body: { title: 'x' } }))
          .status,
      ).toBe(404)
      expect((await alice.request('DELETE', `/api/v1/docs/${theirs.id}`)).status).toBe(404)
      expect((await bob.request('DELETE', `/api/v1/docs/${mine.id}`)).status).toBe(404)
      expect((await alice.request('DELETE', `/api/v1/docs/${mine.id}`)).status).toBe(204)
      expect((await bob.request('POST', `/api/v1/docs/${mine.id}/restore`)).status).toBe(404)
      expect((await alice.request('POST', `/api/v1/docs/${mine.id}/restore`)).status).toBe(200)

      // No role at all: 403 for every action, never a 404 probe or a widened list.
      expect((await nobody.request('GET', '/api/v1/docs')).status).toBe(403)
      expect(
        (await nobody.request('PATCH', `/api/v1/docs/${mine.id}`, { body: { title: 'x' } })).status,
      ).toBe(403)
      expect((await nobody.request('DELETE', `/api/v1/docs/${mine.id}`)).status).toBe(403)
      // Anonymous: 401.
      expect((await t.request('DELETE', `/api/v1/docs/${mine.id}`)).status).toBe(401)
      const list = await bob.request<{ data: { title: string }[] }>('GET', '/api/v1/docs')
      expect(list.body.data.map((d) => d.title).sort()).toEqual(['A2', 'B'])
    } finally {
      await t.close()
    }
  })

  it('the manifest offers row actions an owner can perform on their own rows', async () => {
    const t = await createTestApp({ resources: [Doc], permissions: ownership })
    try {
      const caps = async (actor: Actor) => {
        const r = await t
          .actingAs(actor, { tenantId: TENANT_A })
          .request<{ resources: { name: string; capabilities: Record<string, boolean> }[] }>(
            'GET',
            '/.well-known/strutvane.json',
          )
        return r.body.resources.find((x) => x.name === 'Doc')?.capabilities
      }
      expect(await caps(ALICE)).toMatchObject({
        list: true,
        view: true,
        create: true,
        update: true,
        delete: true,
        restore: true,
      })
      // No grant at all: the resource is not even listed.
      expect(await caps(NOBODY)).toBeUndefined()
    } finally {
      await t.close()
    }
  })

  it('a provider whose filter allows rows but whose record check refuses still blocks the write', async () => {
    // Defence in depth: the record-level check runs for delete even when the row is in scope.
    const inconsistent: PermissionProvider = {
      can: async (actor, permission, resource) =>
        String(permission).endsWith('.delete') && resource?.record
          ? { allowed: false, reason: 'record says no' }
          : { allowed: actor !== null, reason: 'test' },
      filterFor: async () => ({ op: 'true' }),
    }
    const t = await createTestApp({ resources: [Doc], permissions: inconsistent })
    try {
      const doc = await t.repository(Doc).create({ title: 'A' }, { tenantId: TENANT_A })
      const alice = t.actingAs(ALICE, { tenantId: TENANT_A })
      expect((await alice.request('DELETE', `/api/v1/docs/${doc.id}`)).status).toBe(403)
      expect(await t.repository(Doc).count(undefined, { tenantId: TENANT_A })).toBe(1)
    } finally {
      await t.close()
    }
  })
})
