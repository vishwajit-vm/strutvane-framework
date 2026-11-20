/**
 * Batches (RFC-0006 §7.1) and the transactional outbox (§8).
 *
 * Batches run on the memory store and on the database store over every engine; the outbox needs
 * a database (it writes in the caller's transaction), so its cases run on every engine. The
 * at-least-once cases deliver a member twice and check it is counted once and that `then`,
 * `catch` and `finally` are pushed exactly once.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { QueueDriver, ReservedJob } from '../../src/contracts/queue.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { createLogger } from '../../src/core/logger/logger.ts'
import type { Connection } from '../../src/database/db/connection.ts'
import { DatabaseBatchRepository } from '../../src/queue/batches.ts'
import { DatabaseQueueDriver } from '../../src/queue/drivers/database.ts'
import { MemoryQueueDriver } from '../../src/queue/drivers/memory.ts'
import { defineJob } from '../../src/queue/job.ts'
import { QueueManager } from '../../src/queue/manager.ts'
import { DatabaseOutboxStore } from '../../src/queue/outbox.ts'
import { DatabaseFailedJobStore, DatabaseQueueLockStore } from '../../src/queue/stores.ts'
import { createQueueTables } from '../../src/queue/tables.ts'
import { Worker } from '../../src/queue/worker.ts'
import { ENGINES, engineTitle, type OpenDatabase } from '../migrations/v2/engines.ts'
import { harness, runWithDispatcher } from './support.ts'

function jobs(log: string[]) {
  const Item = defineJob({
    name: 'batch-item',
    async handle(data: { n: number; fail?: boolean }, ctx) {
      if (data.fail === true) throw new Error(`item ${data.n} failed`)
      const batch = await ctx.batch()
      log.push(`item:${data.n}:${batch?.cancelled === true ? 'cancelled' : 'live'}`)
    },
  })
  const Hook = defineJob({
    name: 'batch-hook',
    async handle(data: { kind: string }) {
      log.push(`hook:${data.kind}`)
    },
  })
  return { Item, Hook }
}

describe('batches (memory)', () => {
  test('then and finally run once after every job succeeded; progress is tracked', async () => {
    const h = harness()
    const log: string[] = []
    const { Item, Hook } = jobs(log)
    h.jobs.register(Item, Hook)
    const id = await runWithDispatcher(h.manager, () =>
      h.manager
        .batch([Item.with({ n: 1 }), Item.with({ n: 2 }), Item.with({ n: 3 })])
        .name('three')
        .onSuccess(Hook.with({ kind: 'then' }))
        .onFailure(Hook.with({ kind: 'catch' }))
        .onFinish(Hook.with({ kind: 'finally' }))
        .dispatch(),
    )
    expect(await h.manager.findBatch(id)).toMatchObject({
      name: 'three',
      total: 3,
      pending: 3,
      progress: 0,
      finished: false,
    })
    await h.manager.processNext('main', ['default'])
    expect((await h.manager.findBatch(id))?.progress).toBe(33)
    while (await h.manager.processNext('main', ['default'])) {}
    expect(log).toEqual(['item:1:live', 'item:2:live', 'item:3:live', 'hook:then', 'hook:finally'])
    expect(await h.manager.findBatch(id)).toMatchObject({
      pending: 0,
      failed: 0,
      progress: 100,
      finished: true,
    })
  })

  test('a failure cancels the batch, runs catch once, skips then, still runs finally', async () => {
    const h = harness()
    const log: string[] = []
    const { Item, Hook } = jobs(log)
    h.jobs.register(Item, Hook)
    const id = await runWithDispatcher(h.manager, () =>
      h.manager
        .batch([
          Item.with({ n: 1, fail: true }),
          Item.with({ n: 2, fail: true }),
          Item.with({ n: 3 }),
        ])
        .onSuccess(Hook.with({ kind: 'then' }))
        .onFailure(Hook.with({ kind: 'catch' }))
        .onFinish(Hook.with({ kind: 'finally' }))
        .dispatch(),
    )
    while (await h.manager.processNext('main', ['default'])) {}
    expect(log.filter((line) => line.startsWith('hook:'))).toEqual(['hook:catch', 'hook:finally'])
    expect(log).toContain('item:3:cancelled')
    expect(await h.manager.findBatch(id)).toMatchObject({
      failed: 2,
      pending: 0,
      cancelled: true,
      finished: true,
    })
  })

  test('allowFailures: not cancelled, catch once, then skipped because something failed', async () => {
    const h = harness()
    const log: string[] = []
    const { Item, Hook } = jobs(log)
    h.jobs.register(Item, Hook)
    const id = await runWithDispatcher(h.manager, () =>
      h.manager
        .batch([Item.with({ n: 1, fail: true }), Item.with({ n: 2 })])
        .allowFailures()
        .onSuccess(Hook.with({ kind: 'then' }))
        .onFailure(Hook.with({ kind: 'catch' }))
        .onFinish(Hook.with({ kind: 'finally' }))
        .dispatch(),
    )
    while (await h.manager.processNext('main', ['default'])) {}
    expect(log).toEqual(['item:2:live', 'hook:catch', 'hook:finally'])
    expect((await h.manager.findBatch(id))?.cancelled).toBe(false)
  })

  test('the batch and chain builders are not thenables (awaiting one never dispatches it)', async () => {
    const h = harness()
    const { Hook } = jobs([])
    const batch = h.manager.batch([]).onSuccess(Hook.with({ kind: 'x' }))
    const chain = h.manager.chain([Hook.with({ kind: 'x' })])
    expect('then' in batch).toBe(false)
    expect('then' in chain).toBe(false)
    expect(await batch).toBe(batch)
    expect(await h.driver.size('default')).toBe(0)
  })

  test('an empty batch finishes at once', async () => {
    const h = harness()
    const log: string[] = []
    const { Hook } = jobs(log)
    h.jobs.register(Hook)
    const id = await runWithDispatcher(h.manager, () =>
      h.manager
        .batch([])
        .onSuccess(Hook.with({ kind: 'then' }))
        .onFinish(Hook.with({ kind: 'finally' }))
        .dispatch(),
    )
    while (await h.manager.processNext('main', ['default'])) {}
    expect(log).toEqual(['hook:then', 'hook:finally'])
    expect(await h.manager.findBatch(id)).toMatchObject({ total: 0, progress: 100, finished: true })
  })

  test('cancelBatch() is visible to the remaining jobs; unique jobs are refused in batches', async () => {
    const h = harness()
    const log: string[] = []
    const { Item } = jobs(log)
    h.jobs.register(Item)
    const id = await runWithDispatcher(h.manager, () =>
      h.manager.batch([Item.with({ n: 1 }), Item.with({ n: 2 })]).dispatch(),
    )
    await h.manager.processNext('main', ['default'])
    expect(await h.manager.cancelBatch(id)).toBe(true)
    expect(await h.manager.cancelBatch(id)).toBe(false)
    await h.manager.processNext('main', ['default'])
    expect(log).toEqual(['item:1:live', 'item:2:cancelled'])
    const Unique = defineJob({
      name: 'unique-member',
      unique: { key: () => 'x', for: 60 },
      async handle(_data: unknown) {},
    })
    await expect(
      runWithDispatcher(h.manager, () => h.manager.batch([Unique.with({})]).dispatch()),
    ).rejects.toMatchObject({ code: 'queue_invalid_option' })
  })

  test('a member delivered twice (crash before ack) counts once; hooks run once', async () => {
    let crashOnce = true
    const h = harness({
      driver: (clock) => {
        const inner = new MemoryQueueDriver({ clock, retryAfter: 90 })
        const driver: QueueDriver = {
          push: (queue, payload, options) => inner.push(queue, payload, options),
          pop: (queue, options) => inner.pop(queue, options),
          release: (job, delay) => inner.release(job, delay),
          size: (queue) => inner.size(queue),
          clear: (queue) => inner.clear(queue),
          ack: async (job: ReservedJob) => {
            if (crashOnce) {
              crashOnce = false
              throw new Error('worker died')
            }
            return inner.ack(job)
          },
        }
        return driver
      },
    })
    const log: string[] = []
    const Twice = defineJob({
      name: 'twice',
      tries: 2,
      async handle(_data: unknown) {
        log.push('item')
      },
    })
    const { Hook } = jobs(log)
    h.jobs.register(Twice, Hook)
    const id = await runWithDispatcher(h.manager, () =>
      h.manager
        .batch([Twice.with({})])
        .onSuccess(Hook.with({ kind: 'then' }))
        .dispatch(),
    )
    await expect(h.manager.processNext('main', ['default'])).rejects.toThrow('worker died')
    h.clock.advance(90_000)
    while (await h.manager.processNext('main', ['default'])) {}
    expect([...log].sort()).toEqual(['hook:then', 'item', 'item'])
    expect(await h.manager.findBatch(id)).toMatchObject({ total: 1, pending: 0, failed: 0 })
  })

  test('without a batch store, batches explain what to do', async () => {
    const h = harness()
    const bare = new QueueManager({
      connections: [
        {
          name: 'main',
          driver: h.driver,
          defaultQueue: 'default',
          retryAfter: 90,
          afterCommit: false,
        },
      ],
      defaultConnection: 'main',
      signer: h.signer,
      jobs: h.jobs,
      failed: h.failed,
      locks: h.locks,
      logger: createLogger({ sink: () => {} }),
    })
    const Item = defineJob({ name: 'lonely', async handle(_data: unknown) {} })
    await expect(bare.batch([Item.with({})]).dispatch()).rejects.toMatchObject({
      code: 'queue_not_configured',
    })
    await expect(bare.findBatch('x')).rejects.toMatchObject({ code: 'queue_not_configured' })
    expect(await bare.relayOutbox()).toBe(0)
    await expect(
      runWithDispatcher(bare, () => Item.dispatch({}, { viaOutbox: true })),
    ).rejects.toMatchObject({ code: 'queue_not_configured' })
  })
})

for (const engine of ENGINES) {
  describe.skipIf(engine.skipped !== undefined)(
    `batches and outbox on ${engineTitle(engine)}`,
    () => {
      let db: OpenDatabase
      beforeEach(async () => {
        db = await engine.open()
        await createQueueTables(db.connection)
      })
      afterEach(async () => {
        await db.close()
      })

      function onDatabase(connection: Connection) {
        return harness({
          driver: (clock) => new DatabaseQueueDriver({ connection, clock, retryAfter: 90 }),
          failed: new DatabaseFailedJobStore({ connection }),
          locks: (clock) => new DatabaseQueueLockStore({ connection, clock }),
          batches: (clock) => new DatabaseBatchRepository({ connection, clock }),
          outbox: (clock) => new DatabaseOutboxStore({ connection, clock }),
        })
      }

      test('the batch store: CAS bookkeeping counts each member once and claims once', async () => {
        const clock = createTestClock()
        const batches = new DatabaseBatchRepository({ connection: db.connection, clock })
        const ids = Array.from({ length: 230 }, (_, i) => `job-${i}`)
        await batches.create({ id: 'b1', name: 'big', jobIds: ids })
        expect(await batches.find('b1')).toMatchObject({ total: 230, pending: 230, progress: 0 })
        expect((await batches.recordSuccess('b1', 'job-0')).counted).toBe(true)
        expect((await batches.recordSuccess('b1', 'job-0')).counted).toBe(false)
        expect((await batches.recordFailure('b1', 'job-0')).counted).toBe(false)
        expect((await batches.recordFailure('b1', 'job-1')).status).toMatchObject({
          pending: 228,
          failed: 1,
        })
        expect(await batches.claimCaught('b1')).toBe(true)
        expect(await batches.claimCaught('b1')).toBe(false)
        expect(await batches.claimFinished('b1')).toBe(false)
        // Concurrently, in waves: the counters must still end exact (each member counted once).
        for (let start = 2; start < ids.length; start += 20)
          await Promise.all(ids.slice(start, start + 20).map((id) => batches.recordSuccess('b1', id)))
        expect(await batches.claimFinished('b1')).toBe(true)
        expect(await batches.claimFinished('b1')).toBe(false)
        expect(await batches.find('b1')).toMatchObject({ pending: 0, failed: 1, finished: true })
        expect(await batches.find('missing')).toBeUndefined()
        expect(await batches.prune(clock.now())).toBe(0)
        clock.advance(1)
        expect(await batches.prune(clock.now())).toBe(1)
        expect(await batches.find('b1')).toBeUndefined()
      })

      test('a batch runs end to end with then and finally exactly once', async () => {
        const h = onDatabase(db.connection)
        const log: string[] = []
        const { Item, Hook } = jobs(log)
        h.jobs.register(Item, Hook)
        const id = await runWithDispatcher(h.manager, () =>
          h.manager
            .batch([1, 2, 3, 4].map((n) => Item.with({ n })))
            .onSuccess(Hook.with({ kind: 'then' }))
            .onFinish(Hook.with({ kind: 'finally' }))
            .dispatch(),
        )
        const result = await new Worker(h.manager, { stopWhenEmpty: true, memory: 100_000 }).run()
        expect(result.processed).toBe(6)
        expect([...log.filter((line) => line.startsWith('hook:'))].sort()).toEqual([
          'hook:finally',
          'hook:then',
        ])
        expect(await h.manager.findBatch(id)).toMatchObject({
          pending: 0,
          progress: 100,
          finished: true,
        })
      })

      test('the outbox: written in the transaction, gone with a rollback, relayed by the worker', async () => {
        const h = onDatabase(db.connection)
        const log: string[] = []
        const Job = defineJob({
          name: 'outboxed',
          async handle(data: { n: number }) {
            log.push(`ran:${data.n}`)
          },
        })
        h.jobs.register(Job)
        await runWithDispatcher(h.manager, async () => {
          await db.connection.transaction(async () => {
            await Job.with({ n: 1 }).viaOutbox().dispatch()
          })
          await expect(
            db.connection.transaction(async () => {
              await Job.dispatch({ n: 2 }, { viaOutbox: true })
              throw new Error('roll back')
            }),
          ).rejects.toThrow('roll back')
          await Job.dispatch({ n: 3 }, { viaOutbox: true, delay: 60 })
        })
        expect(await h.driver.size('default')).toBe(0)
        const outbox = new DatabaseOutboxStore({ connection: db.connection, clock: h.clock })
        expect(await outbox.pending()).toBe(2)
        await new Worker(h.manager, { stopWhenEmpty: true, memory: 100_000 }).run()
        expect(log).toEqual(['ran:1'])
        expect(await outbox.pending()).toBe(1)
        h.clock.advance(60_000)
        await new Worker(h.manager, { stopWhenEmpty: true, memory: 100_000 }).run()
        expect(log).toEqual(['ran:1', 'ran:3'])
        expect(await outbox.pending()).toBe(0)
        h.clock.advance(1)
        expect(await outbox.prune(h.clock.now())).toBe(2)
      })

      test('two relays never push one outbox row twice; a crashed relay’s row comes back', async () => {
        const clock = createTestClock()
        const outbox = new DatabaseOutboxStore({ connection: db.connection, clock })
        for (let n = 0; n < 10; n++)
          await outbox.add({
            id: `o${n}`,
            connection: 'main',
            queue: 'default',
            payload: '{}',
            availableAt: clock.now(),
          })
        const [a, b] = await Promise.all([outbox.claim(10, 30), outbox.claim(10, 30)])
        const claimedIds = [...a.messages, ...b.messages].map((m) => m.id)
        expect(new Set(claimedIds).size).toBe(claimedIds.length)
        expect(claimedIds).toHaveLength(10)
        // Nobody marks anything (both relays "crashed"): after the claim runs out, rows come back.
        expect((await outbox.claim(10, 30)).messages).toHaveLength(0)
        clock.advance(30_000)
        const again = await outbox.claim(10, 30)
        expect(again.messages).toHaveLength(10)
        expect(await outbox.markDispatched('o0', a.claim)).toBe(false)
        expect(await outbox.markDispatched('o0', again.claim)).toBe(true)
        expect(await outbox.markDispatched('o0', again.claim)).toBe(false)
      })

      test('a relay without an outbox table turns itself off once, with a hint', async () => {
        const h = harness({
          outbox: () =>
            new DatabaseOutboxStore({ connection: db.connection, table: 'missing_outbox' }),
        })
        expect(await h.manager.relayOutbox()).toBe(0)
        expect(await h.manager.relayOutbox()).toBe(0)
        expect(h.logs.filter((line) => line.includes('outbox relay is off'))).toHaveLength(1)
      })
    },
  )
}
