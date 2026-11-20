/**
 * `@strutvane/framework/queue`: jobs, dispatch, the worker and the queue's extension points
 * (RFC-0006).
 *
 * ```ts
 * import { defineJob } from '@strutvane/framework/queue'
 *
 * export const SendWelcomeEmail = defineJob({
 *   name: 'send-welcome-email',
 *   tries: 3,
 *   backoff: [10, 60, 300],
 *   async handle({ userId }: { userId: string }, ctx) { … },
 * })
 *
 * await SendWelcomeEmail.dispatch({ userId })
 * ```
 *
 * Add-on drivers implement `QueueDriver` (from `@strutvane/framework/contracts`), register with
 * {@link registerQueueDriver}, and run `queueDriverContract` from `@strutvane/framework/testing`.
 *
 * @module
 */
export type {
  PushOptions,
  QueueDriver,
  QueueLockStore,
  ReservedJob,
} from '../contracts/queue.ts'
export {
  type BatchRepository,
  type BatchStatus,
  type BatchTables,
  DatabaseBatchRepository,
  DEFAULT_BATCH_TABLES,
  type MemberResult,
  MemoryBatchRepository,
} from '../queue/batches.ts'
export {
  bindQueue,
  type CreateQueueManagerOptions,
  createQueueManager,
  type QueueConfig,
  type QueueConnectionConfig,
  type QueueDriverDeps,
  type QueueDriverFactory,
  QueueDriversToken,
  QueueManagerToken,
  registerQueueDriver,
} from '../queue/config.ts'
export { discoverJobs, JOBS_FOLDER } from '../queue/discover.ts'
export { DatabaseQueueDriver, type DatabaseQueueOptions } from '../queue/drivers/database.ts'
export { MemoryQueueDriver } from '../queue/drivers/memory.ts'
export { isQueueError, QueueError, type QueueErrorCode } from '../queue/errors.ts'
export type { QueueEvent, QueueEventType, QueueListener } from '../queue/events.ts'
export {
  type Backoff,
  backoffDelay,
  type DispatchOptions,
  defineJob,
  isJob,
  JobCall,
  type JobConfig,
  type JobContext,
  type JobDefinition,
  type JobOptions,
  type RegisteredJob,
  type ResolvedJobOptions,
  type UniqueOptions,
} from '../queue/job.ts'
export {
  type BatchOptions,
  deriveId,
  PendingBatch,
  PendingChain,
  type ProcessOptions,
  type ProcessResult,
  type QueueConnection,
  QueueManager,
  type QueueManagerOptions,
  type TransactionHooks,
} from '../queue/manager.ts'
export {
  type ClaimedOutbox,
  DatabaseOutboxStore,
  type OutboxMessage,
  type OutboxStore,
} from '../queue/outbox.ts'
export {
  assertPlainData,
  type BatchInfo,
  type ChainStep,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type Envelope,
  EnvelopeSigner,
  type JsonData,
} from '../queue/payload.ts'
export { JobRegistry } from '../queue/registry.ts'
export {
  DatabaseFailedJobStore,
  DatabaseQueueLockStore,
  describeError,
  type FailedJob,
  type FailedJobError,
  type FailedJobStore,
  MemoryFailedJobStore,
  MemoryQueueLockStore,
} from '../queue/stores.ts'
export {
  createQueueTables,
  DEFAULT_QUEUE_TABLES,
  type QueueTables,
  queueTablesMigration,
} from '../queue/tables.ts'
export { type QueueDispatcher, QueueDispatcherToken } from '../queue/tokens.ts'
export {
  WORKER_EXIT,
  Worker,
  type WorkerOptions,
  type WorkerResult,
  type WorkerStopReason,
} from '../queue/worker.ts'
