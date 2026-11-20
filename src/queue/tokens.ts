/**
 * The queue's container tokens. Kept in their own file so `job.ts` (which dispatches through the
 * current app) and `manager.ts` (which implements dispatch) never import each other.
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'
import type { JobCall } from './job.ts'

/**
 * What `Job.dispatch()` talks to: the app's queue manager.
 *
 * @example
 * await app.make(QueueDispatcherToken).dispatch(SendMail.with(data))
 */
export interface QueueDispatcher {
  /** Push a job; the job id, or `undefined` when a unique job's lock is held. */
  dispatch(call: JobCall): Promise<string | undefined>
  /** Run a job now in this process. */
  dispatchSync(call: JobCall): Promise<void>
}

/**
 * The container token for the dispatcher (the queue manager binds itself under it).
 *
 * @example
 * app.make(QueueDispatcherToken)
 */
export const QueueDispatcherToken: Token<QueueDispatcher> = token<QueueDispatcher>(
  'strutvane.queue.dispatcher',
)
