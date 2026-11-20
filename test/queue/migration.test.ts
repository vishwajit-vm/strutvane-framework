/**
 * The migration `queue:table` writes (RFC-0006 §10): it replays through the schema builder, the
 * v2 migrator applies and rolls it back on every engine, and the queue's drivers and stores work
 * on the tables it creates (not only on `createQueueTables`' hand-written DDL).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTestClock } from '../../src/core/clock.ts'
import { migrate, rollback } from '../../src/migrations/runner.ts'
import { DatabaseBatchRepository } from '../../src/queue/batches.ts'
import { DatabaseQueueDriver } from '../../src/queue/drivers/database.ts'
import { DatabaseOutboxStore } from '../../src/queue/outbox.ts'
import { DatabaseFailedJobStore, DatabaseQueueLockStore } from '../../src/queue/stores.ts'
import { queueTablesMigration } from '../../src/queue/tables.ts'
import { discoverMigrations, loadMigrations, replayMigrations } from '../../src/schema/replay.ts'
import { ENGINES, engineTitle, type OpenDatabase } from '../migrations/v2/engines.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/** The generated migration, with its package import pointed at this checkout's source. */
function migrationFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'strut-queue-migration-'))
  const source = queueTablesMigration().replace(
    "'@strutvane/framework/schema'",
    `'${pathToFileURL(join(ROOT, 'src', 'entries', 'schema.ts')).href}'`,
  )
  writeFileSync(join(folder, '2026_11_20_000000_create_queue_tables.ts'), source)
  return folder
}

for (const engine of ENGINES) {
  describe.skipIf(engine.skipped !== undefined)(
    `queue:table migration on ${engineTitle(engine)}`,
    () => {
      let db: OpenDatabase
      let folder: string
      beforeEach(async () => {
        db = await engine.open()
        folder = migrationFolder()
      })
      afterEach(async () => {
        await db.close()
        rmSync(folder, { recursive: true, force: true })
      })

      test('migrates, serves every queue store, and rolls back', async () => {
        const replay = replayMigrations(await loadMigrations(discoverMigrations(folder)))
        expect(replay.state.tables.map((table) => table.name).sort()).toEqual([
          'failed_jobs',
          'job_batch_jobs',
          'job_batches',
          'jobs',
          'queue_locks',
          'queue_outbox',
        ])
        expect((await migrate(db.connection, replay)).ran).toHaveLength(1)

        const clock = createTestClock()
        const connection = db.connection
        const driver = new DatabaseQueueDriver({ connection, clock })
        await driver.push('default', 'x'.repeat(60_000))
        const job = await driver.pop('default')
        expect(job?.payload.length).toBe(60_000)
        expect(job === undefined ? false : await driver.ack(job)).toBe(true)

        const failed = new DatabaseFailedJobStore({ connection })
        await failed.log({
          id: 'f1',
          connection: 'database',
          queue: 'default',
          job: 'j',
          payload: '{}',
          error: { name: 'Error', message: 'x' },
          failedAt: clock.now(),
        })
        expect(await failed.all()).toHaveLength(1)

        const locks = new DatabaseQueueLockStore({ connection, clock })
        expect(await locks.acquire('k', 'a', 60)).toBe(true)
        expect(await locks.acquire('k', 'b', 60)).toBe(false)

        const batches = new DatabaseBatchRepository({ connection, clock })
        await batches.create({ id: 'b', name: 'n', jobIds: ['j1', 'j2'] })
        expect((await batches.recordSuccess('b', 'j1')).counted).toBe(true)

        const outbox = new DatabaseOutboxStore({ connection, clock })
        await outbox.add({
          id: 'o',
          connection: 'database',
          queue: 'default',
          payload: '{}',
          availableAt: clock.now(),
        })
        expect((await outbox.claim(5, 30)).messages).toHaveLength(1)

        await rollback(connection, replay)
        const { rows } =
          await connection.run(
            (await import('../../src/database/sql/fragment.ts')).sql`SELECT 1 AS one`,
          )
        expect(rows).toHaveLength(1)
        await expect(driver.size('default')).rejects.toThrow()
      })
    },
  )
}
