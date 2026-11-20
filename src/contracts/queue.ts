/**
 * The queue-driver contract (RFC-0006 §10): what a queue backend must do so the framework's
 * worker, dispatcher and commands can use it. The framework ships the `database`, `memory` and
 * `sync` drivers; add-ons such as `@strutvane/redis` implement the same interface and register it
 * with the queue manager.
 *
 * The semantics are Laravel's: **at-least-once delivery**. A popped job is *reserved* for a
 * visibility window; the worker acknowledges it when done or releases it for another attempt. A
 * worker that crashes never acknowledges, so the job becomes available again when its reservation
 * runs out. Handlers must therefore be idempotent (the job id is the idempotency key).
 *
 * Types only: this file imports nothing.
 *
 * @module
 */

/**
 * A job handed to a worker by {@link QueueDriver.pop}.
 *
 * @example
 * const job = await driver.pop('emails')
 * if (job) { await run(job.payload); await driver.ack(job) }
 */
export interface ReservedJob {
  /** The job id (stable across attempts). */
  readonly id: string
  /** The queue it was popped from. */
  readonly queue: string
  /** The serialised envelope. Drivers never parse it. */
  readonly payload: string
  /** How many times the job has been reserved, including this one (1 on the first attempt). */
  readonly attempts: number
  /** When the reservation runs out, in milliseconds since the epoch. */
  readonly reservedUntil: number
  /** The driver's own handle for ack/release/extend. Opaque to callers. */
  readonly receipt: string
}

/**
 * Options for {@link QueueDriver.push}.
 *
 * @example
 * await driver.push('emails', payload, { delaySeconds: 60, id: jobId })
 */
export interface PushOptions {
  /** Make the job available only after this many seconds. Default 0. */
  readonly delaySeconds?: number
  /**
   * Use this id. A driver that supports it makes the push idempotent: a second push with the
   * same id is ignored (chains and the outbox rely on it to survive a crash between push and
   * acknowledge). A driver that can't honour it may ignore it and generate its own id.
   */
  readonly id?: string
}

/**
 * A queue backend.
 *
 * @example
 * class SqsDriver implements QueueDriver { … }
 */
export interface QueueDriver {
  /**
   * `true` when the driver stores every job under `PushOptions.id`: the worker then refuses a job
   * whose row id differs from its signed id (a copied row). Drivers that make their own ids leave
   * it unset.
   */
  readonly preservesIds?: boolean
  /** Add a job; returns its id. */
  push(queue: string, payload: string, options?: PushOptions): Promise<string>
  /** Reserve the next available job, or `undefined` when the queue has none ready. */
  pop(
    queue: string,
    options?: { readonly visibilitySeconds?: number },
  ): Promise<ReservedJob | undefined>
  /** The job is done: remove it. `false` when the reservation was already lost. */
  ack(job: ReservedJob): Promise<boolean>
  /** Put the job back (available after `delaySeconds`). `false` when no longer reserved. */
  release(job: ReservedJob, delaySeconds?: number): Promise<boolean>
  /** Jobs waiting, delayed and reserved. */
  size(queue: string): Promise<number>
  /** Remove every job of the queue; returns how many were removed. */
  clear(queue: string): Promise<number>
  /** Optional heartbeat: push the reservation out by `visibilitySeconds` from now. */
  extend?(job: ReservedJob, visibilitySeconds: number): Promise<boolean>
  /** Optional: release resources the driver owns (not a shared app connection). */
  close?(): Promise<void>
}

/**
 * A small lock store for unique jobs and, later, the scheduler's `withoutOverlapping` /
 * `onOneServer` (RFC-0006 §5).
 *
 * @example
 * if (await locks.acquire('queue:unique:import:1', owner, 600)) { … }
 */
export interface QueueLockStore {
  /** Take the lock for `ttlSeconds` unless someone else holds a live one; `true` when taken. */
  acquire(key: string, owner: string, ttlSeconds: number): Promise<boolean>
  /** Release the lock, only when `owner` holds it; `true` when released. */
  release(key: string, owner: string): Promise<boolean>
}
