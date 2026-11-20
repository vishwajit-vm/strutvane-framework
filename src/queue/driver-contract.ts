/**
 * The queue-driver contract suite (RFC-0006 §10): the behaviour every driver must have, as
 * runner-agnostic cases. The framework runs it against its memory and database drivers (on every
 * engine); add-ons such as `@strutvane/redis` run the same cases against theirs:
 *
 * ```ts
 * import { queueDriverContract } from '@strutvane/framework/testing'
 * for (const contractCase of queueDriverContract({ idempotentPush: false })) {
 *   test(contractCase.name, () => contractCase.run(makeRedisDriver))
 * }
 * ```
 *
 * Each case throws (`node:assert`) on a violation, so it works with Vitest, Jest or `node:test`.
 *
 * @module
 */
import assert from 'node:assert/strict'
import type { QueueDriver, ReservedJob } from '../contracts/queue.ts'
import type { TestClock } from '../core/clock.ts'
import { createTestClock } from '../core/clock.ts'

/**
 * What a case gets from the driver factory: a driver, optionally a second one on a separate
 * connection to the same backend (another "process"), and a cleanup.
 *
 * @example
 * const setup: DriverSetup = { driver, cleanup: () => connection.close() }
 */
export interface DriverSetup {
  readonly driver: QueueDriver
  /** A second driver over another connection to the same queue, for race cases. */
  readonly second?: QueueDriver
  cleanup(): Promise<void>
}

/**
 * Builds a fresh, empty driver on the given clock with `retryAfter` seconds of visibility.
 *
 * @example
 * const make: DriverFactory = async (clock) => ({ driver: new MemoryQueueDriver({ clock, retryAfter: 90 }), cleanup: async () => {} })
 */
export type DriverFactory = (clock: TestClock, retryAfter: number) => Promise<DriverSetup>

/**
 * One contract case.
 *
 * @example
 * await contractCase.run(make)
 */
export interface DriverContractCase {
  readonly name: string
  run(make: DriverFactory): Promise<void>
}

/**
 * Options for {@link queueDriverContract}.
 *
 * @example
 * queueDriverContract({ idempotentPush: false, usesClock: false })
 */
export interface DriverContractOptions {
  /** The driver honours `PushOptions.id` (a second push with the same id is ignored). Default true. */
  readonly idempotentPush?: boolean
  /**
   * The driver reads time from the given clock (memory, database). A driver on the server's
   * clock (Redis `TIME`) sets `false`, and the time-travel cases are skipped. Default true.
   */
  readonly usesClock?: boolean
  /** Jobs in the race case. Default 40. */
  readonly raceJobs?: number
}

const RETRY_AFTER = 30

async function withDriver(
  make: DriverFactory,
  work: (setup: DriverSetup, clock: TestClock) => Promise<void>,
): Promise<void> {
  const clock = createTestClock(Date.UTC(2026, 10, 20))
  const setup = await make(clock, RETRY_AFTER)
  try {
    await work(setup, clock)
  } finally {
    await setup.cleanup()
  }
}

async function popOrFail(driver: QueueDriver, queue: string): Promise<ReservedJob> {
  const job = await driver.pop(queue)
  assert.ok(job !== undefined, `expected a job on "${queue}"`)
  return job
}

/**
 * The contract cases.
 *
 * @example
 * for (const c of queueDriverContract()) test(c.name, () => c.run(make))
 */
export function queueDriverContract(
  options: DriverContractOptions = {},
): readonly DriverContractCase[] {
  const idempotent = options.idempotentPush ?? true
  const usesClock = options.usesClock ?? true
  const raceJobs = options.raceJobs ?? 40
  const cases: DriverContractCase[] = [
    {
      name: 'push, pop and ack: the payload comes back as given, attempts start at 1',
      run: (make) =>
        withDriver(make, async ({ driver }) => {
          const payload = '{"hello":"wörld ✓","n":1}'
          const id = await driver.push('default', payload)
          assert.equal(await driver.size('default'), 1)
          const job = await popOrFail(driver, 'default')
          assert.equal(job.id, id)
          assert.equal(job.queue, 'default')
          assert.equal(job.payload, payload)
          assert.equal(job.attempts, 1)
          assert.equal(await driver.pop('default'), undefined, 'a reserved job is not popped twice')
          assert.equal(await driver.ack(job), true)
          assert.equal(await driver.ack(job), false, 'a second ack reports false')
          assert.equal(await driver.size('default'), 0)
        }),
    },
    {
      name: 'jobs come out in the order they were pushed',
      run: (make) =>
        withDriver(make, async ({ driver }, clock) => {
          const ids: string[] = []
          for (let i = 0; i < 5; i++) {
            ids.push(await driver.push('default', `{"i":${i}}`))
            if (usesClock) clock.advance(1)
          }
          const seen: string[] = []
          for (let i = 0; i < 5; i++) {
            const job = await popOrFail(driver, 'default')
            seen.push(job.id)
            await driver.ack(job)
          }
          assert.deepEqual(seen, ids)
        }),
    },
    {
      name: 'queues are separate, and clear() empties one queue only',
      run: (make) =>
        withDriver(make, async ({ driver }) => {
          await driver.push('a', '{}')
          await driver.push('a', '{}')
          await driver.push('b', '{}')
          assert.equal(await driver.size('a'), 2)
          assert.equal(await driver.clear('a'), 2)
          assert.equal(await driver.size('a'), 0)
          assert.equal(await driver.size('b'), 1)
          assert.equal((await popOrFail(driver, 'b')).queue, 'b')
        }),
    },
    {
      name: 'invalid queue names are refused',
      run: (make) =>
        withDriver(make, async ({ driver }) => {
          await assert.rejects(driver.push('bad queue; DROP', '{}'))
          await assert.rejects(driver.pop('../etc'))
        }),
    },
    {
      name: 'release() puts a job back; a stale receipt can neither ack nor release',
      run: (make) =>
        withDriver(make, async ({ driver }) => {
          await driver.push('default', '{}')
          const first = await popOrFail(driver, 'default')
          assert.equal(await driver.release(first), true)
          assert.equal(await driver.release(first), false)
          const second = await popOrFail(driver, 'default')
          assert.equal(second.id, first.id)
          assert.equal(second.attempts, 2)
          assert.equal(await driver.ack(first), false, 'the old receipt no longer owns the job')
          assert.equal(await driver.ack(second), true)
        }),
    },
  ]
  if (usesClock) {
    cases.push(
      {
        name: 'a delayed job is invisible until it is due',
        run: (make) =>
          withDriver(make, async ({ driver }, clock) => {
            await driver.push('default', '{}', { delaySeconds: 60 })
            assert.equal(await driver.size('default'), 1)
            assert.equal(await driver.pop('default'), undefined)
            clock.advance(59_000)
            assert.equal(await driver.pop('default'), undefined)
            clock.advance(1000)
            assert.ok(await driver.pop('default'))
          }),
      },
      {
        name: 'release(job, delay) delays the next attempt',
        run: (make) =>
          withDriver(make, async ({ driver }, clock) => {
            await driver.push('default', '{}')
            await driver.release(await popOrFail(driver, 'default'), 10)
            assert.equal(await driver.pop('default'), undefined)
            clock.advance(10_000)
            assert.equal((await popOrFail(driver, 'default')).attempts, 2)
          }),
      },
      {
        name: 'a crashed worker’s job comes back when its reservation runs out',
        run: (make) =>
          withDriver(make, async ({ driver, second }, clock) => {
            const other = second ?? driver
            await driver.push('default', '{}')
            const lost = await popOrFail(driver, 'default')
            clock.advance(RETRY_AFTER * 1000 - 1)
            assert.equal(await other.pop('default'), undefined, 'still reserved')
            clock.advance(1)
            const again = await popOrFail(other, 'default')
            assert.equal(again.id, lost.id)
            assert.equal(again.attempts, 2)
            assert.equal(await driver.ack(lost), false, 'the crashed worker can no longer ack it')
            assert.equal(await driver.release(lost), false)
            assert.equal(await other.ack(again), true)
          }),
      },
    )
  }
  if (idempotent) {
    cases.push({
      name: 'a push with an existing id is ignored (idempotent push)',
      run: (make) =>
        withDriver(make, async ({ driver }) => {
          const id = '0193a000-0000-7000-8000-00000000abcd'
          assert.equal(await driver.push('default', '{"first":true}', { id }), id)
          assert.equal(await driver.push('default', '{"second":true}', { id }), id)
          assert.equal(await driver.size('default'), 1)
          assert.equal((await popOrFail(driver, 'default')).payload, '{"first":true}')
        }),
    })
  }
  cases.push({
    name: `two workers racing over ${raceJobs} jobs never reserve one job twice`,
    run: (make) =>
      withDriver(make, async ({ driver, second }) => {
        for (let i = 0; i < raceJobs; i++) await driver.push('race', `{"i":${i}}`)
        const seen = new Map<string, number>()
        const consumer = async (from: QueueDriver): Promise<void> => {
          for (;;) {
            const job = await from.pop('race')
            if (job === undefined) {
              if ((await from.size('race')) === 0) return
              continue
            }
            seen.set(job.id, (seen.get(job.id) ?? 0) + 1)
            assert.equal(await from.ack(job), true, 'a reserved job is acked by its owner')
          }
        }
        const other = second ?? driver
        await Promise.all([consumer(driver), consumer(other), consumer(driver), consumer(other)])
        assert.equal(seen.size, raceJobs)
        for (const [id, count] of seen)
          assert.equal(count, 1, `job ${id} was reserved ${count} times`)
      }),
  })
  return Object.freeze(cases)
}
