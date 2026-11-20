/**
 * The transactional outbox (RFC-0006 §8).
 *
 * `Job.dispatch(data, { viaOutbox: true })` writes the signed envelope into `queue_outbox` on the
 * app's connection, **inside the caller's transaction**, so the job exists exactly when the
 * business change committed: no "row saved, job lost" after a crash, and no "job ran, row rolled
 * back". The relay (one tick per idle worker loop) moves due rows to their queue driver, oldest
 * first, and marks them dispatched.
 *
 * Rows are claimed with a compare-and-set (`claim`, `claimed_until`), like a job reservation, so
 * two relays never push one row at the same time; a relay that crashes after its push and before
 * marking the row lets the claim expire, and the row is pushed again with the same id, which the
 * database driver ignores (at-least-once on other drivers).
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import type { Clock } from '../core/clock.ts'
import { systemClock } from '../core/clock.ts'
import type { Connection } from '../database/db/connection.ts'
import { sql } from '../database/sql/fragment.ts'
import { toInt } from './drivers/shared.ts'
import { DEFAULT_QUEUE_TABLES } from './tables.ts'

/**
 * One outbox row.
 *
 * @example
 * const message: OutboxMessage = { id, connection: 'database', queue: 'default', payload, availableAt }
 */
export interface OutboxMessage {
  /** The job id (the push reuses it, so a repeated push is recognised). */
  readonly id: string
  readonly connection: string
  readonly queue: string
  /** The signed envelope. */
  readonly payload: string
  /** When the job may run (epoch ms): a delayed dispatch through the outbox. */
  readonly availableAt: number
}

/**
 * A claimed batch of outbox rows.
 *
 * @example
 * const claimed = await outbox.claim(20, 30)
 */
export interface ClaimedOutbox {
  readonly messages: readonly OutboxMessage[]
  /** The claim token: `markDispatched` only marks rows this claim still holds. */
  readonly claim: string
}

/**
 * Where outbox rows live.
 *
 * @example
 * await outbox.add(message) // inside the caller's transaction
 */
export interface OutboxStore {
  add(message: OutboxMessage): Promise<void>
  /** Claim up to `limit` due rows for `claimSeconds`. */
  claim(limit: number, claimSeconds: number): Promise<ClaimedOutbox>
  markDispatched(id: string, claim: string): Promise<boolean>
  /** Undispatched rows. */
  pending(): Promise<number>
  /** Remove dispatched rows older than `beforeMs`; returns how many. */
  prune(beforeMs: number): Promise<number>
}

/**
 * The outbox in the `queue_outbox` table.
 *
 * @example
 * const outbox = new DatabaseOutboxStore({ connection })
 */
export class DatabaseOutboxStore implements OutboxStore {
  readonly #db: Connection
  readonly #table: string
  readonly #clock: Clock

  constructor(options: {
    readonly connection: Connection
    readonly table?: string
    readonly clock?: Clock
  }) {
    this.#db = options.connection
    this.#table = options.table ?? DEFAULT_QUEUE_TABLES.outbox
    this.#clock = options.clock ?? systemClock
  }

  /** The connection rows are written on (the dispatcher checks it is in a transaction there). */
  get connection(): Connection {
    return this.#db
  }

  async add(message: OutboxMessage): Promise<void> {
    await this.#db.run(
      sql`INSERT INTO ${sql.id(this.#table)} (id, connection, queue, payload, available_at, created_at) VALUES (${message.id}, ${message.connection}, ${message.queue}, ${message.payload}, ${message.availableAt}, ${this.#clock.now()})`,
    )
  }

  async claim(limit: number, claimSeconds: number): Promise<ClaimedOutbox> {
    const table = sql.id(this.#table)
    const claim = randomBytes(16).toString('base64url')
    const now = this.#clock.now()
    const until = now + claimSeconds * 1000
    const capped = Math.max(1, Math.min(100, Math.floor(limit)))
    const candidates = await this.#db.run(
      sql`SELECT id FROM ${table} WHERE dispatched_at IS NULL AND available_at <= ${now} AND (claimed_until IS NULL OR claimed_until <= ${now}) ORDER BY available_at, id LIMIT 100`,
    )
    const messages: OutboxMessage[] = []
    for (const row of candidates.rows.slice(0, capped)) {
      const id = String(row['id'])
      const taken = await this.#db.run(
        sql`UPDATE ${table} SET claim = ${claim}, claimed_until = ${until} WHERE id = ${id} AND dispatched_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ${now})`,
      )
      if (taken.rowsAffected !== 1) continue
      const fetched = await this.#db.run(
        sql`SELECT id, connection, queue, payload, available_at FROM ${table} WHERE id = ${id} AND claim = ${claim}`,
      )
      const found = fetched.rows[0]
      if (found === undefined) continue
      messages.push({
        id,
        connection: String(found['connection']),
        queue: String(found['queue']),
        payload: String(found['payload']),
        availableAt: toInt(found['available_at']),
      })
    }
    return { messages, claim }
  }

  async markDispatched(id: string, claim: string): Promise<boolean> {
    const result = await this.#db.run(
      sql`UPDATE ${sql.id(this.#table)} SET dispatched_at = ${this.#clock.now()} WHERE id = ${id} AND claim = ${claim} AND dispatched_at IS NULL`,
    )
    return result.rowsAffected === 1
  }

  async pending(): Promise<number> {
    const result = await this.#db.run(
      sql`SELECT COUNT(*) AS n FROM ${sql.id(this.#table)} WHERE dispatched_at IS NULL`,
    )
    return toInt(result.rows[0]?.['n'] ?? 0)
  }

  async prune(beforeMs: number): Promise<number> {
    const result = await this.#db.run(
      sql`DELETE FROM ${sql.id(this.#table)} WHERE dispatched_at IS NOT NULL AND dispatched_at < ${beforeMs}`,
    )
    return result.rowsAffected
  }
}
