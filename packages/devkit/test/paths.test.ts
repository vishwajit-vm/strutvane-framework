/** Path safety: every path a package hands to devkit must stay inside the project. */
import { mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DevkitError } from '../src/errors.ts'
import { normaliseRelativePath, resolveInsideProject, toProjectPath } from '../src/paths.ts'
import { tempProject } from './helpers.ts'

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof DevkitError ? error.code : 'NOT_A_DEVKIT_ERROR'
  }
  return undefined
}

describe('normaliseRelativePath', () => {
  test.each([
    ['app/models/user.ts', 'app/models/user.ts'],
    ['./app//models/./user.ts', 'app/models/user.ts'],
    ['.env', '.env'],
    ['a/b/', 'a/b'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseRelativePath(input)).toBe(expected)
  })

  test.each([
    '../secrets',
    'app/../../etc/passwd',
    'a/b/../../../x',
    '/etc/passwd',
    'C:/Windows/system32',
    'c:relative-to-drive',
  ])('rejects escape %s with PATH_OUTSIDE_PROJECT', (input) => {
    expect(codeOf(() => normaliseRelativePath(input))).toBe('PATH_OUTSIDE_PROJECT')
  })

  test.each([
    ['', 'empty'],
    ['.', 'project root'],
    ['./', 'project root'],
    ['app\\models\\user.ts', 'backslashes'],
    ['..\\secrets', 'backslash traversal'],
    ['app/\u0000evil.ts', 'NUL byte'],
    ['app/new\nline.ts', 'newline'],
    ['app/\u007f.ts', 'DEL'],
  ])('rejects %j (%s) with INVALID_PATH', (input) => {
    expect(codeOf(() => normaliseRelativePath(input))).toBe('INVALID_PATH')
  })

  test('rejects non-strings at runtime (untyped callers)', () => {
    expect(codeOf(() => normaliseRelativePath(42 as unknown as string))).toBe('INVALID_PATH')
  })
})

describe('resolveInsideProject', () => {
  let root: string
  let cleanup: () => Promise<void>
  beforeEach(async () => {
    ;({ root, cleanup } = await tempProject())
  })
  afterEach(() => cleanup())

  test('resolves normal paths (existing or not) inside the root', () => {
    expect(resolveInsideProject(root, 'app/x.ts')).toBe(join(root, 'app', 'x.ts'))
    expect(toProjectPath(root, join(root, 'app', 'x.ts'))).toBe('app/x.ts')
  })

  test('rejects traversal before touching the disk', () => {
    expect(codeOf(() => resolveInsideProject(root, '../outside.ts'))).toBe('PATH_OUTSIDE_PROJECT')
  })

  test('rejects writing through a symlinked/junctioned directory that points outside', async () => {
    const { root: outside, cleanup: cleanOutside } = await tempProject()
    try {
      // A junction needs no privileges on Windows and behaves like a directory symlink elsewhere.
      await symlink(outside, join(root, 'escape'), 'junction')
      expect(codeOf(() => resolveInsideProject(root, 'escape/pwned.ts'))).toBe(
        'PATH_OUTSIDE_PROJECT',
      )
      expect(codeOf(() => resolveInsideProject(root, 'escape/deeper/still/pwned.ts'))).toBe(
        'PATH_OUTSIDE_PROJECT',
      )
    } finally {
      await cleanOutside()
    }
  })

  test('allows symlinks that stay inside the project', async () => {
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'alias'), 'junction')
    expect(resolveInsideProject(root, 'alias/file.ts')).toBe(join(root, 'alias', 'file.ts'))
  })

  test('works when the project root does not exist yet', () => {
    const missing = join(tmpdir(), `sv-missing-${Date.now()}`)
    expect(resolveInsideProject(missing, 'a/b.ts')).toBe(join(missing, 'a', 'b.ts'))
  })
})
