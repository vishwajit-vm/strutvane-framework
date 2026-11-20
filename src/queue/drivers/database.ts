/**
 * The database driver (RFC-0006 §10): the default queue, on the app's own database (SQLite,
 * MySQL, MariaDB, PostgreSQL), so a new app needs no extra service.
 *
 * **How two workers never get the same job.** `pop` reads a few candidate ids, then claims one
 * with a compare-and-set:
 *
 * ```sql
 * UPDATE jobs SET reserved_until = ?, reservation = ?, attempts = attempts + 1
 *  WHERE id = ? AND available_at <= ? AND (reserved_until IS NULL OR reserved_until <= ?)
 * ```
 *
 * Only the update that reports one affected row owns the job; the others move to the next
 * candidate. This needs no `SKIP LOCKED` (SQLite and older MariaDB have none) and is correct on
 * every engine, because a single UPDATE is atomic. `ack` and `release` match on the random
 * `reservation` too, so a worker whose reservation expired can't delete or release a job another
 * worker now owns.
 *
 * Times are epoch milliseconds from the app clock: workers on different machines need clocks that
 * agree to well within `retryAfter`.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import type { PushOptions, QueueDriver, ReservedJob } from '../../contracts/queue.ts'
import { type Clock, systemClock } from '../../core/clock.ts'
import type { Connection } from '../../database/db/connection.ts'
import { sql } from '../../database/sql/fragment.ts'
import { isMysqlFamily } from '../../database/sql/grammar.ts'
import { checkQueueName } from '../job.ts'
import { DEFAULT_QUEUE_TABLES } from '../tables.ts'
import {
  checkDriverSeconds,
  DEFAULT_RETRY_AFTER_SECONDS,
  newJobId,
  toInt,
  toIntOrUndefined,
} from './shared.ts'

/** Claim rounds before `pop` reports "nothing for me" under heavy contention. */
const ROUNDS = 4

/**
 * Options for {@link DatabaseQueueDriver}.
 *
 * @example
 * const options: DatabaseQueueOptions = { connection, table: 'jobs', retryAfter: 90 }
 */
export interface DatabaseQueueOptions {
  /** The connection the jobs table lives on (the app's connection by default). */
  readonly connection: Connection
  /** The jobs table. Default `jobs`. */
  readonly table?: string
  /** Seconds a reservation lasts (Laravel's `retry_after`). Default 90. */
  readonly retryAfter?: number
  readonly clock?: Clock
}

/**
 * The database queue driver.
 *
 * @example
 * const driver = new DatabaseQueueDriver({ connection })
 * await driver.push('default', payload)
 */
export class DatabaseQueueDriver implements QueueDriver {
  readonly #db: Connection
  readonly #table: string
  readonly #retryAfterMs: number
  readonly #clock: Clock

  constructor(options: DatabaseQueueOptions) {
    this.#db = options.connection
    this.#table = options.table ?? DEFAULT_QUEUE_TABLES.jobs
    this.#retryAfterMs =
      checkDriverSeconds(options.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS, 'retryAfter', 1) * 1000
    this.#clock = options.clock ?? systemClock
  }

  /** The reservation length, in seconds. */
  get retryAfter(): number {
    return this.#retryAfterMs / 1000
  }

  async push(queue: string, payload: string, options: PushOptions = {}): Promise<string> {
    checkQueueName(queue)
    const id = options.id ?? newJobId()
    if (typeof id !== 'string' || id === '' || id.length > 64)
      throw new TypeError('A job id must be a non-empty string of at most 64 characters.')
    const delay = checkDriverSeconds(options.delaySeconds ?? 0, 'delaySeconds')
    const now = this.#clock.now()
    const table = sql.id(this.#table)
    const values = sql`(${id}, ${queue}, ${payload}, ${0}, ${now + delay * 1000}, ${now})`
    // A second push with the same id is ignored: chains and the outbox rely on it to survive a
    // crash between "push the next job" and "acknowledge this one".
    await this.#db.run(
      isMysqlFamily(this.#db.grammar.dialect)
        ? sql`INSERT INTO ${table} (id, queue, payload, attempts, available_at, created_at) VALUES ${values} ON DUPLICATE KEY UPDATE id = id`
        : sql`INSERT INTO ${table} (id, queue, payload, attempts, available_at, created_at) VALUES ${values} ON CONFLICT (id) DO NOTHING`,
    )
    return id
  }

  async pop(
    queue: string,
    options: { readonly visibilitySeconds?: number } = {},
  ): Promise<ReservedJob | undefined> {
    checkQueueName(queue)
    const visibilityMs =
      options.visibilitySeconds === undefined
        ? this.#retryAfterMs
        : checkDriverSeconds(options.visibilitySeconds, 'visibilitySeconds', 1) * 1000
    const table = sql.id(this.#table)
    for (let round = 0; round < ROUNDS; round++) {
      const now = this.#clock.now()
      const candidates = await this.#db.run(
        sql`SELECT id FROM ${table} WHERE queue = ${queue} AND available_at <= ${now} AND (reserved_until IS NULL OR reserved_until <= ${now}) ORDER BY available_at, id LIMIT 5`,
      )
      if (candidates.rows.length === 0) return undefined
      for (const row of candidates.rows) {
        const id = String(row['id'])
        const reservation = randomBytes(16).toString('base64url')
        const until = now + visibilityMs
        const claimed = await this.#db.run(
          sql`UPDATE ${table} SET reserved_until = ${until}, reservation = ${reservation}, attempts = attempts + 1 WHERE id = ${id} AND queue = ${queue} AND available_at <= ${now} AND (reserved_until IS NULL OR reserved_until <= ${now})`,
        )
        if (claimed.rowsAffected !== 1) continue
        const fetched = await this.#db.run(
          sql`SELECT payload, attempts FROM ${table} WHERE id = ${id} AND reservation = ${reservation}`,
        )
        const job = fetched.rows[0]
        if (job === undefined) continue
        return {
          id,
          queue,
          payload: String(job['payload']),
          attempts: toInt(job['attempts']),
          reservedUntil: until,
          receipt: reservation,
        }
      }
    }
    return undefined
  }

  async ack(job: ReservedJob): Promise<boolean> {
    const result = await this.#db.run(
      sql`DELETE FROM ${sql.id(this.#table)} WHERE id = ${job.id} AND reservation = ${job.receipt}`,
    )
    return result.rowsAffected === 1
  }

  async release(job: ReservedJob, delaySeconds = 0): Promise<boolean> {
    const at = this.#clock.now() + checkDriverSeconds(delaySeconds, 'delaySeconds') * 1000
    const result = await this.#db.run(
      sql`UPDATE ${sql.id(this.#table)} SET available_at = ${at}, reserved_until = NULL, reservation = NULL WHERE id = ${job.id} AND reservation = ${job.receipt}`,
    )
    return result.rowsAffected === 1
  }

  async extend(job: ReservedJob, visibilitySeconds: number): Promise<boolean> {
    const until =
      this.#clock.now() + checkDriverSeconds(visibilitySeconds, 'visibilitySeconds', 1) * 1000
    const result = await this.#db.run(
      sql`UPDATE ${sql.id(this.#table)} SET reserved_until = ${until} WHERE id = ${job.id} AND reservation = ${job.receipt}`,
    )
    return result.rowsAffected === 1
  }

  async size(queue: string): Promise<number> {
    checkQueueName(queue)
    const result = await this.#db.run(
      sql`SELECT COUNT(*) AS n FROM ${sql.id(this.#table)} WHERE queue = ${queue}`,
    )
    return toIntOrUndefined(result.rows[0]?.['n']) ?? 0
  }

  async clear(queue: string): Promise<number> {
    checkQueueName(queue)
    const result = await this.#db.run(
      sql`DELETE FROM ${sql.id(this.#table)} WHERE queue = ${queue}`,
    )
    return result.rowsAffected
  }
}
