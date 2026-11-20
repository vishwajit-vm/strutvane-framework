/**
 * The queue's tables (RFC-0006 §7, §8, §10): `jobs`, `failed_jobs`, `queue_locks`, the batch
 * tables `job_batches` and `job_batch_jobs`, and the transactional outbox `queue_outbox`.
 *
 * Apps create them with `node strut queue:table` (a migration written with the schema builder,
 * so `migrate`, rollbacks and drift checks treat them like any other table). Tests and scripts
 * without migrations can call {@link createQueueTables}, which runs the equivalent DDL directly.
 *
 * Times are epoch milliseconds in `BIGINT` columns (the app clock), so every engine compares
 * them the same way, without time-zone or precision surprises.
 *
 * @module
 */
import type { Connection } from '../database/db/connection.ts'
import { type SqlFragment, sql } from '../database/sql/fragment.ts'
import { isMysqlFamily } from '../database/sql/grammar.ts'

/**
 * The table names (configurable in `config/queue.ts`).
 *
 * @example
 * const tables: QueueTables = { ...DEFAULT_QUEUE_TABLES, jobs: 'queue_jobs' }
 */
export interface QueueTables {
  readonly jobs: string
  readonly failed: string
  readonly locks: string
  readonly batches: string
  readonly batchJobs: string
  readonly outbox: string
}

/** The default table names (Laravel's where it has one). */
export const DEFAULT_QUEUE_TABLES: QueueTables = Object.freeze({
  jobs: 'jobs',
  failed: 'failed_jobs',
  locks: 'queue_locks',
  batches: 'job_batches',
  batchJobs: 'job_batch_jobs',
  outbox: 'queue_outbox',
})

/**
 * Create the queue tables if they don't exist (tests, scripts). Apps use `queue:table`.
 *
 * @example
 * await createQueueTables(connection)
 */
export async function createQueueTables(
  connection: Connection,
  tables: QueueTables = DEFAULT_QUEUE_TABLES,
): Promise<void> {
  const big = connection.grammar.dialect === 'sqlite' ? sql`INTEGER` : sql`BIGINT`
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${sql.id(tables.jobs)} (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    queue VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at ${big} NOT NULL,
    reserved_until ${big} NULL,
    reservation VARCHAR(64) NULL,
    created_at ${big} NOT NULL
  )`)
  await createIndex(
    connection,
    tables.jobs,
    `${tables.jobs}_queue_available_at_index`,
    sql`queue, available_at`,
  )
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${sql.id(tables.failed)} (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    connection VARCHAR(64) NOT NULL,
    queue VARCHAR(64) NOT NULL,
    job VARCHAR(128) NOT NULL,
    payload TEXT NOT NULL,
    exception TEXT NOT NULL,
    failed_at ${big} NOT NULL
  )`)
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${sql.id(tables.locks)} (
    ${sql.id('key')} VARCHAR(255) NOT NULL PRIMARY KEY,
    owner VARCHAR(64) NOT NULL,
    expires_at ${big} NOT NULL
  )`)
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${sql.id(tables.batches)} (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    total_jobs INTEGER NOT NULL,
    pending_jobs INTEGER NOT NULL,
    failed_jobs INTEGER NOT NULL,
    created_at ${big} NOT NULL,
    cancelled_at ${big} NULL,
    finished_at ${big} NULL,
    caught_at ${big} NULL
  )`)
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${sql.id(tables.batchJobs)} (
    batch_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    PRIMARY KEY (batch_id, job_id)
  )`)
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${sql.id(tables.outbox)} (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    connection VARCHAR(64) NOT NULL,
    queue VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    available_at ${big} NOT NULL,
    created_at ${big} NOT NULL,
    claimed_until ${big} NULL,
    claim VARCHAR(64) NULL,
    dispatched_at ${big} NULL
  )`)
  await createIndex(
    connection,
    tables.outbox,
    `${tables.outbox}_dispatched_at_available_at_index`,
    sql`dispatched_at, available_at`,
  )
}

/** `CREATE INDEX IF NOT EXISTS`, which MySQL and MariaDB lack. */
async function createIndex(
  connection: Connection,
  table: string,
  name: string,
  columns: SqlFragment,
): Promise<void> {
  if (isMysqlFamily(connection.grammar.dialect)) {
    const existing = await connection.run(
      sql`SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${table} AND index_name = ${name}`,
    )
    if (Number(existing.rows[0]?.['n'] ?? 0) > 0) return
    await connection.run(sql`CREATE INDEX ${sql.id(name)} ON ${sql.id(table)} (${columns})`)
    return
  }
  await connection.run(
    sql`CREATE INDEX IF NOT EXISTS ${sql.id(name)} ON ${sql.id(table)} (${columns})`,
  )
}

/**
 * The migration `queue:table` writes: the same tables through the schema builder.
 *
 * @example
 * writeFileSync(path, queueTablesMigration())
 */
export function queueTablesMigration(tables: QueueTables = DEFAULT_QUEUE_TABLES): string {
  return `import { migration } from '@strutvane/framework/schema'

/**
 * The queue's tables (RFC-0006): waiting jobs, failed jobs, unique-job locks, batches and the
 * transactional outbox. Times are epoch milliseconds.
 */
export default migration({
  up(schema) {
    schema.create('${tables.jobs}', (t) => {
      t.string('id', 64).primary()
      t.string('queue', 64)
      t.text('payload')
      t.integer('attempts').default(0)
      t.bigInteger('available_at')
      t.bigInteger('reserved_until').nullable()
      t.string('reservation', 64).nullable()
      t.bigInteger('created_at')
      t.index(['queue', 'available_at'])
    })
    schema.create('${tables.failed}', (t) => {
      t.string('id', 64).primary()
      t.string('connection', 64)
      t.string('queue', 64)
      t.string('job', 128)
      t.text('payload')
      t.text('exception')
      t.bigInteger('failed_at')
    })
    schema.create('${tables.locks}', (t) => {
      t.string('key', 255).primary()
      t.string('owner', 64)
      t.bigInteger('expires_at')
    })
    schema.create('${tables.batches}', (t) => {
      t.string('id', 64).primary()
      t.string('name', 255)
      t.integer('total_jobs')
      t.integer('pending_jobs')
      t.integer('failed_jobs')
      t.bigInteger('created_at')
      t.bigInteger('cancelled_at').nullable()
      t.bigInteger('finished_at').nullable()
      t.bigInteger('caught_at').nullable()
    })
    schema.create('${tables.batchJobs}', (t) => {
      t.string('batch_id', 64)
      t.string('job_id', 64)
      t.string('state', 16)
      t.unique(['batch_id', 'job_id'])
    })
    schema.create('${tables.outbox}', (t) => {
      t.string('id', 64).primary()
      t.string('connection', 64)
      t.string('queue', 64)
      t.text('payload')
      t.bigInteger('available_at')
      t.bigInteger('created_at')
      t.bigInteger('claimed_until').nullable()
      t.string('claim', 64).nullable()
      t.bigInteger('dispatched_at').nullable()
      t.index(['dispatched_at', 'available_at'])
    })
  },
  down(schema) {
    schema.dropIfExists('${tables.outbox}')
    schema.dropIfExists('${tables.batchJobs}')
    schema.dropIfExists('${tables.batches}')
    schema.dropIfExists('${tables.locks}')
    schema.dropIfExists('${tables.failed}')
    schema.dropIfExists('${tables.jobs}')
  },
})
`
}
