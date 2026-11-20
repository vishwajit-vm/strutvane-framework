/**
 * Shared set-up for the queue suites: a manager over any driver, with a captured log, a test
 * clock and recorded events.
 */
import { randomBytes } from 'node:crypto'
import type { QueueDriver, QueueLockStore } from '../../src/contracts/queue.ts'
import { type Clock, createTestClock, type TestClock } from '../../src/core/clock.ts'
import { createLogger } from '../../src/core/logger/logger.ts'
import { type BatchRepository, MemoryBatchRepository } from '../../src/queue/batches.ts'
import { MemoryQueueDriver } from '../../src/queue/drivers/memory.ts'
import type { QueueEvent } from '../../src/queue/events.ts'
import {
  type QueueConnection,
  QueueManager,
  type TransactionHooks,
} from '../../src/queue/manager.ts'
import type { OutboxStore } from '../../src/queue/outbox.ts'
import { EnvelopeSigner } from '../../src/queue/payload.ts'
import { JobRegistry } from '../../src/queue/registry.ts'
import {
  type FailedJobStore,
  MemoryFailedJobStore,
  MemoryQueueLockStore,
} from '../../src/queue/stores.ts'

/** A random 32-byte signing key. */
export function signingKey(): Uint8Array {
  return randomBytes(32)
}

export interface Harness {
  readonly manager: QueueManager
  readonly driver: QueueDriver
  readonly jobs: JobRegistry
  readonly failed: FailedJobStore
  readonly locks: QueueLockStore
  readonly clock: TestClock
  readonly events: QueueEvent[]
  readonly logs: string[]
  readonly signer: EnvelopeSigner
}

export interface HarnessOptions {
  readonly driver?: (clock: Clock) => QueueDriver
  readonly retryAfter?: number
  readonly failed?: FailedJobStore
  readonly locks?: (clock: Clock) => QueueLockStore
  readonly key?: Uint8Array
  readonly previousKeys?: readonly Uint8Array[]
  readonly extraConnections?: readonly QueueConnection[]
  readonly transactions?: () => TransactionHooks | undefined
  readonly clock?: TestClock
  readonly scope?: <T>(work: () => Promise<T>) => Promise<T>
  readonly batches?: (clock: Clock) => BatchRepository
  readonly outbox?: (clock: Clock) => OutboxStore
}

/** A manager whose default connection `main` uses the given driver (memory by default). */
export function harness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? createTestClock()
  const driver = options.driver?.(clock) ?? new MemoryQueueDriver({ clock, retryAfter: 90 })
  const jobs = new JobRegistry()
  const failed = options.failed ?? new MemoryFailedJobStore()
  const locks = options.locks?.(clock) ?? new MemoryQueueLockStore({ clock })
  const logs: string[] = []
  const events: QueueEvent[] = []
  const signer = new EnvelopeSigner([options.key ?? signingKey(), ...(options.previousKeys ?? [])])
  const manager = new QueueManager({
    connections: [
      {
        name: 'main',
        driver,
        defaultQueue: 'default',
        retryAfter: options.retryAfter ?? 90,
        afterCommit: false,
      },
      {
        name: 'sync',
        driver: undefined,
        defaultQueue: 'default',
        retryAfter: 90,
        afterCommit: false,
      },
      ...(options.extraConnections ?? []),
    ],
    defaultConnection: 'main',
    signer,
    jobs,
    failed,
    locks,
    clock,
    logger: createLogger({ level: 'debug', sink: (line) => logs.push(line), clock }),
    random: () => 0.5,
    batches: options.batches?.(clock) ?? new MemoryBatchRepository({ clock }),
    ...(options.outbox === undefined
      ? {}
      : {
          outbox: (() => {
            const store = options.outbox?.(clock)
            return () => store
          })(),
        }),
    ...(options.transactions === undefined ? {} : { transactions: options.transactions }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  })
  manager.listen((event) => events.push(event))
  return { manager, driver, jobs, failed, locks, clock, events, logs, signer }
}

/** Run `work` with `manager` bound as the current app's dispatcher (what `Job.dispatch` needs). */
export { runWithDispatcher } from './dispatcher.ts'
