/**
 * Job batches (RFC-0006 §7.1): many jobs dispatched together, with `then` / `catch` / `finally`
 * jobs and progress.
 *
 * **Exactly-once bookkeeping on at-least-once delivery.** Each batch member has a row
 * (`job_batch_jobs`) whose state moves `pending → done | failed` with a compare-and-set; the
 * batch counters change only when that CAS succeeds, so a job delivered twice never counts twice.
 * The `then`, `catch` and `finally` jobs are claimed once with a CAS on `finished_at` /
 * `caught_at`, and pushed with ids derived from the batch id.
 *
 * **Callbacks are jobs, not closures**, and they travel signed inside every member's envelope:
 * the batch rows hold only counters and state, so editing them can't make a worker dispatch
 * anything new.
 *
 * @module
 */
import type { Clock } from '../core/clock.ts'
import { systemClock } from '../core/clock.ts'
import type { Connection } from '../database/db/connection.ts'
import { sql } from '../database/sql/fragment.ts'
import { toInt, toIntOrUndefined } from './drivers/shared.ts'

/**
 * A batch's progress.
 *
 * @example
 * const batch = await Bus.findBatch(id) // { total: 10, pending: 3, failed: 1, progress: 70, … }
 */
export interface BatchStatus {
  readonly id: string
  readonly name: string
  readonly total: number
  /** Jobs that haven't finished for good yet. */
  readonly pending: number
  /** Jobs that failed for good. */
  readonly failed: number
  /** Finished jobs (done or failed) as a percentage of the total, rounded down. */
  readonly progress: number
  readonly createdAt: number
  readonly cancelledAt: number | undefined
  readonly finishedAt: number | undefined
  readonly cancelled: boolean
  readonly finished: boolean
}

/**
 * What changed when a member finished.
 *
 * @example
 * const { counted, status } = await batches.recordSuccess(batchId, jobId)
 */
export interface MemberResult {
  /** `false` when this member had already been counted (a repeated delivery). */
  readonly counted: boolean
  readonly status: BatchStatus | undefined
}

/**
 * Where batches live.
 *
 * @example
 * await repository.create({ id, name: 'import', jobIds })
 */
export interface BatchRepository {
  create(batch: {
    readonly id: string
    readonly name: string
    readonly jobIds: readonly string[]
  }): Promise<void>
  find(id: string): Promise<BatchStatus | undefined>
  recordSuccess(batchId: string, jobId: string): Promise<MemberResult>
  recordFailure(batchId: string, jobId: string): Promise<MemberResult>
  /** Claim the batch's finish (once, when nothing is pending); `true` for the one caller that wins. */
  claimFinished(batchId: string): Promise<boolean>
  /** Claim the batch's first failure (once); `true` for the one caller that wins. */
  claimCaught(batchId: string): Promise<boolean>
  /** Cancel the batch; `true` when this call cancelled it. */
  cancel(batchId: string): Promise<boolean>
  /** Remove finished (or cancelled) batches older than `beforeMs`; returns how many. */
  prune(beforeMs: number): Promise<number>
}

function status(row: {
  readonly id: string
  readonly name: string
  readonly total: number
  readonly pending: number
  readonly failed: number
  readonly createdAt: number
  readonly cancelledAt: number | undefined
  readonly finishedAt: number | undefined
}): BatchStatus {
  const finishedJobs = row.total - row.pending
  return {
    ...row,
    progress: row.total === 0 ? 100 : Math.floor((finishedJobs / row.total) * 100),
    cancelled: row.cancelledAt !== undefined,
    finished: row.finishedAt !== undefined,
  }
}

interface MemoryBatch {
  readonly id: string
  readonly name: string
  readonly total: number
  pending: number
  failed: number
  readonly createdAt: number
  cancelledAt: number | undefined
  finishedAt: number | undefined
  caughtAt: number | undefined
  readonly members: Map<string, 'pending' | 'done' | 'failed'>
}

/**
 * Batches in memory (tests, `sync`).
 *
 * @example
 * const batches = new MemoryBatchRepository({ clock })
 */
export class MemoryBatchRepository implements BatchRepository {
  readonly #batches = new Map<string, MemoryBatch>()
  readonly #clock: Clock

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock
  }

  async create(batch: {
    readonly id: string
    readonly name: string
    readonly jobIds: readonly string[]
  }): Promise<void> {
    this.#batches.set(batch.id, {
      id: batch.id,
      name: batch.name,
      total: batch.jobIds.length,
      pending: batch.jobIds.length,
      failed: 0,
      createdAt: this.#clock.now(),
      cancelledAt: undefined,
      finishedAt: undefined,
      caughtAt: undefined,
      members: new Map(batch.jobIds.map((id) => [id, 'pending'] as const)),
    })
  }

  async find(id: string): Promise<BatchStatus | undefined> {
    const batch = this.#batches.get(id)
    return batch === undefined ? undefined : status(batch)
  }

  #record(batchId: string, jobId: string, to: 'done' | 'failed'): MemberResult {
    const batch = this.#batches.get(batchId)
    if (batch === undefined || batch.members.get(jobId) !== 'pending')
      return { counted: false, status: batch === undefined ? undefined : status(batch) }
    batch.members.set(jobId, to)
    batch.pending -= 1
    if (to === 'failed') batch.failed += 1
    return { counted: true, status: status(batch) }
  }

  async recordSuccess(batchId: string, jobId: string): Promise<MemberResult> {
    return this.#record(batchId, jobId, 'done')
  }

  async recordFailure(batchId: string, jobId: string): Promise<MemberResult> {
    return this.#record(batchId, jobId, 'failed')
  }

  async claimFinished(batchId: string): Promise<boolean> {
    const batch = this.#batches.get(batchId)
    if (batch === undefined || batch.finishedAt !== undefined || batch.pending > 0) return false
    batch.finishedAt = this.#clock.now()
    return true
  }

  async claimCaught(batchId: string): Promise<boolean> {
    const batch = this.#batches.get(batchId)
    if (batch === undefined || batch.caughtAt !== undefined) return false
    batch.caughtAt = this.#clock.now()
    return true
  }

  async cancel(batchId: string): Promise<boolean> {
    const batch = this.#batches.get(batchId)
    if (batch === undefined || batch.cancelledAt !== undefined) return false
    batch.cancelledAt = this.#clock.now()
    return true
  }

  async prune(beforeMs: number): Promise<number> {
    let count = 0
    for (const [id, batch] of this.#batches) {
      const ended = batch.finishedAt ?? batch.cancelledAt
      if (ended !== undefined && ended < beforeMs) {
        this.#batches.delete(id)
        count++
      }
    }
    return count
  }
}

/** The batch tables (`config/queue.ts` `batching`). */
export interface BatchTables {
  readonly batches: string
  readonly members: string
}

/** The default batch table names (Laravel's `job_batches`, plus the member table). */
export const DEFAULT_BATCH_TABLES: BatchTables = Object.freeze({
  batches: 'job_batches',
  members: 'job_batch_jobs',
})

/**
 * Batches in the `job_batches` and `job_batch_jobs` tables.
 *
 * @example
 * const batches = new DatabaseBatchRepository({ connection })
 */
export class DatabaseBatchRepository implements BatchRepository {
  readonly #db: Connection
  readonly #tables: BatchTables
  readonly #clock: Clock

  constructor(options: {
    readonly connection: Connection
    readonly tables?: BatchTables
    readonly clock?: Clock
  }) {
    this.#db = options.connection
    this.#tables = options.tables ?? DEFAULT_BATCH_TABLES
    this.#clock = options.clock ?? systemClock
  }

  async create(batch: {
    readonly id: string
    readonly name: string
    readonly jobIds: readonly string[]
  }): Promise<void> {
    const batches = sql.id(this.#tables.batches)
    const members = sql.id(this.#tables.members)
    const total = batch.jobIds.length
    await this.#db.transaction(async () => {
      await this.#db.run(
        sql`INSERT INTO ${batches} (id, name, total_jobs, pending_jobs, failed_jobs, created_at) VALUES (${batch.id}, ${batch.name.slice(0, 255)}, ${total}, ${total}, ${0}, ${this.#clock.now()})`,
      )
      // In chunks: one statement per member would be slow for large batches, one statement for
      // all of them could exceed the engine's bound-parameter limit (SQLite: 32766).
      for (let start = 0; start < total; start += 200) {
        const rows = batch.jobIds
          .slice(start, start + 200)
          .map((jobId) => sql`(${batch.id}, ${jobId}, ${'pending'})`)
        await this.#db.run(
          sql`INSERT INTO ${members} (batch_id, job_id, state) VALUES ${sql.join(rows, ', ')}`,
        )
      }
    })
  }

  async find(id: string): Promise<BatchStatus | undefined> {
    const result = await this.#db.run(
      sql`SELECT id, name, total_jobs, pending_jobs, failed_jobs, created_at, cancelled_at, finished_at FROM ${sql.id(this.#tables.batches)} WHERE id = ${id}`,
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return status({
      id: String(row['id']),
      name: String(row['name']),
      total: toInt(row['total_jobs']),
      pending: toInt(row['pending_jobs']),
      failed: toInt(row['failed_jobs']),
      createdAt: toInt(row['created_at']),
      cancelledAt: toIntOrUndefined(row['cancelled_at']),
      finishedAt: toIntOrUndefined(row['finished_at']),
    })
  }

  async #record(batchId: string, jobId: string, to: 'done' | 'failed'): Promise<MemberResult> {
    const members = sql.id(this.#tables.members)
    const batches = sql.id(this.#tables.batches)
    const counted = await this.#db.transaction(async () => {
      const moved = await this.#db.run(
        sql`UPDATE ${members} SET state = ${to} WHERE batch_id = ${batchId} AND job_id = ${jobId} AND state = ${'pending'}`,
      )
      if (moved.rowsAffected !== 1) return false
      await this.#db.run(
        to === 'failed'
          ? sql`UPDATE ${batches} SET pending_jobs = pending_jobs - 1, failed_jobs = failed_jobs + 1 WHERE id = ${batchId}`
          : sql`UPDATE ${batches} SET pending_jobs = pending_jobs - 1 WHERE id = ${batchId}`,
      )
      return true
    })
    return { counted, status: await this.find(batchId) }
  }

  recordSuccess(batchId: string, jobId: string): Promise<MemberResult> {
    return this.#record(batchId, jobId, 'done')
  }

  recordFailure(batchId: string, jobId: string): Promise<MemberResult> {
    return this.#record(batchId, jobId, 'failed')
  }

  async claimFinished(batchId: string): Promise<boolean> {
    const result = await this.#db.run(
      sql`UPDATE ${sql.id(this.#tables.batches)} SET finished_at = ${this.#clock.now()} WHERE id = ${batchId} AND finished_at IS NULL AND pending_jobs = ${0}`,
    )
    return result.rowsAffected === 1
  }

  async claimCaught(batchId: string): Promise<boolean> {
    const result = await this.#db.run(
      sql`UPDATE ${sql.id(this.#tables.batches)} SET caught_at = ${this.#clock.now()} WHERE id = ${batchId} AND caught_at IS NULL`,
    )
    return result.rowsAffected === 1
  }

  async cancel(batchId: string): Promise<boolean> {
    const result = await this.#db.run(
      sql`UPDATE ${sql.id(this.#tables.batches)} SET cancelled_at = ${this.#clock.now()} WHERE id = ${batchId} AND cancelled_at IS NULL`,
    )
    return result.rowsAffected === 1
  }

  async prune(beforeMs: number): Promise<number> {
    const batches = sql.id(this.#tables.batches)
    const members = sql.id(this.#tables.members)
    return this.#db.transaction(async () => {
      await this.#db.run(
        sql`DELETE FROM ${members} WHERE batch_id IN (SELECT id FROM ${batches} WHERE (finished_at IS NOT NULL AND finished_at < ${beforeMs}) OR (cancelled_at IS NOT NULL AND cancelled_at < ${beforeMs}))`,
      )
      const removed = await this.#db.run(
        sql`DELETE FROM ${batches} WHERE (finished_at IS NOT NULL AND finished_at < ${beforeMs}) OR (cancelled_at IS NOT NULL AND cancelled_at < ${beforeMs})`,
      )
      return removed.rowsAffected
    })
  }
}
