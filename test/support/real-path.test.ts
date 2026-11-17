/**
 * `realRoot`: a project root resolved to its real path once, so the root and the files checked
 * against it are spelled the same way (macOS temp folders, symlinked checkouts, junctions).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { realRoot } from '../../src/support/real-path.ts'
import { linkFolder, removeLinks } from '../helpers/linked-root.ts'

const real = mkdtempSync(join(tmpdir(), 'sv-real-root-'))
afterAll(() => {
  removeLinks()
  rmSync(real, { recursive: true, force: true })
})

describe('realRoot', () => {
  test('an existing folder: its real path', () => {
    expect(realRoot(real)).toBe(realpathSync(real))
  })

  test('a relative spelling: absolute and real', () => {
    expect(realRoot(relative(process.cwd(), real))).toBe(realpathSync(real))
  })

  test('a folder reached through a link (a junction on Windows): the target', ({ skip }) => {
    const linked = linkFolder(real)
    if ('skipped' in linked) return skip(linked.skipped)
    expect(realRoot(linked.path)).toBe(realpathSync(real))
    expect(realRoot(join(linked.path, '.'))).toBe(realpathSync(real))
  })

  test('a missing folder: absolute but otherwise as given, so "not found" names it', () => {
    const missing = join(real, 'nope', 'app')
    expect(realRoot(missing)).toBe(missing)
  })
})
