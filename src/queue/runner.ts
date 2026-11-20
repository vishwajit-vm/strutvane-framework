/**
 * One attempt of one job (RFC-0006 §4): the part the worker and the `sync` driver share. It
 * restores the tenant, runs the handler in the app scope with a timeout, and reports what
 * happened; it never touches a driver (the caller acknowledges, releases or fails).
 *
 * **Timeouts in JavaScript.** A promise can't be killed. On timeout the attempt is reported as
 * failed (`queue_job_timed_out`) and `ctx.signal` is aborted; `settled` tells the caller when the
 * handler finally stops, so a worker can exit (and be restarted clean) if it never does.
 *
 * @module
 */
import type { Logger } from '../contracts/logger.ts'
import { runWithTenant } from '../database/orm/tenancy.ts'
import type { BatchStatus } from './batches.ts'
import { QueueError } from './errors.ts'
import { checkSeconds, type JobContext, type RegisteredJob } from './job.ts'
import type { Envelope } from './payload.ts'

/**
 * What one attempt ended with.
 *
 * @example
 * if (outcome.kind === 'failed' && outcome.final) await failed.log(…)
 */
export type AttemptOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'released'; readonly delaySeconds: number }
  | {
      readonly kind: 'failed'
      readonly error: Error
      /** No attempt follows: `ctx.fail()`, the last try, or past `retryUntil`. */
      readonly final: boolean
      readonly timedOut: boolean
      /** Resolves when the handler has really stopped (immediately unless it timed out). */
      readonly settled: Promise<void>
    }

/**
 * The inputs of {@link runAttempt}.
 *
 * @example
 * await runAttempt({ job, data, envelope, attempt: 1, connection: 'database', logger, now })
 */
export interface AttemptInput {
  readonly job: RegisteredJob
  /** The data after the job's schema validated it. */
  readonly data: unknown
  readonly envelope: Envelope
  readonly attempt: number
  readonly connection: string
  readonly logger: Logger
  readonly now: () => number
  /** Runs the handler inside the app (container, config, DB connection). Default: as is. */
  readonly scope?: <TResult>(work: () => Promise<TResult>) => Promise<TResult>
  /** Looks up a batch's progress (for `ctx.batch()`). */
  readonly findBatch?: (id: string) => Promise<BatchStatus | undefined>
  /** Overrides the job's timeout (the worker's `--timeout`). */
  readonly timeoutSeconds?: number
}

/**
 * Is this attempt the last one (by count or by `retryUntil`)?
 *
 * @example
 * isLastAttempt(envelope, 3, Date.now())
 */
export function isLastAttempt(envelope: Envelope, attempt: number, now: number): boolean {
  return (
    attempt >= envelope.tries || (envelope.retryUntil !== undefined && now >= envelope.retryUntil)
  )
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Run one attempt.
 *
 * @example
 * const outcome = await runAttempt(input)
 */
export async function runAttempt(input: AttemptInput): Promise<AttemptOutcome> {
  const { envelope, attempt, job } = input
  const controller = new AbortController()
  let released: number | undefined
  let failReason: string | undefined
  const ctx: JobContext = {
    jobId: envelope.id,
    attempt,
    queue: envelope.queue,
    connection: input.connection,
    tenantId: envelope.tenantId,
    signal: controller.signal,
    log: input.logger.child({ jobId: envelope.id, job: envelope.job, attempt }),
    batchId: envelope.batch?.id,
    batch: () => {
      const id = envelope.batch?.id
      return id === undefined || input.findBatch === undefined
        ? Promise.resolve(undefined)
        : input.findBatch(id)
    },
    release(delaySeconds = 0) {
      released = checkSeconds(delaySeconds, 'release delay', job.name)
    },
    fail(reason) {
      failReason = reason ?? 'The job called ctx.fail().'
    },
  }
  const scope = input.scope ?? (<TResult>(work: () => Promise<TResult>): Promise<TResult> => work())
  const handle = (): Promise<void> => scope(() => job.perform(input.data, ctx))
  const running: Promise<void> = Promise.resolve().then(() =>
    envelope.tenantId === undefined ? handle() : runWithTenant(envelope.tenantId, handle),
  )
  const timeoutSeconds = input.timeoutSeconds ?? envelope.timeout
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutSeconds * 1000)
    timer.unref()
  })
  let result: 'ok' | 'timeout' | { readonly error: Error }
  try {
    result = await Promise.race([running.then(() => 'ok' as const), timedOut])
  } catch (error) {
    result = { error: asError(error) }
  } finally {
    clearTimeout(timer)
  }
  const last = isLastAttempt(envelope, attempt, input.now())
  if (result === 'timeout') {
    const error = new QueueError(
      'queue_job_timed_out',
      `The "${job.name}" job ran longer than its ${timeoutSeconds}s timeout.`,
      'Raise the job timeout (below the connection retryAfter), split the work, or pass ctx.signal to slow calls so they stop on timeout.',
    )
    controller.abort(error)
    return {
      kind: 'failed',
      error,
      final: last,
      timedOut: true,
      settled: running.then(
        () => undefined,
        () => undefined,
      ),
    }
  }
  if (result !== 'ok') {
    return {
      kind: 'failed',
      error: result.error,
      final: last || failReason !== undefined,
      timedOut: false,
      settled: Promise.resolve(),
    }
  }
  if (failReason !== undefined) {
    return {
      kind: 'failed',
      error: new QueueError(
        'queue_job_failed',
        failReason,
        'The job failed itself with ctx.fail().',
      ),
      final: true,
      timedOut: false,
      settled: Promise.resolve(),
    }
  }
  if (released !== undefined) return { kind: 'released', delaySeconds: released }
  return { kind: 'done' }
}
