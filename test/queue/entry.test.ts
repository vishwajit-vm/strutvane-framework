/**
 * The public surface of the queue: the `@strutvane/framework/queue` subpath, the contract suite
 * on `/testing`, the driver types on `/contracts`, and the package.json export.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as queue from '../../src/entries/queue.ts'
import * as testing from '../../src/testing/index.ts'

describe('@strutvane/framework/queue', () => {
  it('exports jobs, the manager, the worker, drivers, stores and the extension points', () => {
    for (const name of [
      'defineJob',
      'JobCall',
      'QueueManager',
      'QueueManagerToken',
      'QueueDispatcherToken',
      'Worker',
      'WORKER_EXIT',
      'DatabaseQueueDriver',
      'MemoryQueueDriver',
      'DatabaseFailedJobStore',
      'DatabaseQueueLockStore',
      'registerQueueDriver',
      'createQueueTables',
      'queueTablesMigration',
      'discoverJobs',
      'EnvelopeSigner',
      'QueueError',
    ])
      expect(queue, name).toHaveProperty(name)
  })

  it('ships the driver contract suite on /testing, for add-on drivers', () => {
    expect(typeof testing.queueDriverContract).toBe('function')
    const names = testing
      .queueDriverContract({ idempotentPush: false, usesClock: false })
      .map((c) => c.name)
    expect(names.some((name) => name.includes('racing'))).toBe(true)
    expect(names.some((name) => name.includes('idempotent'))).toBe(false)
    expect(names.some((name) => name.includes('delayed'))).toBe(false)
  })

  it('is a package.json export', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    )
    expect(pkg.exports['./queue']).toEqual({
      types: './dist/queue.d.mts',
      default: './dist/queue.mjs',
    })
  })
})
