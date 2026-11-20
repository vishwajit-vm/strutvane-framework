/**
 * The `Queue` and `Bus` facades (RFC-0006 §3): the current app's queue manager, Laravel's
 * `Queue::` and `Bus::`.
 *
 * @module
 */

import type { BatchStatus } from '../queue/batches.ts'
import { QueueManagerToken } from '../queue/config.ts'
import type { JobCall } from '../queue/job.ts'
import type { PendingBatch, PendingChain, QueueManager } from '../queue/manager.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<QueueManager> = {
  facade: 'Queue',
  token: QueueManagerToken,
  provides: 'the queue manager',
  install:
    'The app binds the queue manager from config/queue.ts when it boots; bind your own with app.container.value(QueueManagerToken, manager).',
}

const busBinding: FacadeBinding<QueueManager> = { ...binding, facade: 'Bus' }

/**
 * What the `Queue` facade offers.
 *
 * @example
 * const queue: QueueFacade = Queue
 */
export interface QueueFacade {
  /** Queue a job (`Job.with(data)`); its id, or `undefined` when a unique job's lock is held. */
  push(call: JobCall): Promise<string | undefined>
  /** Queue a job after `delay` seconds (or at a Date). */
  later(delay: number | Date, call: JobCall): Promise<string | undefined>
  /** Jobs waiting, delayed and reserved on a queue (default connection and queue when omitted). */
  size(queue?: string, connection?: string): Promise<number>
  /** The queue manager itself (connections, failed jobs, events). */
  manager(): QueueManager
}

/**
 * Queue jobs through the current app.
 *
 * @example
 * await Queue.push(SendWelcomeEmail.with({ userId }))
 * await Queue.later(60, SendReminder.with({ userId }))
 */
export const Queue: QueueFacade = Object.freeze({
  push: (call: JobCall): Promise<string | undefined> =>
    resolveFacade(binding, 'push').dispatch(call),
  later: (delay: number | Date, call: JobCall): Promise<string | undefined> =>
    resolveFacade(binding, 'later').dispatch(call.delay(delay)),
  size: (queue?: string, connection?: string): Promise<number> => {
    const resolved = resolveFacade(binding, 'size').connection(connection)
    if (resolved.driver === undefined) return Promise.resolve(0)
    return resolved.driver.size(queue ?? resolved.defaultQueue)
  },
  manager: (): QueueManager => resolveFacade(binding, 'manager'),
})

/**
 * What the `Bus` facade offers.
 *
 * @example
 * const bus: BusFacade = Bus
 */
export interface BusFacade {
  /** Queue a job. */
  dispatch(call: JobCall): Promise<string | undefined>
  /** Run a job now, in this process. */
  dispatchSync(call: JobCall): Promise<void>
  /** Start a chain: each job runs after the previous one succeeded. */
  chain(calls: readonly JobCall[]): PendingChain
  /** Start a batch: jobs that run in parallel, with onSuccess/onFailure/onFinish jobs. */
  batch(calls: readonly JobCall[]): PendingBatch
  /** A batch's progress, or `undefined`. */
  findBatch(id: string): Promise<BatchStatus | undefined>
}

/**
 * Dispatch jobs and chains through the current app.
 *
 * @example
 * await Bus.chain([Resize.with({ id }), Publish.with({ id })]).onFailure(Notify.with({ id })).dispatch()
 */
export const Bus: BusFacade = Object.freeze({
  dispatch: (call: JobCall): Promise<string | undefined> =>
    resolveFacade(busBinding, 'dispatch').dispatch(call),
  dispatchSync: (call: JobCall): Promise<void> =>
    resolveFacade(busBinding, 'dispatchSync').dispatchSync(call),
  chain: (calls: readonly JobCall[]): PendingChain =>
    resolveFacade(busBinding, 'chain').chain(calls),
  batch: (calls: readonly JobCall[]): PendingBatch =>
    resolveFacade(busBinding, 'batch').batch(calls),
  findBatch: (id: string): Promise<BatchStatus | undefined> =>
    resolveFacade(busBinding, 'findBatch').findBatch(id),
})
