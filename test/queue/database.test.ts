/**
 * The queue on real engines (RFC-0006 §5, §7.2, §10): the database failed-job and lock stores,
 * `afterCommit` dispatch through `Connection.afterCommit`, and two workers on separate pools that
 * never run one job twice. SQLite and PGlite in process; MySQL, MariaDB and PostgreSQL as
 * throwaway servers (skipped with the reason when Docker is off).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTestClock } from '../../src/core/clock.ts'
import type { Connection } from '../../src/database/db/connection.ts'
import { sql } from '../../src/database/sql/fragment.ts'
import { DatabaseQueueDriver } from '../../src/queue/drivers/database.ts'
import { defineJob } from '../../src/queue/job.ts'
import { DatabaseFailedJobStore, DatabaseQueueLockStore } from '../../src/queue/stores.ts'
import { createQueueTables } from '../../src/queue/tables.ts'
import { WORKER_EXIT, Worker } from '../../src/queue/worker.ts'
import { ENGINES, engineTitle, type OpenDatabase } from '../migrations/v2/engines.ts'
import { harness, runWithDispatcher, signingKey } from './support.ts'

for (const engine of ENGINES) {
  describe.skipIf(engine.skipped !== undefined)(`queue on ${engineTitle(engine)}`, () => {
    let db: OpenDatabase
    beforeEach(async () => {
      db = await engine.open()
      await createQueueTables(db.connection)
      // Running it twice is harmless (apps without migrations call it at start-up).
      await createQueueTables(db.connection)
    })
    afterEach(async () => {
      await db.close()
    })

    function onDatabase(connection: Connection, key = signingKey()) {
      const clock = createTestClock()
      return harness({
        clock,
        key,
        driver: (c) => new DatabaseQueueDriver({ connection, clock: c, retryAfter: 90 }),
        failed: new DatabaseFailedJobStore({ connection }),
        locks: (c) => new DatabaseQueueLockStore({ connection, clock: c }),
        transactions: () => ({
          inTransaction: () => connection.inTransaction(),
          afterCommit: (callback, onRollback) => {
            void connection.afterCommit(callback, { onRollback })
          },
        }),
      })
    }

    test('the failed-job store records, lists, finds, forgets and flushes', async () => {
      const store = new DatabaseFailedJobStore({ connection: db.connection })
      const base = { connection: 'main', queue: 'default', job: 'j', payload: '{"x":1}' }
      await store.log({
        ...base,
        id: 'a',
        error: { name: 'Error', message: 'one' },
        failedAt: 1000,
      })
      await store.log({
        ...base,
        id: 'b',
        error: { name: 'QueueError', message: 'two', code: 'queue_job_timed_out', stack: 'at x' },
        failedAt: 2000,
      })
      await store.log({
        ...base,
        id: 'a',
        error: { name: 'Error', message: 'again' },
        failedAt: 3000,
      })
      expect((await store.all()).map((r) => r.id)).toEqual(['a', 'b'])
      expect(await store.find('b')).toMatchObject({ error: { code: 'queue_job_timed_out' } })
      expect((await store.find('a'))?.error.message).toBe('again')
      expect(await store.find('missing')).toBeUndefined()
      expect(await store.forget('a')).toBe(true)
      expect(await store.forget('a')).toBe(false)
      await store.log({ ...base, id: 'c', error: { name: 'Error', message: 'c' }, failedAt: 500 })
      expect(await store.flush(1000)).toBe(1)
      expect(await store.flush()).toBe(1)
      expect(await store.all()).toEqual([])
    })

    test('the lock store: one owner at a time, expiry, release only by the owner', async () => {
      const clock = createTestClock()
      const locks = new DatabaseQueueLockStore({ connection: db.connection, clock })
      expect(await locks.acquire('k', 'one', 60)).toBe(true)
      expect(await locks.acquire('k', 'two', 60)).toBe(false)
      expect(await locks.release('k', 'two')).toBe(false)
      clock.advance(60_000)
      expect(await locks.acquire('k', 'two', 60)).toBe(true)
      expect(await locks.release('k', 'one')).toBe(false)
      expect(await locks.release('k', 'two')).toBe(true)
      expect(await locks.acquire('k', 'three', 60)).toBe(true)
    })

    test.skipIf(!engine.server)('two pools racing for one lock: exactly one wins', async () => {
      const other = db.second?.()
      if (other === undefined) return
      const clock = createTestClock()
      const a = new DatabaseQueueLockStore({ connection: db.connection, clock })
      const b = new DatabaseQueueLockStore({ connection: other, clock })
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).acquire('race', `o${i}`, 60)),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    test('afterCommit: pushed only when the transaction commits, never after a rollback', async () => {
      const h = onDatabase(db.connection)
      const Job = defineJob({ name: 'after-commit', async handle(_data: { n: number }) {} })
      await runWithDispatcher(h.manager, async () => {
        await db.connection.transaction(async () => {
          await Job.with({ n: 1 }).afterCommit().dispatch()
          expect(await h.driver.size('default')).toBe(0)
        })
        expect(await h.driver.size('default')).toBe(1)
        await expect(
          db.connection.transaction(async () => {
            await Job.dispatch({ n: 2 }, { afterCommit: true })
            throw new Error('roll back')
          }),
        ).rejects.toThrow('roll back')
        await db.connection.transaction(async () => {
          await Job.dispatch({ n: 3 }, { afterCommit: true })
          await db.connection
            .transaction(async () => {
              await Job.dispatch({ n: 4 }, { afterCommit: true })
              throw new Error('savepoint only')
            })
            .catch(() => undefined)
        })
        // Outside a transaction it is pushed at once.
        await Job.dispatch({ n: 5 }, { afterCommit: true })
      })
      const pushed: unknown[] = []
      for (;;) {
        const job = await h.driver.pop('default')
        if (job === undefined) break
        pushed.push(h.signer.decode(job.payload).data)
      }
      expect(pushed).toEqual([{ n: 1 }, { n: 3 }, { n: 5 }])
    })

    test('a job and its failure survive in the database; queue:retry runs it again', async () => {
      const h = onDatabase(db.connection)
      let fail = true
      const Job = defineJob({
        name: 'db-retry',
        async handle(_data: unknown) {
          if (fail) throw new Error('remote down')
        },
      })
      h.jobs.register(Job)
      const id = await runWithDispatcher(h.manager, () => Job.dispatch({}))
      expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('failed')
      expect((await h.failed.find(id ?? ''))?.error.message).toBe('remote down')
      fail = false
      expect(await h.manager.retryFailed(id ?? '')).toBe(true)
      expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('processed')
      expect(await h.failed.all()).toEqual([])
    })

    test('a row edited in the jobs table is refused, not run', async () => {
      const h = onDatabase(db.connection)
      let ran = false
      const Job = defineJob({
        name: 'guarded',
        async handle(_data: { amount: number }) {
          ran = true
        },
      })
      h.jobs.register(Job)
      await runWithDispatcher(h.manager, () => Job.dispatch({ amount: 1 }))
      const { rows } = await db.connection.run(sql`SELECT id, payload FROM ${sql.id('jobs')}`)
      const row = rows[0]
      const edited = String(row?.['payload']).replace('"amount":1', '"amount":1000000')
      await db.connection.run(
        sql`UPDATE ${sql.id('jobs')} SET payload = ${edited} WHERE id = ${String(row?.['id'])}`,
      )
      expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('poisoned')
      expect(ran).toBe(false)
      expect((await h.failed.all())[0]?.error.code).toBe('queue_payload_tampered')
    })

    test.skipIf(!engine.server)(
      'two workers on separate pools run each of 30 jobs exactly once',
      async () => {
        const other = db.second?.()
        if (other === undefined) return
        const key = signingKey()
        const first = onDatabase(db.connection, key)
        const second = onDatabase(other, key)
        const runs = new Map<number, number>()
        const Job = defineJob({
          name: 'exactly-once',
          async handle(data: { n: number }) {
            runs.set(data.n, (runs.get(data.n) ?? 0) + 1)
            await new Promise((resolve) => setTimeout(resolve, 2))
          },
        })
        first.jobs.register(Job)
        second.jobs.register(Job)
        await runWithDispatcher(first.manager, async () => {
          for (let n = 0; n < 30; n++) await Job.dispatch({ n })
        })
        const results = await Promise.all([
          new Worker(first.manager, { stopWhenEmpty: true, memory: 1_000_000 }).run(),
          new Worker(second.manager, { stopWhenEmpty: true, memory: 1_000_000 }).run(),
          new Worker(first.manager, { stopWhenEmpty: true, memory: 1_000_000 }).run(),
        ])
        expect(results.every((r) => r.code === WORKER_EXIT.ok)).toBe(true)
        expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(30)
        expect(runs.size).toBe(30)
        expect([...runs.values()].every((count) => count === 1)).toBe(true)
      },
    )
  })
}
