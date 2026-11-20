/**
 * The queue's tables (RFC-0006 §7, §10): `jobs`, `failed_jobs` and `queue_locks`.
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
import { sql } from '../database/sql/fragment.ts'
import { isMysqlFamily } from '../database/sql/grammar.ts'

/**
 * The table names (configurable in `config/queue.ts`).
 *
 * @example
 * const tables: QueueTables = { jobs: 'jobs', failed: 'failed_jobs', locks: 'queue_locks' }
 */
export interface QueueTables {
  readonly jobs: string
  readonly failed: string
  readonly locks: string
}

/** The default table names (Laravel's, plus `queue_locks`). */
export const DEFAULT_QUEUE_TABLES: QueueTables = Object.freeze({
  jobs: 'jobs',
  failed: 'failed_jobs',
  locks: 'queue_locks',
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
  const mysql = isMysqlFamily(connection.grammar.dialect)
  const big = connection.grammar.dialect === 'sqlite' ? sql`INTEGER` : sql`BIGINT`
  const jobs = sql.id(tables.jobs)
  const failed = sql.id(tables.failed)
  const locks = sql.id(tables.locks)
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${jobs} (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    queue VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at ${big} NOT NULL,
    reserved_until ${big} NULL,
    reservation VARCHAR(64) NULL,
    created_at ${big} NOT NULL
  )`)
  const index = sql.id(`${tables.jobs}_queue_available_at_index`)
  if (mysql) {
    const existing = await connection.run(
      sql`SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${tables.jobs} AND index_name = ${`${tables.jobs}_queue_available_at_index`}`,
    )
    if (Number(existing.rows[0]?.['n'] ?? 0) === 0)
      await connection.run(sql`CREATE INDEX ${index} ON ${jobs} (queue, available_at)`)
  } else {
    await connection.run(sql`CREATE INDEX IF NOT EXISTS ${index} ON ${jobs} (queue, available_at)`)
  }
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${failed} (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    connection VARCHAR(64) NOT NULL,
    queue VARCHAR(64) NOT NULL,
    job VARCHAR(128) NOT NULL,
    payload TEXT NOT NULL,
    exception TEXT NOT NULL,
    failed_at ${big} NOT NULL
  )`)
  await connection.run(sql`CREATE TABLE IF NOT EXISTS ${locks} (
    ${sql.id('key')} VARCHAR(255) NOT NULL PRIMARY KEY,
    owner VARCHAR(64) NOT NULL,
    expires_at ${big} NOT NULL
  )`)
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
 * The queue's tables (RFC-0006): waiting jobs, failed jobs and unique-job locks.
 * Times are epoch milliseconds.
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
  },
  down(schema) {
    schema.dropIfExists('${tables.locks}')
    schema.dropIfExists('${tables.failed}')
    schema.dropIfExists('${tables.jobs}')
  },
})
`
}
