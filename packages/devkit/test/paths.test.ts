/** Path safety: every path a package hands to devkit must stay inside the project. */
import { realpathSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DevkitError } from '../src/errors.ts'
import {
  normaliseRelativePath,
  recoveryRefusal,
  resolveInsideProject,
  toProjectPath,
} from '../src/paths.ts'
import { tempProject, trySymlink } from './helpers.ts'

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

describe('recoveryRefusal', () => {
  test.each([
    ['app/x.ts', false],
    ['.env', false],
    ['.strutvane/lock.json', false],
    ['.strutvane/lock.json.corrupt-12', false],
    ['.strutvane/base/app/x.ts', false],
    ['.strutvane/README.md', true],
    ['.strutvane/registry.gen.ts', true],
    ['.Strutvane/README.md', true],
    ['.strutvane/base', true],
  ])('%s refused: %s', (path, refused) => {
    expect(recoveryRefusal(path) !== undefined).toBe(refused)
  })
})

describe('protected locations', () => {
  test.each([
    '.git/config',
    '.git/hooks/pre-commit',
    '.GIT/config',
    '.git./config',
    '.git /config',
    '.git::$INDEX_ALLOCATION/config',
    'sub/.git/config',
    'node_modules/pkg/index.js',
    'packages/a/node_modules/pkg/index.js',
    'Node_Modules/x.js',
    '.strutvane',
    '.strutvane/staging',
    '.strutvane/staging/tx/journal.json',
    '.strutvane/staging/tx/backup/0',
    '.Strutvane/Staging/tx/journal.json',
    '.strutvane./staging./x',
    'apps/web/.strutvane/staging/x',
    '.strutvane/base/.git/config',
    '.strutvane/base/node_modules/x.js',
    '.strutvane/base/.strutvane/staging/x',
  ])('refuses %s with INVALID_PATH', (input) => {
    expect(codeOf(() => normaliseRelativePath(input))).toBe('INVALID_PATH')
  })

  test.each([
    '.strutvane/lock.json',
    '.strutvane/lock.json.corrupt-1731542400000',
    '.strutvane/base/app/models/user.model.ts',
    '.strutvane/base/x',
    '.strutvane/README.md',
    '.strutvane/registry.gen.ts',
    '.strutvane/staging-notes.md',
    'nested/.strutvane/lock.json',
    '.github/workflows/ci.yml',
    '.gitignore',
    '.gitattributes',
    'git/config',
    'node_modules_backup/x.js',
    'docs/node_modules.md',
  ])('allows %s', (input) => {
    expect(normaliseRelativePath(input)).toBe(input)
  })

  describe('through links', () => {
    let root: string
    let cleanup: () => Promise<void>
    beforeEach(async () => {
      ;({ root, cleanup } = await tempProject())
      await mkdir(join(root, '.git', 'hooks'), { recursive: true })
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    })
    afterEach(() => cleanup())

    test('a link inside the project cannot reach .git or node_modules', async (ctx) => {
      if (!(await trySymlink(join(root, '.git'), join(root, 'docs'), 'junction'))) ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'docs/config'))).toBe('INVALID_PATH')
      expect(codeOf(() => resolveInsideProject(root, 'docs/hooks/post-checkout'))).toBe(
        'INVALID_PATH',
      )
      if (!(await trySymlink(join(root, 'node_modules'), join(root, 'vendor'), 'junction')))
        ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'vendor/pkg/index.js'))).toBe('INVALID_PATH')
    })

    test('a link to a protected file is refused', async (ctx) => {
      if (!(await trySymlink(join(root, '.git', 'config'), join(root, 'settings.ini'), 'file')))
        ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'settings.ini'))).toBe('INVALID_PATH')
    })

    test('a dangling link to a protected file that does not exist yet is refused', async (ctx) => {
      // Writing through this link would create .git/config, so the check must follow it.
      if (!(await trySymlink(join(root, '.git', 'new-hook'), join(root, 'notes.txt'), 'file')))
        ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'notes.txt'))).toBe('INVALID_PATH')
    })

    test('a link to an existing protected file is refused', async (ctx) => {
      await writeFile(join(root, '.git', 'config'), '[core]\n')
      if (!(await trySymlink(join(root, '.git', 'config'), join(root, 'cfg'), 'file'))) ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'cfg'))).toBe('INVALID_PATH')
    })

    test('a relative dangling link that climbs into .git is refused', async (ctx) => {
      await mkdir(join(root, 'app'), { recursive: true })
      if (!(await trySymlink('../.git/hooks/pre-push', join(root, 'app', 'hook.sh'), 'file')))
        ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'app/hook.sh'))).toBe('INVALID_PATH')
    })

    test('a link loop is refused instead of hanging', async (ctx) => {
      if (!(await trySymlink(join(root, 'loop-b'), join(root, 'loop-a'), 'file'))) ctx.skip()
      if (!(await trySymlink(join(root, 'loop-a'), join(root, 'loop-b'), 'file'))) ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'loop-a'))).toBe('INVALID_PATH')
    })

    test('a dangling link to an ordinary project file is still allowed', async (ctx) => {
      if (!(await trySymlink(join(root, 'src', 'later.ts'), join(root, 'alias.ts'), 'file')))
        ctx.skip()
      expect(codeOf(() => resolveInsideProject(root, 'alias.ts'))).toBeUndefined()
    })

    test('a Windows 8.3 short name for .git is refused by the real-path check', (ctx) => {
      if (process.platform !== 'win32') ctx.skip()
      let short: string
      try {
        short = realpathSync(join(root, 'GIT~1'))
      } catch {
        return ctx.skip() // 8.3 names are disabled on this volume
      }
      expect(short).toBeDefined()
      expect(codeOf(() => resolveInsideProject(root, 'GIT~1/config'))).toBe('INVALID_PATH')
    })
  })
})
