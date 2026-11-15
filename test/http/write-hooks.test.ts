/**
 * Write hooks run in two stages:
 * - `onWrite`, inside the write's transaction: a failure rolls the write back, so data and the
 *   work that must go with it (an audit record, a running total) can never disagree. Audit plugs
 *   in here (`resource.onWrite`), with the transaction handle.
 * - `afterCommit` (and the `after*` hooks, and domain events), after the commit: the write has
 *   happened, so a failure there is logged and never turns the response into a 500 for a write
 *   that actually succeeded (which would make the client retry and write twice).
 *
 * The class covered: every write action (create, update, delete, restore) through both stages,
 * on both engines.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../../src/contracts/index.ts'
import { DomainError, EventBusToken, HooksToken, LoggerToken } from '../../src/core/index.ts'
import { createRepository, type DataRecord } from '../../src/data/repository.ts'
import type { Database } from '../../src/database/types.ts'
import { defineResource, type ResourceHooks, type WriteChange } from '../../src/http/resource.ts'
import type { ResourceOnWritePayload } from '../../src/http/resource-routes.ts'
import { migrationSource } from '../../src/migrations/files.ts'
import { migrate } from '../../src/migrations/migrator.ts'
import { planMigration } from '../../src/migrations/planner.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createModelRegistry } from '../../src/model/registry.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { createDatabase, DIALECTS } from '../helpers/engines.ts'

const BASE = '/api/v1'
const Deal = defineModel('Deal', { name: field.string(80) }, { softDeletes: true, audit: true })
const Ledger = defineModel('Ledger', { note: field.string(120) })
const user: Actor = { id: 'u1', type: 'user', roles: [], attrs: {} }

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

async function boot(hooks: ResourceHooks, dialect: 'sqlite' | 'postgres' = 'sqlite') {
  t = await createTestApp({
    dialect,
    resources: [defineResource(Deal, { hooks })],
    models: [Ledger],
  })
  return { app: t, client: t.actingAs(user) }
}

const notes = async (app: TestApp): Promise<string[]> =>
  (await app.repository(Ledger).list()).data.map((r) => String(r['note'])).sort()

describe.each(DIALECTS)('write hooks on %s', (dialect) => {
  it('onWrite runs inside the transaction for every action, with the record and previous', async () => {
    const seen: string[] = []
    const { app, client } = await boot(
      {
        onWrite: async (change, ctx) => {
          seen.push(
            `${change.action}:${String(change.record['name'])}:${String(change.previous?.['name'] ?? '-')}`,
          )
          // Same transaction: this row commits or rolls back with the write.
          await ctx
            .repositoryFor('Ledger')
            .create({ note: `${change.action} ${change.record.id}` }, {})
        },
      },
      dialect,
    )
    const created = await client.request<{ id: string }>('POST', `${BASE}/deals`, {
      body: { name: 'A' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    expect(
      (await client.request('PATCH', `${BASE}/deals/${id}`, { body: { name: 'B' } })).status,
    ).toBe(200)
    expect((await client.request('DELETE', `${BASE}/deals/${id}`)).status).toBe(204)
    expect((await client.request('POST', `${BASE}/deals/${id}/restore`)).status).toBe(200)
    expect(seen).toEqual(['create:A:-', 'update:B:A', 'delete:B:-', 'restore:B:-'])
    expect(await notes(app)).toEqual([
      `create ${id}`,
      `delete ${id}`,
      `restore ${id}`,
      `update ${id}`,
    ])
  })

  it('an onWrite failure rolls back every action and answers with that error', async () => {
    let fail = false
    const { app, client } = await boot(
      {
        onWrite: async (change, ctx) => {
          await ctx.repositoryFor('Ledger').create({ note: `half ${change.action}` }, {})
          if (fail) throw new DomainError('LEDGER_CLOSED')
        },
      },
      dialect,
    )
    const ok = await client.request<{ id: string }>('POST', `${BASE}/deals`, {
      body: { name: 'A' },
    })
    const id = ok.body.id
    fail = true
    const create = await client.request<{ code: string }>('POST', `${BASE}/deals`, {
      body: { name: 'X' },
    })
    expect(create.status).toBe(422)
    expect(create.body.code).toBe('LEDGER_CLOSED')
    expect(
      (await client.request('PATCH', `${BASE}/deals/${id}`, { body: { name: 'B' } })).status,
    ).toBe(422)
    expect((await client.request('DELETE', `${BASE}/deals/${id}`)).status).toBe(422)
    // Nothing changed: one deal, still named A and not deleted; only the first ledger row.
    const deals = await app.repository(Deal).list()
    expect(deals.data.map((d) => d['name'])).toEqual(['A'])
    expect(await notes(app)).toEqual(['half create'])
    await app.repository(Deal).delete(id)
    expect((await client.request('POST', `${BASE}/deals/${id}/restore`)).status).toBe(422)
    expect(await app.repository(Deal).find(id)).toBeUndefined()
  })

  it('resource.onWrite (where audit plugs in) gets the transaction; its failure rolls back', async () => {
    const { app, client } = await boot({}, dialect)
    const payloads: ResourceOnWritePayload[] = []
    let fail = false
    app.app.make(HooksToken).on(
      'resource.onWrite',
      async (payload) => {
        const p = payload as ResourceOnWritePayload
        payloads.push(p)
        const marks = p.db.dialect === 'postgres' ? '$1, $2, $3, $4' : '?, ?, ?, ?'
        await p.db.execute(
          `INSERT INTO "ledgers" ("id", "note", "created_at", "updated_at") VALUES (${marks})`,
          [
            crypto.randomUUID(),
            `audit ${p.action}`,
            '2026-11-15T00:00:00Z',
            '2026-11-15T00:00:00Z',
          ],
        )
        if (fail) throw new Error('audit sink down')
        return undefined
      },
      { name: 'test.audit' },
    )
    const created = await client.request<{ id: string }>('POST', `${BASE}/deals`, {
      body: { name: 'A' },
    })
    expect(created.status).toBe(201)
    expect(payloads[0]).toMatchObject({
      resource: 'Deal',
      type: 'deal',
      action: 'create',
      audited: true,
      actor: user,
    })
    expect(payloads[0]?.requestId).toEqual(expect.any(String))
    fail = true
    const update = await client.request('PATCH', `${BASE}/deals/${created.body.id}`, {
      body: { name: 'B' },
    })
    expect(update.status).toBe(500)
    expect(payloads[1]?.previous?.['name']).toBe('A')
    expect((await app.repository(Deal).find(created.body.id))?.['name']).toBe('A')
    expect(await notes(app)).toEqual(['audit create'])
  })
})

describe('after-commit stage: failures are logged, never change the response', () => {
  it('afterCommit, after* hooks, resource.afterCommit and events failing: still 201, logged', async () => {
    const order: string[] = []
    const { app, client } = await boot({
      afterCreate: () => {
        order.push('afterCreate')
        throw new Error('legacy hook failed')
      },
      afterCommit: (change: WriteChange) => {
        order.push(`afterCommit:${change.action}`)
        throw new Error('webhook down')
      },
    })
    const logger = app.app.make(LoggerToken)
    const error = vi.spyOn(logger, 'error')
    app.app.make(HooksToken).on(
      'resource.afterCommit',
      () => {
        order.push('resource.afterCommit')
        throw new Error('search index down')
      },
      { name: 'test.after' },
    )
    app.app.make(EventBusToken).on('deal.created', () => {
      order.push('event')
      throw new Error('listener failed')
    })
    const res = await client.request<{ id: string; name: string }>('POST', `${BASE}/deals`, {
      body: { name: 'A' },
    })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('A')
    expect(await app.repository(Deal).find(res.body.id)).toBeDefined()
    expect(order).toEqual(['afterCreate', 'afterCommit:create', 'resource.afterCommit', 'event'])
    const logged = error.mock.calls.map((c) => c[0])
    // Three from the hooks; the event bus isolates and reports its own listener failures.
    expect(logged.filter((m) => m.includes('after the commit')).length).toBe(3)
    // The log names the stage, the resource and the request, never just "error".
    expect(error.mock.calls[0]?.[1]).toMatchObject({ resource: 'Deal', action: 'create' })
  })

  it('afterCommit runs only after a commit: never for a write that rolled back', async () => {
    const committed: string[] = []
    const { client } = await boot({
      onWrite: () => {
        throw new DomainError('NOPE')
      },
      afterCommit: (change) => {
        committed.push(change.action)
      },
    })
    expect((await client.request('POST', `${BASE}/deals`, { body: { name: 'A' } })).status).toBe(
      422,
    )
    expect(committed).toEqual([])
  })
})

describe.each(DIALECTS)('repository write callback on %s', (dialect) => {
  it('a throwing onWrite rolls the write back; it sees the written row on the transaction', async () => {
    const db: Database = await createDatabase(dialect)
    try {
      const registry = createModelRegistry([Deal.definition])
      const plan = await planMigration({ dialect, previous: [], next: registry.all })
      await migrate(db, [migrationSource('0001', plan.statements)])
      const repo = createRepository({
        db,
        model: Deal.definition,
        registry,
        ids: () => crypto.randomUUID(),
      })
      let inside: DataRecord | undefined
      await expect(
        repo.create(
          { name: 'A' },
          {},
          {
            onWrite: async (record, tx) => {
              inside = (await tx.query<DataRecord>('SELECT * FROM "deals"'))[0]
              expect(record['name']).toBe('A')
              throw new Error('rollback')
            },
          },
        ),
      ).rejects.toThrow('rollback')
      expect(inside?.['name']).toBe('A')
      expect(await repo.count()).toBe(0)
    } finally {
      await db.close()
    }
  })
})
