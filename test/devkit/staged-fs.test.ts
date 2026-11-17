/** The staged file system: writes are buffered, previewable and committed as one transaction. */
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DevkitError } from '../../src/devkit/errors.ts'
import { createStagedFs } from '../../src/devkit/staged-fs.ts'
import { faultyIo, readFile, rejectionOf, snapshot, tempProject, writeFiles } from './helpers.ts'

let projectRoot: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  await writeFiles(projectRoot, { 'existing.ts': 'export const a = 1\n', 'win.ts': 'a\r\nb\r\n' })
})
afterEach(() => cleanup())

describe('createStagedFs', () => {
  test('reads see staged content first; nothing touches the disk until commit', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.write('app/new.ts', 'export {}\n')
    expect(await fs.exists('app/new.ts')).toBe(true)
    expect(await fs.read('app/new.ts')).toBe('export {}\n')
    expect(await readFile(projectRoot, 'app/new.ts')).toBeUndefined()

    expect(await fs.commit()).toEqual(['app/new.ts'])
    expect(await readFile(projectRoot, 'app/new.ts')).toBe('export {}\n')
    expect(await fs.changes()).toEqual([]) // stage cleared
  })

  test('refuses to replace a different existing file unless overwrite is set', async () => {
    const fs = createStagedFs(projectRoot)
    const error = await rejectionOf(fs.write('existing.ts', 'export const a = 2\n'))
    expect((error as DevkitError).code).toBe('file_exists')
    await fs.write('existing.ts', 'export const a = 2\n', { overwrite: true })
    expect(await fs.changes()).toMatchObject([{ path: 'existing.ts', kind: 'update' }])
  })

  test('writing identical content is a no-op (idempotent installers)', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.write('existing.ts', 'export const a = 1\n')
    expect(await fs.changes()).toEqual([])
    expect(await fs.diff()).toBe('')
  })

  test('preserves CRLF line endings of an existing file by default', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.write('win.ts', 'a\nb\nc\n', { overwrite: true })
    expect(await fs.read('win.ts')).toBe('a\r\nb\r\nc\r\n')
    await fs.write('win.ts', 'a\nb\nc\n') // same content once re-encoded: no-op, no file_exists
    expect(await fs.read('win.ts')).toBe('a\r\nb\r\nc\r\n')
    await fs.write('win.ts', 'lf\n', { overwrite: true, preserveLineEndings: false })
    expect(await fs.read('win.ts')).toBe('lf\n')
  })

  test('remove stages a deletion; removing a missing file is a no-op', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.remove('existing.ts')
    await fs.remove('never-existed.ts')
    expect(await fs.exists('existing.ts')).toBe(false)
    expect(((await rejectionOf(fs.read('existing.ts'))) as DevkitError).code).toBe('file_not_found')
    expect(await fs.changes()).toMatchObject([{ path: 'existing.ts', kind: 'delete' }])
    await fs.commit()
    expect(await readFile(projectRoot, 'existing.ts')).toBeUndefined()
  })

  test('removing a file that was only staged un-stages it', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.write('tmp.ts', 'x\n')
    await fs.remove('tmp.ts')
    expect(await fs.changes()).toEqual([])
  })

  test('changes are sorted and the diff is a unified patch with /dev/null for creates/deletes', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.write('z.ts', 'z\n')
    await fs.write('existing.ts', 'export const a = 2\n', { overwrite: true })
    await fs.remove('win.ts')
    expect((await fs.changes()).map((c) => [c.path, c.kind])).toEqual([
      ['existing.ts', 'update'],
      ['win.ts', 'delete'],
      ['z.ts', 'create'],
    ])
    const diff = await fs.diff()
    expect(diff).toContain('--- a/existing.ts')
    expect(diff).toContain('+export const a = 2')
    expect(diff).toContain('--- /dev/null\n+++ b/z.ts')
    expect(diff).toContain('--- a/win.ts\n+++ /dev/null')
  })

  test('staging the original content back means no change', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.write('existing.ts', 'changed\n', { overwrite: true })
    await fs.write('existing.ts', 'export const a = 1\n', { overwrite: true })
    expect(await fs.changes()).toEqual([])
  })

  test('discard drops everything', async () => {
    const fs = createStagedFs(projectRoot)
    await fs.write('a.ts', 'a\n')
    fs.discard()
    expect(await fs.changes()).toEqual([])
  })

  test('rejects traversal, absolute paths and symlink escapes at write time', async () => {
    const fs = createStagedFs(projectRoot)
    for (const path of ['../x.ts', '/etc/passwd', 'C:/x.ts', 'a\\..\\..\\x.ts']) {
      expect(await rejectionOf(fs.write(path, 'x'))).toBeInstanceOf(DevkitError)
    }
    const { root: outside, cleanup: cleanOutside } = await tempProject()
    try {
      await symlink(outside, join(projectRoot, 'link'), 'junction')
      const error = await rejectionOf(fs.write('link/pwned.ts', 'x'))
      expect((error as DevkitError).code).toBe('path_outside_project')
      expect(await snapshot(outside)).toEqual({})
    } finally {
      await cleanOutside()
    }
  })

  test('a failed commit rolls back and keeps the project unchanged', async () => {
    const fs = createStagedFs(projectRoot, { io: faultyIo(2) })
    await fs.write('a.ts', 'a\n')
    await fs.write('b.ts', 'b\n')
    const before = await snapshot(projectRoot)
    expect((await rejectionOf(fs.commit())) as DevkitError).toMatchObject({
      code: 'transaction_aborted',
    })
    expect(await snapshot(projectRoot)).toEqual(before)
  })
})
