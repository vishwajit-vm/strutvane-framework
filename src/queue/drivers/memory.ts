/**
 * The memory driver: real reservations inside one process (RFC-0006 §10). Tests and the driver
 * contract suite use it; it is the reference for what every driver must do. Nothing survives a
 * restart, so it is never a production default.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import type { PushOptions, QueueDriver, ReservedJob } from '../../contracts/queue.ts'
import { type Clock, systemClock } from '../../core/clock.ts'
import { checkQueueName } from '../job.ts'
import { checkDriverSeconds, DEFAULT_RETRY_AFTER_SECONDS, newJobId } from './shared.ts'

interface Stored {
  readonly id: string
  readonly payload: string
  attempts: number
  availableAt: number
  reservedUntil: number | undefined
  reservation: string | undefined
  readonly seq: number
}

/**
 * The in-process queue driver.
 *
 * @example
 * const driver = new MemoryQueueDriver({ clock })
 * await driver.push('default', payload)
 */
export class MemoryQueueDriver implements QueueDriver {
  readonly preservesIds = true
  readonly #queues = new Map<string, Map<string, Stored>>()
  readonly #clock: Clock
  readonly #retryAfterMs: number
  #seq = 0

  constructor(options: { readonly clock?: Clock; readonly retryAfter?: number } = {}) {
    this.#clock = options.clock ?? systemClock
    this.#retryAfterMs =
      checkDriverSeconds(options.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS, 'retryAfter', 1) * 1000
  }

  #queue(name: string): Map<string, Stored> {
    checkQueueName(name)
    let queue = this.#queues.get(name)
    if (queue === undefined) {
      queue = new Map()
      this.#queues.set(name, queue)
    }
    return queue
  }

  async push(queue: string, payload: string, options: PushOptions = {}): Promise<string> {
    const jobs = this.#queue(queue)
    const id = options.id ?? newJobId()
    if (jobs.has(id)) return id
    const delay = checkDriverSeconds(options.delaySeconds ?? 0, 'delaySeconds')
    jobs.set(id, {
      id,
      payload,
      attempts: 0,
      availableAt: this.#clock.now() + delay * 1000,
      reservedUntil: undefined,
      reservation: undefined,
      seq: this.#seq++,
    })
    return id
  }

  async pop(
    queue: string,
    options: { readonly visibilitySeconds?: number } = {},
  ): Promise<ReservedJob | undefined> {
    const jobs = this.#queue(queue)
    const now = this.#clock.now()
    const visibility =
      options.visibilitySeconds === undefined
        ? this.#retryAfterMs
        : checkDriverSeconds(options.visibilitySeconds, 'visibilitySeconds', 1) * 1000
    let next: Stored | undefined
    for (const job of jobs.values()) {
      const free = job.reservedUntil === undefined || job.reservedUntil <= now
      if (!free || job.availableAt > now) continue
      if (
        next === undefined ||
        job.availableAt < next.availableAt ||
        (job.availableAt === next.availableAt && job.seq < next.seq)
      )
        next = job
    }
    if (next === undefined) return undefined
    next.attempts += 1
    next.reservedUntil = now + visibility
    next.reservation = randomBytes(16).toString('base64url')
    return {
      id: next.id,
      queue,
      payload: next.payload,
      attempts: next.attempts,
      reservedUntil: next.reservedUntil,
      receipt: next.reservation,
    }
  }

  #owned(job: ReservedJob): Stored | undefined {
    const stored = this.#queue(job.queue).get(job.id)
    return stored !== undefined && stored.reservation === job.receipt ? stored : undefined
  }

  async ack(job: ReservedJob): Promise<boolean> {
    if (this.#owned(job) === undefined) return false
    return this.#queue(job.queue).delete(job.id)
  }

  async release(job: ReservedJob, delaySeconds = 0): Promise<boolean> {
    const stored = this.#owned(job)
    if (stored === undefined) return false
    stored.availableAt = this.#clock.now() + checkDriverSeconds(delaySeconds, 'delaySeconds') * 1000
    stored.reservedUntil = undefined
    stored.reservation = undefined
    return true
  }

  async extend(job: ReservedJob, visibilitySeconds: number): Promise<boolean> {
    const stored = this.#owned(job)
    if (stored === undefined) return false
    stored.reservedUntil =
      this.#clock.now() + checkDriverSeconds(visibilitySeconds, 'visibilitySeconds', 1) * 1000
    return true
  }

  async size(queue: string): Promise<number> {
    return this.#queue(queue).size
  }

  async clear(queue: string): Promise<number> {
    const jobs = this.#queue(queue)
    const count = jobs.size
    jobs.clear()
    return count
  }
}
