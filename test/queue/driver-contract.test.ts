/**
 * The queue-driver contract (RFC-0006 §10) on the memory driver and on the database driver over
 * every engine: SQLite and PGlite in process, MySQL 8.4, MariaDB 11.4 and PostgreSQL 18 as
 * throwaway servers (skipped with the reason when Docker is off). On the servers the race case
 * uses two separate connection pools, like two worker processes.
 */
import { describe, test } from 'vitest'
import { type DriverFactory, queueDriverContract } from '../../src/queue/driver-contract.ts'
import { DatabaseQueueDriver } from '../../src/queue/drivers/database.ts'
import { MemoryQueueDriver } from '../../src/queue/drivers/memory.ts'
import { createQueueTables } from '../../src/queue/tables.ts'
import { ENGINES, engineTitle } from '../migrations/v2/engines.ts'

const cases = queueDriverContract()

describe('memory driver', () => {
  const make: DriverFactory = async (clock, retryAfter) => ({
    driver: new MemoryQueueDriver({ clock, retryAfter }),
    cleanup: async () => {},
  })
  for (const contractCase of cases) test(contractCase.name, () => contractCase.run(make))
})

for (const engine of ENGINES) {
  describe.skipIf(engine.skipped !== undefined)(`database driver on ${engineTitle(engine)}`, () => {
    const make: DriverFactory = async (clock, retryAfter) => {
      const db = await engine.open()
      await createQueueTables(db.connection)
      const second = db.second?.()
      return {
        driver: new DatabaseQueueDriver({ connection: db.connection, clock, retryAfter }),
        ...(second === undefined
          ? {}
          : { second: new DatabaseQueueDriver({ connection: second, clock, retryAfter }) }),
        cleanup: () => db.close(),
      }
    }
    for (const contractCase of cases) test(contractCase.name, () => contractCase.run(make))
  })
}
