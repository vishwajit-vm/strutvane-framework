/**
 * The worker loop (RFC-0006 §4): graceful stop that drains the running job, the limits, the
 * restart signal and the "handler never stopped" exit.
 */
import { describe, expect, test } from 'vitest'
import { defineJob } from '../../src/queue/job.ts'
import { WORKER_EXIT, Worker } from '../../src/queue/worker.ts'
import { harness, runWithDispatcher } from './support.ts'

describe('Worker', () => {
  test('--stop-when-empty processes everything, then stops', async () => {
    const h = harness()
    const done: number[] = []
    const Job = defineJob({
      name: 'count',
      async handle(data: { n: number }) {
        done.push(data.n)
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      for (let n = 0; n < 5; n++) await Job.dispatch({ n })
    })
    const result = await new Worker(h.manager, { stopWhenEmpty: true }).run()
    expect(result).toEqual({ code: WORKER_EXIT.ok, reason: 'empty', processed: 5 })
    expect(done).toEqual([0, 1, 2, 3, 4])
    expect(h.events.map((e) => e.type)).toContain('queue.worker.started')
    expect(h.events.at(-1)).toMatchObject({ type: 'queue.worker.stopping', reason: 'empty' })
  })

  test('stop() (SIGTERM) lets the running job finish and acknowledges it, then exits 0', async () => {
    const h = harness()
    let release: () => void = () => {}
    let started: () => void = () => {}
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const finished: string[] = []
    const Job = defineJob({
      name: 'long',
      async handle(data: { n: string }) {
        started()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        finished.push(data.n)
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      await Job.dispatch({ n: 'first' })
      await Job.dispatch({ n: 'second' })
    })
    const worker = new Worker(h.manager, { sleep: 1 })
    const run = worker.run()
    await running
    worker.stop()
    worker.stop()
    expect(worker.stopping).toBe(true)
    release()
    const result = await run
    expect(result).toEqual({ code: 0, reason: 'stopped', processed: 1 })
    expect(finished).toEqual(['first'])
    expect(await h.driver.size('default')).toBe(1)
  })

  test('stop() wakes a sleeping worker at once', async () => {
    const h = harness()
    const worker = new Worker(h.manager, { sleep: 3600 })
    const run = worker.run()
    await new Promise((resolve) => setTimeout(resolve, 20))
    worker.stop()
    expect((await run).reason).toBe('stopped')
  })

  test.each([
    ['max-jobs', { maxJobs: 2 }, 2],
    ['memory', { memory: 1, memoryUsage: () => 2 * 1024 * 1024 }, 1],
  ] as const)('stops for %s between jobs', async (reason, options, processed) => {
    const h = harness()
    const Job = defineJob({ name: 'tiny', async handle(_data: unknown) {} })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      for (let n = 0; n < 4; n++) await Job.dispatch({})
    })
    const result = await new Worker(h.manager, options).run()
    expect(result.reason).toBe(reason)
    expect(result.processed).toBe(processed)
    expect(result.code).toBe(reason === 'memory' ? WORKER_EXIT.memory : WORKER_EXIT.ok)
  })

  test('stops for max-time', async () => {
    const h = harness()
    const Job = defineJob({
      name: 'ticks',
      async handle(_data: unknown) {
        h.clock.advance(1000)
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      for (let n = 0; n < 5; n++) await Job.dispatch({})
    })
    const result = await new Worker(h.manager, { maxTime: 2, clock: h.clock }).run()
    expect(result).toMatchObject({ reason: 'max-time', processed: 2 })
  })

  test('queue:restart newer than the worker’s start stops it gracefully', async () => {
    const h = harness()
    let restartAt: number | undefined
    const Job = defineJob({
      name: 'then-restart',
      async handle(_data: unknown) {
        restartAt = h.clock.now()
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, async () => {
      await Job.dispatch({})
      await Job.dispatch({})
    })
    const result = await new Worker(h.manager, {
      clock: h.clock,
      restartSignal: async () => restartAt,
    }).run()
    expect(result).toMatchObject({ reason: 'restart', processed: 1 })
  })

  test('an old restart signal (before the worker started) is ignored', async () => {
    const h = harness()
    h.clock.advance(10_000)
    const result = await new Worker(h.manager, {
      clock: h.clock,
      stopWhenEmpty: true,
      restartSignal: async () => h.clock.now() - 5000,
    }).run()
    expect(result.reason).toBe('empty')
  })

  test('a handler that never stops after its timeout makes the worker exit with code 2', async () => {
    const h = harness()
    const Stuck = defineJob({
      name: 'stuck',
      timeout: 1,
      async handle(_data: unknown) {
        await new Promise<void>(() => {})
      },
    })
    h.jobs.register(Stuck)
    await runWithDispatcher(h.manager, () => Stuck.dispatch({}))
    const result = await new Worker(h.manager, { graceMs: 50 }).run()
    expect(result).toEqual({ code: WORKER_EXIT.timedOut, reason: 'timed-out', processed: 1 })
    expect((await h.failed.all())[0]?.error.code).toBe('queue_job_timed_out')
  })

  test('the worker timeout overrides the job timeout', async () => {
    const h = harness()
    const Job = defineJob({
      name: 'overridden',
      timeout: 30,
      async handle(_data: unknown, ctx) {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
      },
    })
    h.jobs.register(Job)
    await runWithDispatcher(h.manager, () => Job.dispatch({}))
    const result = await new Worker(h.manager, { timeout: 1, stopWhenEmpty: true }).run()
    expect(result.reason).toBe('empty')
    expect((await h.failed.all())[0]?.error.code).toBe('queue_job_timed_out')
  })

  test('refuses to work the sync connection, and checks queue names', () => {
    const h = harness()
    expect(() => new Worker(h.manager, { queues: ['bad name'] })).toThrow(/not a valid queue name/)
    expect(new Worker(h.manager, { queues: ['high', 'default'] }).queues).toEqual([
      'high',
      'default',
    ])
    return expect(new Worker(h.manager, { connection: 'sync' }).run()).rejects.toMatchObject({
      code: 'queue_invalid_option',
    })
  })
})
