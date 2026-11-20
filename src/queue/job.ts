/**
 * Jobs (RFC-0006 §1): `defineJob` and what a job's handler receives.
 *
 * A job is found by its registered **name**; only the name and plain data travel through the
 * queue. The definition object is never serialised, and nothing in a payload is ever imported.
 *
 * @module
 */
import type { Logger } from '../contracts/logger.ts'
import type { StandardSchemaV1 } from '../contracts/standard-schema.ts'
import { currentApplication } from '../foundation/current.ts'
import type { BatchStatus } from './batches.ts'
import { QueueError } from './errors.ts'
import { QueueDispatcherToken } from './tokens.ts'

/** A valid job name: stable, lowercase, never derived from a file path. */
const JOB_NAME = /^[a-z0-9][a-z0-9._:-]{0,127}$/
/** A valid queue name (the database and Redis drivers share it). */
export const QUEUE_NAME: RegExp = /^[A-Za-z0-9_.-]{1,64}$/

/** The longest delay or backoff the queue accepts: 30 days. */
export const MAX_DELAY_SECONDS: number = 30 * 24 * 3600

const BRAND: unique symbol = Symbol.for('strutvane.job')

/**
 * Retry delays in seconds per failed attempt (the last value repeats), or `'exponential'`
 * (`min(1 h, 2^(n-1) s)` with full jitter).
 *
 * @example
 * const backoff: Backoff = [10, 60, 300]
 */
export type Backoff = number | readonly number[] | 'exponential'

/**
 * A job's unique lock (Laravel's `ShouldBeUnique`): a second dispatch with the same key is
 * skipped while the lock is held.
 *
 * @example
 * unique: { key: (data) => data.importId, for: 600 }
 */
export interface UniqueOptions<TData> {
  /** The lock key within this job's name. */
  readonly key: (data: TData) => string
  /** Seconds the lock may live at most (bounds a lock whose job vanished). */
  readonly for: number
  /** Release just before handling (default) or after the job finished for good. */
  readonly until?: 'processing' | 'completed'
}

/**
 * What a job handler receives besides its data.
 *
 * @example
 * async handle(data, ctx) { await fetch(url, { signal: ctx.signal }) }
 */
export interface JobContext {
  /** The job id: stable across attempts, so use it as an idempotency key. */
  readonly jobId: string
  /** The 1-based attempt number. */
  readonly attempt: number
  readonly queue: string
  readonly connection: string
  /** The tenant restored for this job, if it was dispatched inside one. */
  readonly tenantId: string | undefined
  /** Aborted on timeout or worker shutdown: pass it to fetch, streams and long loops. */
  readonly signal: AbortSignal
  /** The app logger with the job's context. Data is never logged by the framework. */
  readonly log: Logger
  /** The batch this job belongs to, if any. */
  readonly batchId: string | undefined
  /** The batch's current progress (`cancelled`, `pending`…), or `undefined` outside a batch. */
  batch(): Promise<BatchStatus | undefined>
  /** Put the job back after `delaySeconds` without counting it as a failure. */
  release(delaySeconds?: number): void
  /** Fail the job now: no further attempts. */
  fail(reason?: string): void
}

/**
 * Options shared by a job definition and a single dispatch.
 *
 * @example
 * const options: JobOptions = { queue: 'emails', tries: 3, backoff: [10, 60] }
 */
export interface JobOptions {
  /** The default queue (default `'default'`, or the connection's default queue). */
  readonly queue?: string
  /** The default connection (default: `config/queue.ts` `default`). */
  readonly connection?: string
  /** Attempts in total (default 1). */
  readonly tries?: number
  readonly backoff?: Backoff
  /** Seconds a run may take (default 60). Must stay below the connection's `retryAfter`. */
  readonly timeout?: number
  /** Stop retrying this many seconds after dispatch. */
  readonly retryUntil?: number
}

/**
 * The definition `defineJob` takes.
 *
 * @example
 * defineJob({ name: 'send-welcome-email', async handle(data: { userId: string }) { … } })
 */
export interface JobConfig<TData> extends JobOptions {
  readonly name: string
  /** Validates the data at dispatch and again before handling (an older deploy's shape fails cleanly). */
  readonly schema?: StandardSchemaV1<unknown, TData>
  readonly unique?: UniqueOptions<TData>
  handle(data: TData, ctx: JobContext): Promise<void> | void
  /** Called once after the final attempt failed. */
  failed?(data: TData, error: Error, ctx: JobContext): Promise<void> | void
}

/**
 * The resolved retry settings of a job.
 *
 * @example
 * job.options.tries // 3
 */
export interface ResolvedJobOptions {
  readonly queue: string | undefined
  readonly connection: string | undefined
  readonly tries: number
  readonly backoff: readonly number[] | 'exponential'
  readonly timeout: number
  readonly retryUntil: number | undefined
}

/**
 * A registered job as the worker sees it (data is `unknown` until the job validates it).
 *
 * @example
 * registry.get('send-welcome-email')?.perform(data, ctx)
 */
export interface RegisteredJob {
  readonly [BRAND]: true
  readonly name: string
  readonly options: ResolvedJobOptions
  /** The unique lock settings for this data (the app's key; the manager scopes it per tenant). */
  uniqueLock(
    data: unknown,
  ):
    | { readonly key: string; readonly for: number; readonly until: 'processing' | 'completed' }
    | undefined
  /** Validate data with the job's schema (or pass it through). Throws `queue_payload_invalid`. */
  parse(data: unknown): Promise<unknown>
  perform(data: unknown, ctx: JobContext): Promise<void>
  onFailure(data: unknown, error: Error, ctx: JobContext): Promise<void>
}

/**
 * Per-dispatch overrides.
 *
 * @example
 * await SendMail.dispatch(data, { delay: 60, queue: 'emails' })
 */
export interface DispatchOptions {
  /** Seconds, or a moment in the future. */
  readonly delay?: number | Date
  readonly queue?: string
  readonly connection?: string
  /** Inside a database transaction, push only after it commits. */
  readonly afterCommit?: boolean
  /**
   * Write the job to the transactional outbox, in the caller's transaction: it exists exactly
   * when the data committed (RFC-0006 §8). Database-backed queues only.
   */
  readonly viaOutbox?: boolean
}

/**
 * One job with its data, ready to dispatch, chain or batch.
 *
 * @example
 * await Bus.chain([Resize.with({ id }), Publish.with({ id })]).dispatch()
 */
export class JobCall {
  readonly job: RegisteredJob
  readonly data: unknown
  readonly options: DispatchOptions

  constructor(job: RegisteredJob, data: unknown, options: DispatchOptions = {}) {
    this.job = job
    this.data = data
    this.options = Object.freeze({ ...options })
  }

  /** The same call, delayed. */
  delay(delay: number | Date): JobCall {
    return new JobCall(this.job, this.data, { ...this.options, delay })
  }

  /** The same call, on another queue. */
  onQueue(queue: string): JobCall {
    return new JobCall(this.job, this.data, { ...this.options, queue })
  }

  /** The same call, on another connection. */
  onConnection(connection: string): JobCall {
    return new JobCall(this.job, this.data, { ...this.options, connection })
  }

  /** The same call, written to the transactional outbox in the current transaction. */
  viaOutbox(): JobCall {
    return new JobCall(this.job, this.data, { ...this.options, viaOutbox: true })
  }

  /** The same call, pushed only after the current transaction commits. */
  afterCommit(): JobCall {
    return new JobCall(this.job, this.data, { ...this.options, afterCommit: true })
  }

  /**
   * Push it through the current application's queue. Resolves to the job id, or `undefined`
   * when a unique job's lock is held.
   */
  dispatch(): Promise<string | undefined> {
    return dispatcher('dispatch()').dispatch(this)
  }
}

/**
 * A defined job: register it, dispatch it, chain it.
 *
 * @example
 * await SendWelcomeEmail.dispatch({ userId })
 */
export interface JobDefinition<TData> extends RegisteredJob {
  /** The job with data, for chains, batches and fluent options. */
  with(data: TData): JobCall
  /** Queue it (see {@link DispatchOptions}). */
  dispatch(data: TData, options?: DispatchOptions): Promise<string | undefined>
  /** Run it now in this process, through the full lifecycle (validation, tenant, `failed`). */
  dispatchSync(data: TData): Promise<void>
}

function dispatcher(helper: string): {
  dispatch(call: JobCall): Promise<string | undefined>
  dispatchSync(call: JobCall): Promise<void>
} {
  const container = currentApplication(helper).container
  if (!container.has(QueueDispatcherToken))
    throw new QueueError(
      'queue_no_application',
      `${helper} needs the queue, but the current app has no queue manager bound.`,
      'Boot the app first (await app.boot()); the queue manager is bound from config/queue.ts.',
    )
  return container.make(QueueDispatcherToken)
}

function invalidOption(name: string, option: string, value: unknown, hint: string): QueueError {
  return new QueueError(
    'queue_invalid_option',
    `The "${name}" job's ${option} is invalid: ${String(value)}.`,
    hint,
  )
}

/**
 * Check a seconds value: a non-negative integer up to {@link MAX_DELAY_SECONDS}.
 *
 * @example
 * seconds(60, 'delay', 'job') // 60
 */
export function checkSeconds(value: unknown, option: string, name: string, min = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > MAX_DELAY_SECONDS
  )
    throw invalidOption(
      name,
      option,
      value,
      `Use a whole number of seconds from ${min} to ${MAX_DELAY_SECONDS}.`,
    )
  return value
}

/**
 * Check a queue name.
 *
 * @example
 * checkQueueName('emails') // 'emails'
 */
export function checkQueueName(queue: string): string {
  if (typeof queue !== 'string' || !QUEUE_NAME.test(queue))
    throw new QueueError(
      'queue_invalid_name',
      `"${String(queue)}" is not a valid queue name.`,
      'Use 1–64 letters, digits, "_", "." or "-".',
    )
  return queue
}

function resolveOptions(config: JobOptions & { readonly name: string }): ResolvedJobOptions {
  const { name } = config
  const tries = config.tries ?? 1
  if (!Number.isInteger(tries) || tries < 1 || tries > 1000)
    throw invalidOption(name, 'tries', tries, 'Use a whole number from 1 to 1000.')
  const timeout = checkSeconds(config.timeout ?? 60, 'timeout', name, 1)
  const raw = config.backoff ?? 0
  const backoff: readonly number[] | 'exponential' =
    raw === 'exponential'
      ? 'exponential'
      : Object.freeze(
          (typeof raw === 'number' ? [raw] : [...raw]).map((value) =>
            checkSeconds(value, 'backoff', name),
          ),
        )
  if (backoff !== 'exponential' && backoff.length === 0)
    throw invalidOption(name, 'backoff', '[]', 'Give at least one delay, or leave backoff out.')
  const retryUntil =
    config.retryUntil === undefined
      ? undefined
      : checkSeconds(config.retryUntil, 'retryUntil', name, 1)
  if (config.queue !== undefined) checkQueueName(config.queue)
  return Object.freeze({
    queue: config.queue,
    connection: config.connection,
    tries,
    backoff,
    timeout,
    retryUntil,
  })
}

/**
 * Define a job.
 *
 * @example
 * export const SendWelcomeEmail = defineJob({
 *   name: 'send-welcome-email',
 *   tries: 3,
 *   backoff: [10, 60],
 *   async handle({ userId }: { userId: string }, ctx) { … },
 * })
 */
export function defineJob<TData>(config: JobConfig<TData>): JobDefinition<TData> {
  if (typeof config.name !== 'string' || !JOB_NAME.test(config.name))
    throw new QueueError(
      'queue_job_invalid',
      `"${String(config.name)}" is not a valid job name.`,
      'Use a stable lowercase name such as "send-welcome-email" (letters, digits, ".", "_", ":", "-"; at most 128).',
    )
  if (typeof config.handle !== 'function')
    throw new QueueError(
      'queue_job_invalid',
      `The "${config.name}" job has no handle() function.`,
      'Add async handle(data, ctx) { … } to the definition.',
    )
  const options = resolveOptions(config)
  const { unique, schema, name } = config
  if (unique !== undefined) checkSeconds(unique.for, 'unique.for', name, 1)

  const parse = async (data: unknown): Promise<unknown> => {
    if (schema === undefined) return data
    const result = await schema['~standard'].validate(data)
    if (result.issues !== undefined) {
      const first = result.issues[0]
      const where = first?.path
        ?.map((p) => (typeof p === 'object' ? String(p.key) : String(p)))
        .join('.')
      throw new QueueError(
        'queue_payload_invalid',
        `The "${name}" job's data is invalid${where ? ` at ${where}` : ''}: ${first?.message ?? 'schema validation failed'}.`,
        'Dispatch data that matches the job schema; jobs queued by an older deploy fail here instead of deep in the handler.',
      )
    }
    return result.value
  }

  const definition: JobDefinition<TData> = {
    [BRAND]: true,
    name,
    options,
    uniqueLock(data) {
      if (unique === undefined) return undefined
      const key = unique.key(data as TData)
      if (typeof key !== 'string' || key === '' || key.length > 200)
        throw invalidOption(
          name,
          'unique.key()',
          key,
          'Return a non-empty string of at most 200 characters.',
        )
      return {
        key,
        for: unique.for,
        until: unique.until ?? 'processing',
      }
    },
    parse,
    async perform(data, ctx) {
      await config.handle(data as TData, ctx)
    },
    async onFailure(data, error, ctx) {
      await config.failed?.(data as TData, error, ctx)
    },
    with(data) {
      return new JobCall(definition, data)
    },
    dispatch(data, dispatchOptions = {}) {
      return dispatcher(`${name}.dispatch()`).dispatch(
        new JobCall(definition, data, dispatchOptions),
      )
    },
    dispatchSync(data) {
      return dispatcher(`${name}.dispatchSync()`).dispatchSync(new JobCall(definition, data))
    },
  }
  return Object.freeze(definition)
}

/**
 * Is this value a job definition (also across module copies)?
 *
 * @example
 * Object.values(module).filter(isJob)
 */
export function isJob(value: unknown): value is RegisteredJob {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [BRAND]?: unknown })[BRAND] === true &&
    typeof (value as { name?: unknown }).name === 'string'
  )
}

/**
 * The delay before the next attempt after attempt `attempt` (1-based) failed.
 *
 * @example
 * backoffDelay([10, 60], 3) // 60 (the last value repeats)
 * backoffDelay('exponential', 4, () => 0.5) // 4 (half of 2^3)
 */
export function backoffDelay(
  backoff: readonly number[] | 'exponential',
  attempt: number,
  random: () => number = Math.random,
): number {
  if (backoff === 'exponential') {
    const ceiling = Math.min(3600, 2 ** Math.min(attempt - 1, 12))
    return Math.floor(random() * (ceiling + 1))
  }
  return backoff[Math.min(attempt, backoff.length) - 1] ?? 0
}
