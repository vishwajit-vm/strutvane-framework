/**
 * The job lifecycle (RFC-0006 §3–§9) on the memory driver: dispatch, retries with backoff,
 * final failure, poison messages, crash loops, timeouts, release, unique jobs, chains, tenancy,
 * the sync connection and the observability events.
 */
import { describe, expect, test } from 'vitest'
import type { QueueDriver, ReservedJob } from '../../src/contracts/queue.ts'
import { currentTenant } from '../../src/database/orm/tenancy.ts'
import { MemoryQueueDriver } from '../../src/queue/drivers/memory.ts'
import { isQueueError } from '../../src/queue/errors.ts'
import { defineJob } from '../../src/queue/job.ts'
import { harness, runWithDispatcher } from './support.ts'

const TENANT = '0193a000-0000-7000-8000-0000000000aa'

describe('dispatch and process', () => {
  test('a dispatched job runs once with its data, then is gone', async () => {
    const h = harness()
    const seen: unknown[] = []
    const Hello = defineJob({
      name: 'hello',
      async handle(data: { name: string }, ctx) {
        seen.push({ data, attempt: ctx.attempt, queue: ctx.queue, connection: ctx.connection })
      },
    })
    h.jobs.register(Hello)
    const id = await runWithDispatcher(h.manager, () => Hello.dispatch({ name: 'Ada' }))
    expect(typeof id).toBe('string')
    expect(await h.driver.size('default')).toBe(1)
    const result = await h.manager.processNext('main', ['default'])
    expect(result).toEqual({ jobId: id, job: 'hello', outcome: 'processed' })
    expect(seen).toEqual([
      { data: { name: 'Ada' }, attempt: 1, queue: 'default', connection: 'main' },
    ])
    expect(await h.driver.size('default')).toBe(0)
    expect(await h.manager.processNext('main', ['default'])).toBeUndefined()
    expect(h.events.map((e) => e.type)).toEqual([
      'queue.job.queued',
      'queue.job.processing',
      'queue.job.processed',
    ])
  })

  test('the data is never written to the log or the events', async () => {
    const h = harness()
    const Job = defineJob({
      name: 'secretive',
      tries: 2,
      async handle(_data: { note: string }) {
        throw new Error('boom')
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, () => Job.dispatch({ note: 'top-secret-note' }))
    await h.manager.processNext('main', ['default'])
    h.clock.advance(60_000)
    await h.manager.processNext('main', ['default'])
    expect(h.logs.join('\n')).not.toContain('top-secret-note')
    expect(JSON.stringify(h.events)).not.toContain('top-secret-note')
  })

  test('queues are read in priority order; options override the job defaults', async () => {
    const h = harness()
    const order: string[] = []
    const Job = defineJob({
      name: 'ordered',
      queue: 'low',
      async handle(data: { n: string }) {
        order.push(data.n)
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      await Job.dispatch({ n: 'low-1' })
      await Job.dispatch({ n: 'high-1' }, { queue: 'high' })
      await Job.with({ n: 'high-2' }).onQueue('high').dispatch()
    })
    while (await h.manager.processNext('main', ['high', 'low'])) {}
    expect(order).toEqual(['high-1', 'high-2', 'low-1'])
  })

  test('delays: seconds or a Date', async () => {
    const h = harness()
    const ran: string[] = []
    const Job = defineJob({
      name: 'later',
      async handle(data: { n: string }) {
        ran.push(data.n)
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      await Job.dispatch({ n: 'a' }, { delay: 30 })
      await Job.with({ n: 'b' })
        .delay(new Date(h.clock.now() + 60_000))
        .dispatch()
    })
    expect(await h.manager.processNext('main', ['default'])).toBeUndefined()
    h.clock.advance(30_000)
    await h.manager.processNext('main', ['default'])
    expect(ran).toEqual(['a'])
    h.clock.advance(30_000)
    await h.manager.processNext('main', ['default'])
    expect(ran).toEqual(['a', 'b'])
  })

  test('dispatch refuses bad data before anything is queued', async () => {
    const h = harness()
    const Job = defineJob({ name: 'strict', async handle(_data: unknown) {} })
    await runWithDispatcher(h.manager, async () => {
      await expect(Job.dispatch({ at: new Date() })).rejects.toMatchObject({
        code: 'queue_payload_not_plain',
      })
      await expect(Job.dispatch({ password: 'x' })).rejects.toMatchObject({
        code: 'queue_payload_sensitive',
      })
      await expect(Job.dispatch({}, { queue: 'bad queue' })).rejects.toMatchObject({
        code: 'queue_invalid_name',
      })
      await expect(Job.dispatch({}, { connection: 'mian' })).rejects.toMatchObject({
        code: 'queue_connection_unknown',
      })
    })
    expect(await h.driver.size('default')).toBe(0)
  })

  test('a job timeout at or above the connection retryAfter is refused at dispatch', async () => {
    const h = harness({ retryAfter: 60 })
    const Job = defineJob({ name: 'slow', timeout: 60, async handle(_data: unknown) {} })
    await expect(runWithDispatcher(h.manager, () => Job.dispatch({}))).rejects.toMatchObject({
      code: 'queue_timeout_not_below_retry_after',
    })
  })

  test('dispatching outside an app explains what to do', async () => {
    const Job = defineJob({ name: 'orphan', async handle(_data: unknown) {} })
    await expect(async () => Job.dispatch({})).rejects.toMatchObject({
      code: 'no_current_application',
    })
  })
})

describe('retries and failures', () => {
  test('failed attempts are retried after their backoff, then succeed', async () => {
    const h = harness()
    let calls = 0
    const Flaky = defineJob({
      name: 'flaky',
      tries: 3,
      backoff: [10, 60],
      async handle(_data: unknown) {
        calls++
        if (calls < 3) throw new Error(`attempt ${calls} failed`)
      },
    })
    h.jobs.register(Flaky)
    await runWithDispatcher(h.manager, () => Flaky.dispatch({}))
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('released')
    h.clock.advance(9_999)
    expect(await h.manager.processNext('main', ['default'])).toBeUndefined()
    h.clock.advance(1)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('released')
    h.clock.advance(60_000)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('processed')
    expect(calls).toBe(3)
    expect(await h.failed.all()).toEqual([])
  })

  test('the last failure goes to the failed store and calls failed() once', async () => {
    const h = harness()
    const failures: string[] = []
    const Doomed = defineJob({
      name: 'doomed',
      tries: 2,
      async handle(_data: { id: string }) {
        throw Object.assign(new Error('smtp refused'), { code: 'smtp_refused' })
      },
      async failed(data, error, ctx) {
        failures.push(`${data.id}:${error.message}:${ctx.attempt}`)
      },
    })
    h.jobs.register(Doomed)
    const id = await runWithDispatcher(h.manager, () => Doomed.dispatch({ id: 'x1' }))
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('released')
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('failed')
    expect(await h.manager.processNext('main', ['default'])).toBeUndefined()
    expect(failures).toEqual(['x1:smtp refused:2'])
    const [record] = await h.failed.all()
    expect(record).toMatchObject({
      id,
      job: 'doomed',
      connection: 'main',
      queue: 'default',
      error: { message: 'smtp refused', code: 'smtp_refused' },
    })
    expect(await h.driver.size('default')).toBe(0)
    expect(h.events.at(-1)).toMatchObject({ type: 'queue.job.failed', errorCode: 'smtp_refused' })
  })

  test('a failed() hook that throws is logged, and the failure is still recorded', async () => {
    const h = harness()
    const Job = defineJob({
      name: 'hook-throws',
      async handle(_data: unknown) {
        throw new Error('first')
      },
      async failed() {
        throw new Error('hook broke')
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, () => Job.dispatch({}))
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('failed')
    expect(await h.failed.all()).toHaveLength(1)
    expect(h.logs.join('\n')).toContain('failed() hook threw')
  })

  test('ctx.fail() stops retrying; ctx.release() retries without counting a failure', async () => {
    const h = harness()
    let released = false
    const Picky = defineJob({
      name: 'picky',
      tries: 5,
      async handle(data: { mode: string }, ctx) {
        if (data.mode === 'fail') ctx.fail('not worth retrying')
        else if (!released) {
          released = true
          ctx.release(5)
        }
      },
    })
    h.jobs.register(Picky)
    await runWithDispatcher(h.manager, async () => {
      await Picky.dispatch({ mode: 'fail' })
      await Picky.dispatch({ mode: 'release' })
    })
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('failed')
    expect((await h.failed.all())[0]?.error.message).toBe('not worth retrying')
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('released')
    h.clock.advance(5_000)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('processed')
  })

  test('retryUntil ends retries even when tries remain', async () => {
    const h = harness()
    const Job = defineJob({
      name: 'deadline',
      tries: 100,
      backoff: 60,
      retryUntil: 90,
      async handle(_data: unknown) {
        throw new Error('nope')
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, () => Job.dispatch({}))
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('released')
    h.clock.advance(60_000)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('released')
    h.clock.advance(60_000)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('failed')
  })

  test('a job that keeps crashing the worker is failed without running once its tries are used', async () => {
    const h = harness({ retryAfter: 90 })
    let runs = 0
    const Crasher = defineJob({
      name: 'crasher',
      tries: 2,
      async handle(_data: unknown) {
        runs++
      },
    })
    h.jobs.register(Crasher)
    await runWithDispatcher(h.manager, () => Crasher.dispatch({}))
    // Two workers reserve it and "die" (never ack): the reservation simply runs out.
    await h.driver.pop('default')
    h.clock.advance(90_000)
    await h.driver.pop('default')
    h.clock.advance(90_000)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('failed')
    expect(runs).toBe(0)
    expect((await h.failed.all())[0]?.error).toMatchObject({ code: 'queue_max_attempts_exceeded' })
  })
})

describe('poison messages', () => {
  async function poisoned(
    payload: (signed: string) => string,
  ): Promise<ReturnType<typeof harness>> {
    const h = harness()
    const Job = defineJob({
      name: 'victim',
      async handle(_data: { n: number }) {
        throw new Error('must never run')
      },
    })
    h.jobs.register(Job)
    const signed = h.signer.encode({
      v: 1,
      id: '0193a000-0000-7000-8000-000000000123',
      job: 'victim',
      data: { n: 1 },
      queue: 'default',
      connection: 'main',
      dispatchedAt: h.clock.now(),
      tries: 3,
      backoff: [1],
      timeout: 10,
    })
    await h.driver.push('default', payload(signed))
    return h
  }

  test.each([
    ['a tampered row', (s: string) => s.replace('"n":1', '"n":2'), 'queue_payload_tampered'],
    ['garbage', () => '\u0000not json', 'queue_payload_tampered'],
    ['an unsigned row', (s: string) => s.replace(/,"sig":"[^"]+"/, ''), 'queue_payload_tampered'],
  ])(
    '%s is moved to the failed store without running, and never retried',
    async (_what, edit, code) => {
      const h = await poisoned(edit)
      expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('poisoned')
      expect(await h.driver.size('default')).toBe(0)
      const [record] = await h.failed.all()
      expect(record?.error.code).toBe(code)
      await expect(h.manager.retryFailed(record?.id ?? '')).rejects.toMatchObject({ code })
    },
  )

  test('an unknown job name is poison, with a did-you-mean in the failure', async () => {
    const h = harness()
    const signed = h.signer.encode({
      v: 1,
      id: 'x',
      job: 'victm',
      data: {},
      queue: 'default',
      connection: 'main',
      dispatchedAt: 0,
      tries: 1,
      backoff: [0],
      timeout: 10,
    })
    h.jobs.register(defineJob({ name: 'victim', async handle(_data: unknown) {} }))
    await h.driver.push('default', signed)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('poisoned')
    const [record] = await h.failed.all()
    expect(record).toMatchObject({ job: 'victm', error: { code: 'queue_job_unknown' } })
    expect(record?.error.message).toContain('victm')
  })

  test('data that fails the job schema is poison (an older deploy’s shape)', async () => {
    const h = harness()
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) =>
          typeof (value as { id?: unknown }).id === 'string'
            ? { value: value as { id: string } }
            : { issues: [{ message: 'id must be a string', path: ['id'] }] },
      },
    }
    const Job = defineJob({ name: 'typed', schema, async handle(_data: { id: string }) {} })
    h.jobs.register(Job)
    await expect(
      runWithDispatcher(h.manager, () => Job.dispatch({ id: 1 } as unknown as { id: string })),
    ).rejects.toMatchObject({ code: 'queue_payload_invalid' })
    const signed = h.signer.encode({
      v: 1,
      id: 'y',
      job: 'typed',
      data: { id: 7 },
      queue: 'default',
      connection: 'main',
      dispatchedAt: 0,
      tries: 1,
      backoff: [0],
      timeout: 10,
    })
    await h.driver.push('default', signed)
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('poisoned')
    expect((await h.failed.all())[0]?.error.message).toContain('id must be a string')
  })
})

describe('timeouts', () => {
  test('a job that outruns its timeout fails the attempt and its signal aborts', async () => {
    const h = harness()
    let aborted = false
    const Slow = defineJob({
      name: 'slow-job',
      timeout: 1,
      tries: 2,
      async handle(_data: unknown, ctx) {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true
            resolve()
          })
        })
      },
    })
    h.jobs.register(Slow)
    await runWithDispatcher(h.manager, () => Slow.dispatch({}))
    const result = await h.manager.processNext('main', ['default'])
    expect(result?.outcome).toBe('released')
    expect(aborted).toBe(true)
    await result?.stillRunning
    expect(h.events.at(-1)).toMatchObject({ errorCode: 'queue_job_timed_out' })
  })
})

describe('unique jobs', () => {
  test('a second dispatch is skipped while the first is queued, and allowed once it starts', async () => {
    const h = harness()
    const runs: string[] = []
    const Sync = defineJob({
      name: 'sync-account',
      unique: { key: (data: { account: string }) => data.account, for: 600 },
      async handle(data) {
        runs.push(data.account)
      },
    })
    h.jobs.register(Sync)
    await runWithDispatcher(h.manager, async () => {
      expect(await Sync.dispatch({ account: 'a' })).toBeTypeOf('string')
      expect(await Sync.dispatch({ account: 'a' })).toBeUndefined()
      expect(await Sync.dispatch({ account: 'b' })).toBeTypeOf('string')
    })
    expect(h.events.filter((e) => e.type === 'queue.job.skipped')).toHaveLength(1)
    await h.manager.processNext('main', ['default'])
    await runWithDispatcher(h.manager, async () => {
      expect(await Sync.dispatch({ account: 'a' })).toBeTypeOf('string')
    })
  })

  test("until: 'completed' holds the lock until the job finished, also when it failed", async () => {
    const h = harness()
    const Job = defineJob({
      name: 'unique-completed',
      unique: { key: () => 'one', for: 600, until: 'completed' },
      async handle(_data: unknown) {
        throw new Error('fails')
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      await Job.dispatch({})
    })
    expect(await h.locks.acquire('queue:unique:unique-completed:one', 'other', 1)).toBe(false)
    await h.manager.processNext('main', ['default'])
    expect(await h.locks.acquire('queue:unique:unique-completed:one', 'other', 1)).toBe(true)
  })

  test('the lock expires by itself after `for` seconds', async () => {
    const h = harness()
    const Job = defineJob({
      name: 'unique-expiring',
      unique: { key: () => 'k', for: 60 },
      async handle(_data: unknown) {},
    })
    await runWithDispatcher(h.manager, async () => {
      await Job.dispatch({})
      expect(await Job.dispatch({})).toBeUndefined()
      h.clock.advance(60_000)
      expect(await Job.dispatch({})).toBeTypeOf('string')
    })
  })
})

describe('chains', () => {
  test('steps run in order, each only after the previous one succeeded', async () => {
    const h = harness()
    const order: string[] = []
    const Step = defineJob({
      name: 'step',
      async handle(data: { n: string }) {
        order.push(data.n)
      },
    })
    h.jobs.register(Step)
    await runWithDispatcher(h.manager, () =>
      h.manager
        .chain([Step.with({ n: '1' }), Step.with({ n: '2' }), Step.with({ n: '3' })])
        .dispatch(),
    )
    expect(await h.driver.size('default')).toBe(1)
    while (await h.manager.processNext('main', ['default'])) {}
    expect(order).toEqual(['1', '2', '3'])
  })

  test('a failing step stops the chain and pushes the catch job once', async () => {
    const h = harness()
    const order: string[] = []
    const Step = defineJob({
      name: 'chain-step',
      async handle(data: { n: string }) {
        if (data.n === 'bad') throw new Error('step failed')
        order.push(data.n)
      },
    })
    const Caught = defineJob({
      name: 'chain-caught',
      async handle(data: { why: string }) {
        order.push(`caught:${data.why}`)
      },
    })
    h.jobs.register(Step, Caught)
    await runWithDispatcher(h.manager, () =>
      h.manager
        .chain([Step.with({ n: 'a' }), Step.with({ n: 'bad' }), Step.with({ n: 'never' })])
        .onFailure(Caught.with({ why: 'x' }))
        .dispatch(),
    )
    while (await h.manager.processNext('main', ['default'])) {}
    expect(order).toEqual(['a', 'caught:x'])
  })

  test('the next step’s id is derived, so a repeated push after a crash is a no-op', async () => {
    let crashOnce = true
    const h = harness({
      driver: (clock) => {
        const inner = new MemoryQueueDriver({ clock, retryAfter: 90 })
        // The first ack "crashes the worker": step 2 was pushed, step 1 was never acknowledged.
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
    const runs: string[] = []
    const Step = defineJob({
      name: 'idem-step',
      tries: 2,
      async handle(data: { n: string }) {
        runs.push(data.n)
      },
    })
    h.jobs.register(Step)
    await runWithDispatcher(h.manager, () =>
      h.manager.chain([Step.with({ n: '1' }), Step.with({ n: '2' })]).dispatch(),
    )
    await expect(h.manager.processNext('main', ['default'])).rejects.toThrow('worker died')
    h.clock.advance(90_000)
    while (await h.manager.processNext('main', ['default'])) {}
    expect(runs).toEqual(['1', '1', '2'])
  })

  test('an empty chain is refused', async () => {
    const h = harness()
    await expect(h.manager.chain([]).dispatch()).rejects.toMatchObject({
      code: 'queue_invalid_option',
    })
  })
})

describe('tenancy', () => {
  test('the dispatching tenant is restored in the job, and is signed', async () => {
    const h = harness()
    const tenants: (string | undefined)[] = []
    const Job = defineJob({
      name: 'tenant-aware',
      async handle(_data: unknown, ctx) {
        tenants.push(currentTenant(), ctx.tenantId)
      },
    })
    h.jobs.register(Job)
    const { runWithTenant } = await import('../../src/database/orm/tenancy.ts')
    await runWithDispatcher(h.manager, async () => {
      await runWithTenant(TENANT, () => Job.dispatch({}))
      await Job.dispatch({})
    })
    while (await h.manager.processNext('main', ['default'])) {}
    expect(tenants).toEqual([TENANT, TENANT, undefined, undefined])
  })
})

describe('the sync connection and dispatchSync', () => {
  test('sync runs at dispatch, retries back to back and throws the final error', async () => {
    const h = harness()
    let calls = 0
    const failed: string[] = []
    const Job = defineJob({
      name: 'sync-job',
      tries: 3,
      backoff: 3600,
      async handle(data: { ok: boolean }) {
        calls++
        if (!data.ok) throw new Error('always')
      },
      failed(_data, error) {
        failed.push(error.message)
      },
    })
    await runWithDispatcher(h.manager, async () => {
      await Job.dispatch({ ok: true }, { connection: 'sync' })
      expect(calls).toBe(1)
      await expect(Job.dispatch({ ok: false }, { connection: 'sync' })).rejects.toThrow('always')
      expect(calls).toBe(4)
      expect(failed).toEqual(['always'])
      await Job.dispatchSync({ ok: true })
      expect(calls).toBe(5)
    })
  })

  test('a sync job that releases itself forever still stops', async () => {
    const h = harness()
    const Job = defineJob({
      name: 'sync-release',
      tries: 2,
      async handle(_data: unknown, ctx) {
        ctx.release(1)
      },
    })
    await expect(runWithDispatcher(h.manager, () => Job.dispatchSync({}))).rejects.toSatisfy(
      (error: unknown) => isQueueError(error) && error.code === 'queue_max_attempts_exceeded',
    )
  })
})

describe('queue:retry', () => {
  test('a failed job is pushed again and removed from the failed store', async () => {
    const h = harness()
    let fail = true
    const Job = defineJob({
      name: 'retry-me',
      async handle(_data: unknown) {
        if (fail) throw new Error('down')
      },
    })
    h.jobs.register(Job)
    const id = await runWithDispatcher(h.manager, () => Job.dispatch({}))
    await h.manager.processNext('main', ['default'])
    expect(await h.failed.find(id ?? '')).toBeDefined()
    fail = false
    expect(await h.manager.retryFailed(id ?? '')).toBe(true)
    expect(await h.failed.find(id ?? '')).toBeUndefined()
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('processed')
    expect(await h.manager.retryFailed('missing')).toBe(false)
  })
})

describe('observability', () => {
  test('a throwing listener never breaks processing', async () => {
    const h = harness()
    h.manager.listen(() => {
      throw new Error('dashboard down')
    })
    const Job = defineJob({ name: 'observed', async handle(_data: unknown) {} })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, () => Job.dispatch({}))
    expect((await h.manager.processNext('main', ['default']))?.outcome).toBe('processed')
    expect(h.logs.join('\n')).toContain('listener threw')
  })
})
