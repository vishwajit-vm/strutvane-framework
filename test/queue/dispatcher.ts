/**
 * Bind a queue manager as the current application's dispatcher, the way the booted app does, so
 * `Job.dispatch()` works in a test without booting a whole app.
 */
import { createContainer } from '../../src/core/container.ts'
import { runInApplication } from '../../src/foundation/current.ts'
import type { QueueManager } from '../../src/queue/manager.ts'
import { QueueDispatcherToken } from '../../src/queue/tokens.ts'

export function runWithDispatcher<T>(manager: QueueManager, work: () => T): T {
  const container = createContainer()
  container.value(QueueDispatcherToken, manager)
  return runInApplication({ container, basePath: process.cwd() }, work)
}
