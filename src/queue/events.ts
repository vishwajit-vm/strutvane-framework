/**
 * The queue's observability hooks (RFC-0006 §12): in-process events a dashboard, metrics or
 * tests subscribe to with `manager.listen(listener)`. They carry ids, names, timings and error
 * codes, **never the job data**.
 *
 * @module
 */

/**
 * The event names.
 *
 * @example
 * const type: QueueEventType = 'queue.job.failed'
 */
export type QueueEventType =
  | 'queue.job.queued'
  | 'queue.job.skipped'
  | 'queue.job.processing'
  | 'queue.job.processed'
  | 'queue.job.released'
  | 'queue.job.failed'
  | 'queue.worker.started'
  | 'queue.worker.stopping'

/**
 * One queue event.
 *
 * @example
 * manager.listen((event) => { if (event.type === 'queue.job.failed') metrics.inc(event.job) })
 */
export interface QueueEvent {
  readonly type: QueueEventType
  /** Epoch milliseconds. */
  readonly at: number
  readonly connection: string
  readonly queue?: string
  readonly jobId?: string
  readonly job?: string
  readonly attempt?: number
  readonly durationMs?: number
  readonly delaySeconds?: number
  /** The error code (or error name) of a failure or a retried attempt. */
  readonly errorCode?: string
  /** Why a worker stops, or why a job was skipped. */
  readonly reason?: string
}

/**
 * A queue event listener. Errors it throws are swallowed (and logged): observability must never
 * break job processing.
 *
 * @example
 * const listener: QueueListener = (event) => counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
 */
export type QueueListener = (event: QueueEvent) => void
