/**
 * The worker loop behind `node strut queue:work` (RFC-0006 §4).
 *
 * Each turn reserves the next job from the first queue (in priority order) that has one and lets
 * the manager run it. Between jobs the worker checks its stop conditions: a stop request
 * (SIGTERM/SIGINT through {@link Worker.stop}), `queue:restart`, the memory limit, `--max-jobs`,
 * `--max-time` and `--stop-when-empty`.
 *
 * **Graceful shutdown.** `stop()` never interrupts the running job: the worker stops reserving,
 * lets the current job finish, and returns. A job that is still running when the process is
 * killed is simply not acknowledged; its reservation runs out and another worker retries it.
 *
 * **A handler that outlives its timeout** can't be killed in JavaScript. The attempt is already
 * recorded as failed; the worker waits a short grace for the handler to stop and, if it doesn't,
 * stops with {@link WORKER_EXIT.timedOut} so the supervisor starts a clean process.
 *
 * @module
 */
import type { Clock } from '../core/clock.ts'
import { systemClock } from '../core/clock.ts'
import { checkQueueName } from './job.ts'
import type { QueueManager } from './manager.ts'

/**
 * Exit codes, Laravel's where it has one.
 *
 * @example
 * process.exitCode = (await worker.run()).code
 */
export const WORKER_EXIT: Readonly<{
  readonly ok: 0
  readonly timedOut: 2
  readonly memory: 12
}> = Object.freeze({ ok: 0, timedOut: 2, memory: 12 })

/**
 * Why a worker stopped.
 *
 * @example
 * const reason: WorkerStopReason = 'empty'
 */
export type WorkerStopReason =
  | 'stopped'
  | 'restart'
  | 'memory'
  | 'max-jobs'
  | 'max-time'
  | 'empty'
  | 'timed-out'

/**
 * Worker options (the `queue:work` flags).
 *
 * @example
 * new Worker(manager, { connection: 'database', queues: ['high', 'default'], sleep: 3 })
 */
export interface WorkerOptions {
  readonly connection?: string
  /** Queues in priority order. Default: the connection's default queue. */
  readonly queues?: readonly string[]
  /** Seconds to sleep when every queue is empty. Default 3. */
  readonly sleep?: number
  /** Override every job's timeout, in seconds. */
  readonly timeout?: number
  /** Stop between jobs once the resident set exceeds this many megabytes. Default 128. */
  readonly memory?: number
  /** Stop after this many jobs (0: no limit). */
  readonly maxJobs?: number
  /** Stop after this many seconds (0: no limit). */
  readonly maxTime?: number
  /** Stop when every queue is empty instead of sleeping. */
  readonly stopWhenEmpty?: boolean
  /** Seconds to rest between jobs. Default 0. */
  readonly rest?: number
  /** Milliseconds to wait for a timed-out handler to stop before exiting. Default 5000. */
  readonly graceMs?: number
  readonly clock?: Clock
  /** When `queue:restart` last ran (ms), or `undefined`. Checked between jobs. */
  readonly restartSignal?: () => Promise<number | undefined>
  /** Resident set size in bytes (tests replace it). */
  readonly memoryUsage?: () => number
}

/**
 * What a finished run reports.
 *
 * @example
 * const { code, reason, processed } = await worker.run()
 */
export interface WorkerResult {
  readonly code: number
  readonly reason: WorkerStopReason
  /** Jobs taken from the queue (processed, released, failed or poisoned). */
  readonly processed: number
}

/**
 * The queue worker.
 *
 * @example
 * const worker = new Worker(manager, { queues: ['default'] })
 * process.once('SIGTERM', () => worker.stop())
 * process.exitCode = (await worker.run()).code
 */
export class Worker {
  readonly #manager: QueueManager
  readonly #options: WorkerOptions
  readonly #clock: Clock
  readonly #connection: string
  readonly #queues: readonly string[]
  #stopRequested = false
  #wake: (() => void) | undefined

  constructor(manager: QueueManager, options: WorkerOptions = {}) {
    this.#manager = manager
    this.#options = options
    this.#clock = options.clock ?? systemClock
    const connection = manager.connection(options.connection)
    this.#connection = connection.name
    const queues = options.queues?.length ? options.queues : [connection.defaultQueue]
    this.#queues = Object.freeze(queues.map(checkQueueName))
  }

  /** The queues this worker reads, in priority order. */
  get queues(): readonly string[] {
    return this.#queues
  }

  /**
   * Ask the worker to stop after the current job (SIGTERM/SIGINT). Idempotent.
   *
   * @example
   * process.once('SIGTERM', () => worker.stop())
   */
  stop(): void {
    this.#stopRequested = true
    this.#wake?.()
  }

  /** Whether {@link Worker.stop} was called. */
  get stopping(): boolean {
    return this.#stopRequested
  }

  /**
   * Run until a stop condition holds.
   */
  async run(): Promise<WorkerResult> {
    const started = this.#clock.now()
    const memoryLimit = (this.#options.memory ?? 128) * 1024 * 1024
    const readMemory = this.#options.memoryUsage ?? ((): number => process.memoryUsage().rss)
    const maxJobs = this.#options.maxJobs ?? 0
    const maxTime = (this.#options.maxTime ?? 0) * 1000
    const sleepMs = (this.#options.sleep ?? 3) * 1000
    const restMs = (this.#options.rest ?? 0) * 1000
    const graceMs = this.#options.graceMs ?? 5000
    let processed = 0
    this.#manager.emit({
      type: 'queue.worker.started',
      connection: this.#connection,
      reason: this.#queues.join(','),
    })
    const finish = (reason: WorkerStopReason, code: number): WorkerResult => {
      this.#manager.emit({ type: 'queue.worker.stopping', connection: this.#connection, reason })
      return { code, reason, processed }
    }
    for (;;) {
      if (this.#stopRequested) return finish('stopped', WORKER_EXIT.ok)
      const restartAt = await this.#options.restartSignal?.()
      if (restartAt !== undefined && restartAt >= started) return finish('restart', WORKER_EXIT.ok)
      const result = await this.#manager.processNext(this.#connection, this.#queues, {
        ...(this.#options.timeout === undefined ? {} : { timeoutSeconds: this.#options.timeout }),
      })
      if (result === undefined) {
        if (this.#options.stopWhenEmpty === true) return finish('empty', WORKER_EXIT.ok)
        await this.#sleep(sleepMs)
        continue
      }
      processed++
      if (result.stillRunning !== undefined) {
        const settled = await Promise.race([
          result.stillRunning.then(() => true),
          delay(graceMs).then(() => false),
        ])
        if (!settled) return finish('timed-out', WORKER_EXIT.timedOut)
      }
      if (readMemory() > memoryLimit) return finish('memory', WORKER_EXIT.memory)
      if (maxJobs > 0 && processed >= maxJobs) return finish('max-jobs', WORKER_EXIT.ok)
      if (maxTime > 0 && this.#clock.now() - started >= maxTime)
        return finish('max-time', WORKER_EXIT.ok)
      if (restMs > 0) await this.#sleep(restMs)
    }
  }

  /** Sleep, but wake up at once when {@link Worker.stop} is called. */
  async #sleep(ms: number): Promise<void> {
    if (this.#stopRequested || ms <= 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.#wake = done
    })
    this.#wake = undefined
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}
