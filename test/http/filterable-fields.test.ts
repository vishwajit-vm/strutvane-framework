/**
 * Field-level filter rules: when the PermissionProvider implements `filterableFields`, list
 * queries (GET filters/sort/search, `POST /query`, cursors) may only reference the fields it
 * returns. Without the method, the model's own allow-lists apply unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Actor, PermissionProvider } from '../../src/contracts/index.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { narrowQueryFields, queryFields } from '../../src/query/fields.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { DIALECTS } from '../helpers/engines.ts'

const BASE = '/api/v1'

const Memo = defineModel('Memo', {
  title: field.string(80).searchable().sortable().filterable(),
  secretNote: field.string(80).searchable().sortable().filterable(),
})

const reader: Actor = { id: 'u1', type: 'user', roles: [], attrs: {} }

interface Problem {
  status: number
  issues?: { path: (string | number)[]; code: string }[]
}
interface Page {
  data: { title: string; secretNote: string }[]
  meta: { page: { nextCursor?: string } }
}

/** Allows everything; `filterableFields` (when enabled) excludes `secretNote`. */
function provider(withMethod: boolean) {
  const calls: { actor: string | null; type: string }[] = []
  const base: PermissionProvider = {
    can: async () => ({ allowed: true, reason: 'test' }),
    filterFor: async () => ({ op: 'true' }),
  }
  const p: PermissionProvider = withMethod
    ? {
        ...base,
        async filterableFields(actor, type) {
          calls.push({ actor: actor?.id ?? null, type })
          return new Set(['id', 'title', 'createdAt', 'updatedAt'])
        },
      }
    : base
  return { p, calls }
}

describe('narrowQueryFields', () => {
  it('intersects with the allowed set, or returns the fields unchanged without one', () => {
    const all = queryFields(Memo.definition)
    expect(narrowQueryFields(all, undefined)).toBe(all)
    expect([...narrowQueryFields(all, new Set(['title', 'nope'])).keys()]).toEqual(['title'])
  })
})

describe.each(DIALECTS)('filterableFields on %s', (dialect) => {
  let t: TestApp | undefined
  afterEach(async () => {
    await t?.close()
    t = undefined
  })

  const setup = async (withMethod: boolean) => {
    const { p, calls } = provider(withMethod)
    t = await createTestApp({ dialect, resources: [Memo], permissions: p })
    const repo = t.repository(Memo)
    await repo.create({ title: 'Alpha', secretNote: 'hush' })
    await repo.create({ title: 'hush-title', secretNote: 'plain' })
    await repo.create({ title: 'Beta', secretNote: 'plain' })
    return { app: t, client: t.actingAs(reader), calls }
  }

  it('rejects GET filters and sorts on a field outside the set (all issues at once)', async () => {
    const { client } = await setup(true)
    const res = await client.request<Problem>(
      'GET',
      `${BASE}/memos?filter[secretNote][eq]=hush&sort=secretNote`,
    )
    expect(res.status).toBe(422)
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['query', 'filter', 'secretNote', 'eq'],
          code: 'filter_not_allowed',
        }),
        expect.objectContaining({ path: ['query', 'sort'], code: 'sort_not_allowed' }),
      ]),
    )
  })

  it('rejects POST /query filters (nested too) and sorts on a field outside the set', async () => {
    const { client } = await setup(true)
    const filter = await client.request<Problem>('POST', `${BASE}/memos/query`, {
      body: {
        filter: {
          op: 'or',
          filters: [
            { op: 'eq', field: 'title', value: 'Alpha' },
            { op: 'not', filter: { op: 'startsWith', field: 'secretNote', value: 'h' } },
          ],
        },
      },
    })
    expect(filter.status).toBe(422)
    expect(filter.body.issues?.[0]).toMatchObject({ path: ['filter'], code: 'filter_not_allowed' })
    const sort = await client.request<Problem>('POST', `${BASE}/memos/query`, {
      body: { sort: [{ field: 'secretNote', direction: 'asc' }] },
    })
    expect(sort.status).toBe(422)
    expect(sort.body.issues?.[0]).toMatchObject({ path: ['sort'], code: 'sort_not_allowed' })
  })

  it('search silently skips searchable fields outside the set', async () => {
    const { client } = await setup(true)
    const get = await client.request<Page>('GET', `${BASE}/memos?search=hush`)
    expect(get.status).toBe(200)
    expect(get.body.data.map((r) => r.title)).toEqual(['hush-title'])
    const post = await client.request<Page>('POST', `${BASE}/memos/query`, {
      body: { search: 'hush' },
    })
    expect(post.status).toBe(200)
    expect(post.body.data.map((r) => r.title)).toEqual(['hush-title'])
  })

  it('allowed fields filter, sort and page by cursor; the provider is asked once per request', async () => {
    const { client, calls } = await setup(true)
    const get = await client.request<Page>(
      'GET',
      `${BASE}/memos?filter[title][startsWith]=hush&sort=-title`,
    )
    expect(get.status).toBe(200)
    expect(get.body.data.map((r) => r.title)).toEqual(['hush-title'])
    expect(calls).toEqual([{ actor: 'u1', type: 'memo' }])

    const sort = [{ field: 'title', direction: 'asc' }]
    const first = await client.request<Page>('POST', `${BASE}/memos/query`, {
      body: { sort, page: { size: 2 } },
    })
    expect(first.body.data.map((r) => r.title)).toEqual(['Alpha', 'Beta'])
    const cursor = first.body.meta.page.nextCursor
    expect(cursor).toBeTypeOf('string')
    const second = await client.request<Page>('POST', `${BASE}/memos/query`, {
      body: { sort, page: { size: 2, cursor } },
    })
    expect(second.status).toBe(200)
    expect(second.body.data.map((r) => r.title)).toEqual(['hush-title'])
    expect(calls).toHaveLength(3)
  })

  it('a provider without filterableFields keeps the model allow-lists alone', async () => {
    const { client } = await setup(false)
    const get = await client.request<Page>(
      'GET',
      `${BASE}/memos?filter[secretNote][eq]=plain&sort=secretNote,title`,
    )
    expect(get.status).toBe(200)
    expect(get.body.data.map((r) => r.title)).toEqual(['Beta', 'hush-title'])
    const post = await client.request<Page>('POST', `${BASE}/memos/query`, {
      body: { filter: { op: 'eq', field: 'secretNote', value: 'hush' }, search: 'hush' },
    })
    expect(post.status).toBe(200)
    expect(post.body.data.map((r) => r.title)).toEqual(['Alpha'])
    const search = await client.request<Page>('GET', `${BASE}/memos?search=hush&sort=title`)
    expect(search.body.data.map((r) => r.title)).toEqual(['Alpha', 'hush-title'])
  })
})

describe('includes follow the fields the actor may read', () => {
  const Team = defineModel('Team', {
    name: field.string(80).filterable(),
    members: field.hasMany('Member', 'team'),
  })
  const Member = defineModel('Member', {
    name: field.string(80).filterable(),
    team: field.belongsTo('Team').optional(),
  })
  let t: TestApp | undefined
  afterEach(async () => {
    await t?.close()
    t = undefined
  })

  /** Everything is visible, except the link fields (`Member.team`) are not readable. */
  const setup = async (readable: Readonly<Record<string, readonly string[]>>) => {
    const p: PermissionProvider = {
      can: async () => ({ allowed: true, reason: 'test' }),
      filterFor: async () => ({ op: 'true' }),
      filterableFields: async (_actor, type) => new Set(readable[type] ?? []),
    }
    t = await createTestApp({
      dialect: 'sqlite',
      resources: [
        { model: Team, includes: ['members'] },
        { model: Member, includes: ['team'] },
      ],
      permissions: p,
    })
    const team = await t.repository(Team).create({ name: 'Red' })
    const member = await t.repository(Member).create({ name: 'Ann', team: team.id })
    return { client: t.actingAs(reader), team: team.id, member: member.id }
  }

  it('an include whose link field the actor may not read is refused on every list and show path', async () => {
    const { client, team, member } = await setup({
      team: ['id', 'name'],
      member: ['id', 'name'],
    })
    for (const [method, path, body] of [
      ['GET', `${BASE}/members?include=team`, undefined],
      ['GET', `${BASE}/members/${member}?include=team`, undefined],
      ['POST', `${BASE}/members/query`, { include: ['team'] }],
      ['GET', `${BASE}/teams?include=members`, undefined],
      ['GET', `${BASE}/teams/${team}?include=members`, undefined],
      ['POST', `${BASE}/teams/query`, { include: ['members'] }],
    ] as const) {
      const res = await client.request<Problem>(method, path, body ? { body } : {})
      expect(res.status, `${method} ${path}`).toBe(422)
      expect(res.body.issues?.[0]?.code).toBe('include_not_allowed')
    }
  })

  it('includes work when the link field is readable', async () => {
    const { client, team, member } = await setup({
      team: ['id', 'name'],
      member: ['id', 'name', 'team'],
    })
    const show = await client.request<{ included: { team: { id: string } } }>(
      'GET',
      `${BASE}/members/${member}?include=team`,
    )
    expect(show.status).toBe(200)
    expect(show.body.included.team.id).toBe(team)
    const list = await client.request<{ data: { included: { members: unknown[] } }[] }>(
      'GET',
      `${BASE}/teams?include=members`,
    )
    expect(list.status).toBe(200)
    expect(list.body.data[0]?.included.members).toHaveLength(1)
  })
})
