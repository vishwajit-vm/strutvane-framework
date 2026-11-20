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
 * **A handler that outlives its timeout** can't be killed in JavaScript. The manager keeps the
 * job reserved while it waits a short grace for the handler to stop; if it doesn't, the job is
 * abandoned (still reserved, back after `retryAfter`) and the worker stops with
 * {@link WORKER_EXIT.timedOut}, so the command can end the process and the supervisor starts a
 * clean one.
 *
 * **A worker never dies of one bad turn.** An error while reserving or processing (a database
 * failover, a failed-store write) is reported and the worker backs off and carries on.
 *
 * @module
 */
import type { Clock } from '../core/clock.ts'
import { systemClock } from '../core/clock.ts'
import { QueueError } from './errors.ts'
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
  /** Seconds to sleep when every queue is empty (at least 1). Default 3. */
  readonly sleep?: number
  /** Override every job's timeout, in seconds: at least 1 and below the connection's retryAfter. */
  readonly timeout?: number
  /**
   * Stop between jobs once the resident set exceeds this many megabytes. Default 512: Laravel's
   * 128 is below what a booted Node app with its database driver already uses.
   */
  readonly memory?: number
  /** Stop after this many jobs (0: no limit). */
  readonly maxJobs?: number
  /** Stop after this many seconds (0: no limit). */
  readonly maxTime?: number
  /** Stop when every queue is empty instead of sleeping. */
  readonly stopWhenEmpty?: boolean
  /** Seconds to rest between jobs. Default 0. */
  readonly rest?: number
  /** Milliseconds a timed-out handler gets to stop before its job is abandoned. Default 5000. */
  readonly graceMs?: number
  /** Relay the outbox at least this often while busy, in milliseconds. Default 5000. */
  readonly relayEveryMs?: number
  readonly clock?: Clock
  /**
   * The `queue:restart` marker (whatever value it last wrote), or `undefined`. The worker reads it
   * when it starts and stops once it *changes*: comparing values, not clocks, works across
   * machines whose clocks disagree.
   */
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
  /** Jobs taken from the queue (processed, released, failed, poisoned or abandoned). */
  readonly processed: number
}

function invalid(option: string, value: unknown, hint: string): QueueError {
  return new QueueError(
    'queue_invalid_option',
    `The worker's ${option} is invalid: ${String(value)}.`,
    hint,
  )
}

function wholeAtLeast(value: number | undefined, min: number, option: string): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < min)
    throw invalid(option, value, `Use a whole number of at least ${min}.`)
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
    wholeAtLeast(options.sleep, 1, 'sleep')
    wholeAtLeast(options.memory, 1, 'memory')
    wholeAtLeast(options.maxJobs, 0, 'max-jobs')
    wholeAtLeast(options.maxTime, 0, 'max-time')
    wholeAtLeast(options.rest, 0, 'rest')
    wholeAtLeast(options.graceMs, 0, 'graceMs')
    wholeAtLeast(options.relayEveryMs, 0, 'relayEveryMs')
    if (options.timeout !== undefined) {
      wholeAtLeast(options.timeout, 1, 'timeout')
      if (options.timeout >= connection.retryAfter)
        throw new QueueError(
          'queue_timeout_not_below_retry_after',
          `--timeout=${options.timeout} is not below the "${connection.name}" connection's retryAfter (${connection.retryAfter}s).`,
          'Lower --timeout or raise retryAfter in config/queue.ts: otherwise a slow job is handed to a second worker while it still runs.',
        )
    }
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
    const memoryLimit = (this.#options.memory ?? 512) * 1024 * 1024
    const readMemory = this.#options.memoryUsage ?? ((): number => process.memoryUsage().rss)
    const maxJobs = this.#options.maxJobs ?? 0
    const maxTime = (this.#options.maxTime ?? 0) * 1000
    const sleepMs = (this.#options.sleep ?? 3) * 1000
    const restMs = (this.#options.rest ?? 0) * 1000
    const relayEveryMs = this.#options.relayEveryMs ?? 5000
    const processOptions = {
      ...(this.#options.timeout === undefined ? {} : { timeoutSeconds: this.#options.timeout }),
      ...(this.#options.graceMs === undefined ? {} : { graceMs: this.#options.graceMs }),
    }
    let processed = 0
    let lastRelay = started
    let failures = 0
    const restartBaseline = await this.#readRestart()
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
      const restartAt = await this.#readRestart()
      if (restartAt !== undefined && restartAt !== restartBaseline)
        return finish('restart', WORKER_EXIT.ok)
      let result: Awaited<ReturnType<QueueManager['processNext']>>
      try {
        result = await this.#manager.processNext(this.#connection, this.#queues, processOptions)
        failures = 0
      } catch (error) {
        // A bad turn (database failover, a failed-store write that failed) never kills the
        // worker: report it, back off (longer each time, up to a minute) and carry on.
        failures++
        this.#manager.reportWorkerError(this.#connection, error)
        await this.#sleep(Math.min(60_000, Math.max(1000, sleepMs) * 2 ** Math.min(failures - 1, 6)))
        continue
      }
      if (result === undefined) {
        // Idle: move due outbox rows to their queues first (RFC-0006 §8).
        lastRelay = this.#clock.now()
        if ((await this.#manager.relayOutbox()) > 0) continue
        if (this.#options.stopWhenEmpty === true) return finish('empty', WORKER_EXIT.ok)
        await this.#sleep(sleepMs)
        continue
      }
      processed++
      if (result.outcome === 'abandoned') return finish('timed-out', WORKER_EXIT.timedOut)
      if (readMemory() > memoryLimit) return finish('memory', WORKER_EXIT.memory)
      if (maxJobs > 0 && processed >= maxJobs) return finish('max-jobs', WORKER_EXIT.ok)
      if (maxTime > 0 && this.#clock.now() - started >= maxTime)
        return finish('max-time', WORKER_EXIT.ok)
      // Busy queues are never empty: relay the outbox on a timer too, so its rows don't starve.
      if (this.#clock.now() - lastRelay >= relayEveryMs) {
        lastRelay = this.#clock.now()
        await this.#manager.relayOutbox()
      }
      if (restMs > 0) await this.#sleep(restMs)
    }
  }

  async #readRestart(): Promise<number | undefined> {
    try {
      return await this.#options.restartSignal?.()
    } catch (error) {
      // The cache being down must not stop the work; the next turn reads it again.
      this.#manager.reportWorkerError(this.#connection, error)
      return undefined
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
