/**
 * Real file-system watching (node:fs.watch). Each assertion waits for the effect instead of
 * sleeping a fixed time, so the test is fast where watching is fast and still passes on slower
 * machines.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import type { WriteResult } from '../../src/registry/compiler.ts'
import { watchProject } from '../../src/registry/watch.ts'
import { cleanupTempDirs, copyFixture, modelSource, waitFor, writeFiles } from './helpers.ts'

afterAll(cleanupTempDirs)

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('watch mode', () => {
  test('a change made immediately after start is picked up (native watchers start late)', async () => {
    const root = copyFixture()
    const results: WriteResult[] = []
    const handle = watchProject(root, {
      debounceMs: 20,
      settleMs: 100,
      onResult: (r) => results.push(r),
    })
    try {
      // No pause: on macOS (FSEvents) this write can happen before events are delivered at all.
      writeFileSync(join(root, 'app/models/early.model.ts'), modelSource('Early'))
      await waitFor(
        () =>
          results.some((r) => r.result.registry?.models.some((m) => m.name === 'Early') === true),
        10_000,
        'early change',
      )
    } finally {
      handle.close()
    }
  })

  test('closing before the catch-up rebuild cancels it', async () => {
    const root = copyFixture()
    const results: WriteResult[] = []
    const handle = watchProject(root, { settleMs: 50, onResult: (r) => results.push(r) })
    handle.close()
    await pause(200)
    expect(results).toHaveLength(1) // only the initial build
  })

  test('rebuilds on edit, add and folder delete; stops cleanly on close', async () => {
    const root = copyFixture()
    const results: WriteResult[] = []
    const errors: unknown[] = []
    const handle = watchProject(root, {
      debounceMs: 20,
      onResult: (r) => results.push(r),
      onError: (e) => errors.push(e),
    })
    try {
      expect(results).toHaveLength(1) // initial build
      expect(results[0]?.written).toBe(true)
      await pause(150) // let the OS start delivering events

      const latest = () => results[results.length - 1]?.result.registry
      writeFileSync(join(root, 'app/models/tag.model.ts'), modelSource('Tag', ['label', 'color']))
      await waitFor(
        () =>
          latest()
            ?.models.find((m) => m.name === 'Tag')
            ?.fields.includes('color') === true,
        10_000,
        'edit',
      )

      writeFileSync(join(root, 'app/models/vendor.model.ts'), modelSource('Vendor'))
      await waitFor(() => latest()?.models.some((m) => m.name === 'Vendor') === true, 10_000, 'add')
      expect(readFileSync(join(root, '.strutvane/registry.gen.ts'), 'utf8')).toContain('"Vendor"')

      rmSync(join(root, 'web'), { recursive: true, force: true })
      await waitFor(() => latest()?.pages.length === 0, 10_000, 'web/ deleted')
      expect(errors).toEqual([])
    } finally {
      handle.close()
      handle.close() // idempotent
    }

    const count = results.length
    writeFileSync(join(root, 'app/models/tag.model.ts'), modelSource('Tag', ['after-close']))
    await pause(300)
    expect(results.length).toBe(count)
  })

  test('a continuous stream of events cannot starve the rebuild (max wait)', async () => {
    // Regression for the Windows event storm: a plain trailing debounce restarted on every event
    // and never fired. Writes arrive every ~5 ms for ~1 s (always inside the 20 ms debounce), so
    // only the 150 ms max wait can trigger rebuilds while the stream is still going.
    const root = copyFixture()
    const results: WriteResult[] = []
    const handle = watchProject(root, {
      debounceMs: 20,
      maxWaitMs: 150,
      onResult: (r) => results.push(r),
    })
    try {
      await pause(150)
      const before = results.length
      const until = Date.now() + 1_000
      let i = 0
      while (Date.now() < until) {
        writeFileSync(join(root, 'app/models/tag.model.ts'), modelSource('Tag', [`f${i++}`]))
        await pause(5)
      }
      const duringStream = results.length - before
      expect(duringStream).toBeGreaterThanOrEqual(2)
    } finally {
      handle.close()
    }
  })

  test('re-creating a deleted folder is picked up again', async () => {
    const root = copyFixture()
    const results: WriteResult[] = []
    const handle = watchProject(root, { debounceMs: 20, onResult: (r) => results.push(r) })
    const latest = () => results[results.length - 1]?.result.registry
    try {
      await pause(150)
      rmSync(join(root, 'web'), { recursive: true, force: true })
      await waitFor(() => latest()?.pages.length === 0, 10_000, 'web/ deleted')
      writeFiles(root, { 'web/pages/home.tsx': 'export default () => null\n' })
      await waitFor(
        () =>
          latest()
            ?.pages.map((p) => p.route)
            .join() === '/home',
        10_000,
        'web/ recreated',
      )
    } finally {
      handle.close()
    }
  })
})
