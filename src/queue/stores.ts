/**
 * Where failed jobs and unique-job locks live (RFC-0006 §5, §7.2): a memory version (tests, the
 * `sync` driver) and a database version (the `failed_jobs` and `queue_locks` tables).
 *
 * @module
 */
import type { QueueLockStore } from '../contracts/queue.ts'
import { type Clock, systemClock } from '../core/clock.ts'
import type { Connection } from '../database/db/connection.ts'
import { sql } from '../database/sql/fragment.ts'
import { isMysqlFamily } from '../database/sql/grammar.ts'
import { toInt } from './drivers/shared.ts'
import { DEFAULT_QUEUE_TABLES } from './tables.ts'

/**
 * What is kept about the error of a failed job: never the job data.
 *
 * @example
 * const error: FailedJobError = { name: 'Error', message: 'SMTP refused', code: 'smtp_refused' }
 */
export interface FailedJobError {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly stack?: string
}

/**
 * One failed job.
 *
 * @example
 * const record: FailedJob = { id, connection: 'database', queue: 'default', job: 'send-mail', payload, error, failedAt }
 */
export interface FailedJob {
  /** The job id (the same id the job had in its queue). */
  readonly id: string
  readonly connection: string
  readonly queue: string
  /** The job name, or `'(unknown)'` when the payload couldn't be read. */
  readonly job: string
  /** The envelope as it was stored (re-verified on retry). */
  readonly payload: string
  readonly error: FailedJobError
  /** Epoch milliseconds. */
  readonly failedAt: number
}

/**
 * The failed-job store.
 *
 * @example
 * await store.all() // newest first
 */
export interface FailedJobStore {
  /** Record a failure. Recording the same id again replaces the record. */
  log(record: FailedJob): Promise<void>
  /** Failed jobs, newest first. */
  all(limit?: number): Promise<readonly FailedJob[]>
  find(id: string): Promise<FailedJob | undefined>
  /** Remove one; `true` when it existed. */
  forget(id: string): Promise<boolean>
  /** Remove all, or those that failed before `beforeMs`; returns how many. */
  flush(beforeMs?: number): Promise<number>
}

/**
 * Describe an error for the failed-job store.
 *
 * @example
 * describeError(new Error('boom')) // { name: 'Error', message: 'boom', stack: '…' }
 */
export function describeError(error: unknown): FailedJobError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const code = (error as { code?: unknown }).code
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  }
}

/**
 * Failed jobs in memory (tests, `sync`).
 *
 * @example
 * const failed = new MemoryFailedJobStore()
 */
export class MemoryFailedJobStore implements FailedJobStore {
  readonly #records = new Map<string, FailedJob>()

  async log(record: FailedJob): Promise<void> {
    this.#records.delete(record.id)
    this.#records.set(record.id, record)
  }

  async all(limit = 1000): Promise<readonly FailedJob[]> {
    return [...this.#records.values()].sort((a, b) => b.failedAt - a.failedAt).slice(0, limit)
  }

  async find(id: string): Promise<FailedJob | undefined> {
    return this.#records.get(id)
  }

  async forget(id: string): Promise<boolean> {
    return this.#records.delete(id)
  }

  async flush(beforeMs?: number): Promise<number> {
    let count = 0
    for (const [id, record] of this.#records) {
      if (beforeMs === undefined || record.failedAt < beforeMs) {
        this.#records.delete(id)
        count++
      }
    }
    return count
  }
}

/**
 * Failed jobs in the `failed_jobs` table.
 *
 * @example
 * const failed = new DatabaseFailedJobStore({ connection })
 */
export class DatabaseFailedJobStore implements FailedJobStore {
  readonly #db: Connection
  readonly #table: string

  constructor(options: { readonly connection: Connection; readonly table?: string }) {
    this.#db = options.connection
    this.#table = options.table ?? DEFAULT_QUEUE_TABLES.failed
  }

  async log(record: FailedJob): Promise<void> {
    const table = sql.id(this.#table)
    await this.#db.transaction(async () => {
      await this.#db.run(sql`DELETE FROM ${table} WHERE id = ${record.id}`)
      await this.#db.run(
        sql`INSERT INTO ${table} (id, connection, queue, job, payload, exception, failed_at) VALUES (${record.id}, ${record.connection}, ${record.queue}, ${record.job.slice(0, 128)}, ${record.payload}, ${JSON.stringify(record.error)}, ${record.failedAt})`,
      )
    })
  }

  async all(limit = 1000): Promise<readonly FailedJob[]> {
    const capped = Math.max(1, Math.min(10_000, Math.floor(limit)))
    const result = await this.#db.run(
      sql`SELECT id, connection, queue, job, payload, exception, failed_at FROM ${sql.id(this.#table)} ORDER BY failed_at DESC, id DESC`,
    )
    return result.rows.slice(0, capped).map(toFailedJob)
  }

  async find(id: string): Promise<FailedJob | undefined> {
    const result = await this.#db.run(
      sql`SELECT id, connection, queue, job, payload, exception, failed_at FROM ${sql.id(this.#table)} WHERE id = ${id}`,
    )
    const row = result.rows[0]
    return row === undefined ? undefined : toFailedJob(row)
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.#db.run(sql`DELETE FROM ${sql.id(this.#table)} WHERE id = ${id}`)
    return result.rowsAffected === 1
  }

  async flush(beforeMs?: number): Promise<number> {
    const table = sql.id(this.#table)
    const result = await this.#db.run(
      beforeMs === undefined
        ? sql`DELETE FROM ${table}`
        : sql`DELETE FROM ${table} WHERE failed_at < ${beforeMs}`,
    )
    return result.rowsAffected
  }
}

function toFailedJob(row: Readonly<Record<string, unknown>>): FailedJob {
  let error: FailedJobError = { name: 'Error', message: String(row['exception']) }
  try {
    const parsed: unknown = JSON.parse(String(row['exception']))
    if (parsed !== null && typeof parsed === 'object' && 'message' in parsed)
      error = parsed as FailedJobError
  } catch {
    // An exception column written by something else: keep its text as the message.
  }
  return {
    id: String(row['id']),
    connection: String(row['connection']),
    queue: String(row['queue']),
    job: String(row['job']),
    payload: String(row['payload']),
    error,
    failedAt: toInt(row['failed_at']),
  }
}

/**
 * Unique-job locks in memory (one process).
 *
 * @example
 * const locks = new MemoryQueueLockStore({ clock })
 */
export class MemoryQueueLockStore implements QueueLockStore {
  readonly #locks = new Map<string, { owner: string; expiresAt: number }>()
  readonly #clock: Clock

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock
  }

  async acquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const now = this.#clock.now()
    const held = this.#locks.get(key)
    if (held !== undefined && held.expiresAt > now) return false
    this.#locks.set(key, { owner, expiresAt: now + ttlSeconds * 1000 })
    return true
  }

  async release(key: string, owner: string): Promise<boolean> {
    const held = this.#locks.get(key)
    if (held === undefined || held.owner !== owner) return false
    return this.#locks.delete(key)
  }
}

/**
 * Unique-job locks in the `queue_locks` table, shared by every worker and web process.
 * `acquire` inserts the lock, or takes over an expired one with a compare-and-set update.
 *
 * @example
 * const locks = new DatabaseQueueLockStore({ connection })
 */
export class DatabaseQueueLockStore implements QueueLockStore {
  readonly #db: Connection
  readonly #table: string
  readonly #clock: Clock

  constructor(options: {
    readonly connection: Connection
    readonly table?: string
    readonly clock?: Clock
  }) {
    this.#db = options.connection
    this.#table = options.table ?? DEFAULT_QUEUE_TABLES.locks
    this.#clock = options.clock ?? systemClock
  }

  async acquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    if (key.length > 255) throw new TypeError('A lock key must be at most 255 characters.')
    const now = this.#clock.now()
    const expires = now + ttlSeconds * 1000
    const table = sql.id(this.#table)
    const keyColumn = sql.id('key')
    const inserted = await this.#db.run(
      isMysqlFamily(this.#db.grammar.dialect)
        ? sql`INSERT INTO ${table} (${keyColumn}, owner, expires_at) VALUES (${key}, ${owner}, ${expires}) ON DUPLICATE KEY UPDATE ${keyColumn} = ${keyColumn}`
        : sql`INSERT INTO ${table} (${keyColumn}, owner, expires_at) VALUES (${key}, ${owner}, ${expires}) ON CONFLICT (${keyColumn}) DO NOTHING`,
    )
    if (inserted.rowsAffected === 1) return true
    const taken = await this.#db.run(
      sql`UPDATE ${table} SET owner = ${owner}, expires_at = ${expires} WHERE ${keyColumn} = ${key} AND expires_at <= ${now}`,
    )
    return taken.rowsAffected === 1
  }

  async release(key: string, owner: string): Promise<boolean> {
    const result = await this.#db.run(
      sql`DELETE FROM ${sql.id(this.#table)} WHERE ${sql.id('key')} = ${key} AND owner = ${owner}`,
    )
    return result.rowsAffected === 1
  }
}
