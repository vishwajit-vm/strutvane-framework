/**
 * Transaction hardening: recovery never trusts a journal it finds on disk, the staging area is
 * never reached through a link, and permissions survive commits, backups and recovery.
 */
import { chmod, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type DevkitError, TransactionAbortedError } from '../src/errors.ts'
import { type DevkitIo, nodeIo } from '../src/io.ts'
import {
  commitTransaction,
  hasInterruptedTransaction,
  planRecovery,
  recoverTransactions,
  stagingDir,
} from '../src/transaction.ts'
import {
  faultyIo,
  isPosix,
  readFile,
  rejectionOf,
  snapshot,
  tempProject,
  trySymlink,
  writeFiles,
} from './helpers.ts'

let projectRoot: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  await writeFiles(projectRoot, { 'a.txt': 'A\n', 'b.txt': 'B\n', 'gone.txt': 'bye\n' })
})
afterEach(() => cleanup())

const ops = [
  { path: 'a.txt', content: 'A2\n' },
  { path: 'new/c.txt', content: 'C\n' },
  { path: 'gone.txt', content: null },
  { path: 'b.txt', content: 'B2\n' },
]

/** Plant a journal (and optional backups) as if left behind by an interrupted transaction. */
async function plantJournal(
  entries: readonly { index: number; path: string; hadOriginal: boolean; mode?: number }[],
  backups: Readonly<Record<number, string>> = {},
  tx = 'tx1',
): Promise<void> {
  const dir = join(stagingDir(projectRoot), tx)
  await nodeIo.writeText(join(dir, 'journal.json'), JSON.stringify({ version: 1, entries }))
  for (const [index, content] of Object.entries(backups)) {
    await nodeIo.writeText(join(dir, 'backup', index), content)
  }
}

/** An io whose `inspect` reports something else for journal files. */
function journalInspectIo(change: (info: { kind: string; uid: number }) => object): DevkitIo {
  return {
    ...nodeIo,
    async inspect(path) {
      const info = await nodeIo.inspect(path)
      return info !== undefined && path.endsWith('journal.json')
        ? ({ ...info, ...change(info) } as typeof info)
        : info
    },
  }
}

describe('recovery refuses planted journals', () => {
  test.each([
    ['.git/config', true],
    ['.git/hooks/post-checkout', true],
    ['.GIT/hooks/pre-commit', true],
    ['node_modules/pkg/index.js', true],
    ['node_modules', false],
    ['.strutvane/staging/tx1/journal.json', false],
    ['.strutvane', false],
  ])('a journal targeting %s is refused and nothing changes', async (path, hadOriginal) => {
    await writeFiles(projectRoot, {
      '.git/config': '[core]\n',
      'node_modules/pkg/index.js': 'module.exports = 1\n',
    })
    await plantJournal([{ index: 0, path, hadOriginal }], { 0: '[core]\n\thooksPath = x\n' })
    const before = await snapshot(projectRoot)
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as DevkitError).code).toBe('INVALID_PATH')
    expect(await rejectionOf(planRecovery({ io: nodeIo, projectRoot }))).toMatchObject({
      code: 'INVALID_PATH',
    })
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test.each([
    ['.strutvane/README.md', true],
    ['.strutvane/registry.gen.ts', false],
  ])('recovery refuses %s (only project files and upgrade state)', async (path, hadOriginal) => {
    await writeFiles(projectRoot, { [path]: 'original\n' })
    await plantJournal([{ index: 0, path, hadOriginal }], { 0: 'planted\n' })
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as DevkitError).code).toBe('INVALID_PATH')
    expect((error as Error).message).toMatch(/recovery only restores project files/)
    expect(await readFile(projectRoot, path)).toBe('original\n')
  })

  test('normal writers may still write the shared .strutvane files', async () => {
    const written = {
      '.strutvane/README.md': '# state\n',
      '.strutvane/registry.gen.ts': 'export {}\n',
      '.strutvane/base/x': 'base\n',
      '.strutvane/lock.json': '{}\n',
    }
    await commitTransaction(
      Object.entries(written).map(([path, content]) => ({ path, content })),
      { io: nodeIo, projectRoot },
    )
    for (const [path, content] of Object.entries(written)) {
      expect(await readFile(projectRoot, path)).toBe(content)
    }
  })

  test('a directory with hadOriginal:false is never deleted (no recursive removal)', async () => {
    await writeFiles(projectRoot, { 'src/important/a.ts': 'keep\n', 'src/b.ts': 'keep\n' })
    await plantJournal([{ index: 0, path: 'src', hadOriginal: false }])
    const before = await snapshot(projectRoot)
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as DevkitError).code).toBe('INTERRUPTED_TRANSACTION')
    expect((error as Error).message).toMatch(/only deletes regular files/)
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('restoring over a directory is refused', async () => {
    await writeFiles(projectRoot, { 'src/a.ts': 'keep\n' })
    await plantJournal([{ index: 0, path: 'src', hadOriginal: true }], { 0: 'x' })
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as Error).message).toMatch(/only replaces files/)
    expect(await readFile(projectRoot, 'src/a.ts')).toBe('keep\n')
  })

  test('a symlink with hadOriginal:false is neither followed nor deleted', async (ctx) => {
    if (!(await trySymlink(join(projectRoot, 'a.txt'), join(projectRoot, 'link.txt'), 'file')))
      ctx.skip()
    await plantJournal([{ index: 0, path: 'link.txt', hadOriginal: false }])
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as DevkitError).code).toBe('INTERRUPTED_TRANSACTION')
    expect((await nodeIo.inspect(join(projectRoot, 'link.txt')))?.kind).toBe('symlink')
    expect(await readFile(projectRoot, 'a.txt')).toBe('A\n')
  })

  test('a backup that is a symlink to a file outside the project is refused', async (ctx) => {
    const { root: outside, cleanup: cleanOutside } = await tempProject()
    try {
      await writeFiles(outside, { 'secret.txt': 'outside-canary\n' })
      await plantJournal([{ index: 0, path: 'a.txt', hadOriginal: true }], { 1: 'unused' })
      const backup = join(stagingDir(projectRoot), 'tx1', 'backup', '0')
      if (!(await trySymlink(join(outside, 'secret.txt'), backup, 'file'))) ctx.skip()
      const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
      expect((error as Error).message).toMatch(/is a symlink, not a file/)
      expect(await readFile(projectRoot, 'a.txt')).toBe('A\n')
    } finally {
      await cleanOutside()
    }
  })

  test('every entry is validated before anything is restored (all or nothing)', async () => {
    await plantJournal(
      [
        { index: 0, path: 'a.txt', hadOriginal: true },
        { index: 1, path: '.git/hooks/pre-commit', hadOriginal: true },
      ],
      { 0: 'restored\n', 1: '#!/bin/sh\n' },
    )
    await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect(await readFile(projectRoot, 'a.txt')).toBe('A\n')
    expect(await readFile(projectRoot, '.git/hooks/pre-commit')).toBeUndefined()
  })

  test('duplicate indexes or paths in a journal are refused', async () => {
    await plantJournal([
      { index: 0, path: 'a.txt', hadOriginal: false },
      { index: 0, path: 'b.txt', hadOriginal: false },
    ])
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as Error).message).toMatch(/unreadable/)
    expect(await snapshot(projectRoot)).toMatchObject({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
  })

  test.skipIf(!isPosix)('a journal owned by another user is refused (POSIX)', async () => {
    await plantJournal([{ index: 0, path: 'a.txt', hadOriginal: false }])
    const io = journalInspectIo((info) => ({ uid: info.uid + 1 }))
    const error = await rejectionOf(recoverTransactions({ io, projectRoot }))
    expect((error as Error).message).toMatch(/owned by another user/)
    expect(await readFile(projectRoot, 'a.txt')).toBe('A\n')
  })

  test('a journal that is not a regular file is refused', async () => {
    await plantJournal([{ index: 0, path: 'a.txt', hadOriginal: false }])
    const io = journalInspectIo(() => ({ kind: 'symlink' }))
    const error = await rejectionOf(recoverTransactions({ io, projectRoot }))
    expect((error as Error).message).toMatch(/not a regular file/)
    expect(await readFile(projectRoot, 'a.txt')).toBe('A\n')
  })

  test('journals nested deeper than <tx>/journal.json are ignored, never recovered', async () => {
    await plantJournal([{ index: 0, path: 'a.txt', hadOriginal: false }], {}, 'tx1/deeper')
    expect(await hasInterruptedTransaction(nodeIo, projectRoot)).toBe(false)
    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(0)
    expect(await readFile(projectRoot, 'a.txt')).toBe('A\n')
  })
})

describe('recovery plan', () => {
  test('planRecovery lists the paths and changes nothing; a confirmed plan recovers', async () => {
    const before = await snapshot(projectRoot)
    await rejectionOf(
      commitTransaction(ops, { io: faultyIo(3, { dieAfterFailure: true }), projectRoot }),
    )
    const halfApplied = await snapshot(projectRoot)
    const plan = await planRecovery({ io: nodeIo, projectRoot })
    expect(plan.paths).toEqual(['a.txt', 'b.txt', 'gone.txt', 'new/c.txt'])
    expect(plan.transactions).toHaveLength(1)
    expect(plan.transactions[0]?.steps).toEqual([
      { path: 'b.txt', action: 'restore' },
      { path: 'gone.txt', action: 'restore' },
      { path: 'new/c.txt', action: 'delete' },
      { path: 'a.txt', action: 'restore' },
    ])
    expect(await snapshot(projectRoot)).toEqual(halfApplied)

    expect(await recoverTransactions({ io: nodeIo, projectRoot, confirmed: plan })).toBe(1)
    expect(await snapshot(projectRoot)).toEqual(before)
    expect(await planRecovery({ io: nodeIo, projectRoot })).toEqual({ transactions: [], paths: [] })
  })

  test('recovery refuses when the journals changed after the plan was confirmed', async () => {
    await plantJournal([{ index: 0, path: 'a.txt', hadOriginal: false }])
    const plan = await planRecovery({ io: nodeIo, projectRoot })
    await plantJournal([{ index: 0, path: 'b.txt', hadOriginal: false }], {}, 'tx2')
    const error = await rejectionOf(
      recoverTransactions({ io: nodeIo, projectRoot, confirmed: plan }),
    )
    expect((error as Error).message).toMatch(/differ from the confirmed recovery plan/)
    expect(await snapshot(projectRoot)).toMatchObject({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
  })

  test('a crash during recovery itself can be recovered again (idempotent)', async () => {
    const before = await snapshot(projectRoot)
    await rejectionOf(
      commitTransaction(ops, { io: faultyIo(3, { dieAfterFailure: true }), projectRoot }),
    )
    // The first restore rename succeeds, the next one "crashes".
    let renames = 0
    const dying: DevkitIo = {
      ...nodeIo,
      async rename(from, to) {
        if (++renames === 2) throw new Error('simulated crash during recovery')
        return nodeIo.rename(from, to)
      },
    }
    await rejectionOf(recoverTransactions({ io: dying, projectRoot }))
    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(1)
    expect(await snapshot(projectRoot)).toEqual(before)
  })
})

describe('staging area safety', () => {
  test.for(['.strutvane', '.strutvane/staging'])(
    'a symlinked or junctioned %s is refused by commit and recovery',
    async (rel, ctx) => {
      const { root: outside, cleanup: cleanOutside } = await tempProject()
      try {
        if (rel !== '.strutvane') await writeFiles(projectRoot, { '.strutvane/lock.json': '{}' })
        const link = join(projectRoot, ...rel.split('/'))
        if (!(await trySymlink(outside, link, 'junction'))) ctx.skip()
        const before = await snapshot(projectRoot)
        const error = await rejectionOf(
          commitTransaction([{ path: '.env', content: 'SECRET=canary\n' }], {
            io: nodeIo,
            projectRoot,
          }),
        )
        expect((error as DevkitError).code).toBe('PATH_OUTSIDE_PROJECT')
        expect(await snapshot(outside)).toEqual({})
        expect(await snapshot(projectRoot)).toEqual(before)
        const recovery = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
        expect((recovery as DevkitError).code).toBe('PATH_OUTSIDE_PROJECT')
      } finally {
        await cleanOutside()
      }
    },
  )

  test('a delete operation never removes a directory', async () => {
    await writeFiles(projectRoot, { 'dir/keep.txt': 'keep\n' })
    const error = await rejectionOf(
      commitTransaction([{ path: 'dir', content: null }], { io: nodeIo, projectRoot }),
    )
    expect(error).toBeInstanceOf(TransactionAbortedError)
    expect(await readFile(projectRoot, 'dir/keep.txt')).toBe('keep\n')
  })

  test('operations on protected locations are refused before anything is staged', async () => {
    for (const path of ['.git/config', 'node_modules/x/index.js', '.strutvane/staging/x']) {
      const error = await rejectionOf(
        commitTransaction([{ path, content: 'x' }], { io: nodeIo, projectRoot }),
      )
      expect((error as DevkitError).code).toBe('INVALID_PATH')
    }
    expect(await nodeIo.exists(stagingDir(projectRoot))).toBe(false)
  })
})

describe('nodeIo.removeFile and modes', () => {
  test('removes a regular file, ignores a missing one, refuses a directory', async () => {
    await nodeIo.removeFile(join(projectRoot, 'a.txt'))
    expect(await readFile(projectRoot, 'a.txt')).toBeUndefined()
    await nodeIo.removeFile(join(projectRoot, 'missing.txt'))
    await writeFiles(projectRoot, { 'dir/x.txt': 'x' })
    const error = await rejectionOf(nodeIo.removeFile(join(projectRoot, 'dir')))
    expect((error as DevkitError).code).toBe('INVALID_PATH')
    expect(await readFile(projectRoot, 'dir/x.txt')).toBe('x')
  })

  test('refuses a symlinked directory without touching its target', async (ctx) => {
    await writeFiles(projectRoot, { 'real/x.txt': 'x' })
    if (!(await trySymlink(join(projectRoot, 'real'), join(projectRoot, 'alias'), 'junction')))
      ctx.skip()
    const error = await rejectionOf(nodeIo.removeFile(join(projectRoot, 'alias')))
    expect((error as DevkitError).code).toBe('INVALID_PATH')
    expect(await readFile(projectRoot, 'real/x.txt')).toBe('x')
  })

  test('writeText with a mode never throws, even where chmod is limited (Windows)', async () => {
    await nodeIo.writeText(join(projectRoot, 'm/x.txt'), 'x', { mode: 0o600, dirMode: 0o700 })
    await nodeIo.writeText(join(projectRoot, 'm/x.txt'), 'y', { mode: 0o600 })
    expect(await readFile(projectRoot, 'm/x.txt')).toBe('y')
    expect((await nodeIo.inspect(join(projectRoot, 'm/x.txt')))?.kind).toBe('file')
    expect((await nodeIo.inspect(join(projectRoot, 'm')))?.kind).toBe('directory')
    expect(await nodeIo.inspect(join(projectRoot, 'm/missing'))).toBeUndefined()
  })

  test('a commit replacing a secret env file works on every platform', async () => {
    await writeFiles(projectRoot, { '.env': 'A=1\n' })
    await commitTransaction(
      [
        { path: '.env', content: 'A=2\n' },
        { path: '.env.local', content: 'B=1\n' },
      ],
      { io: nodeIo, projectRoot },
    )
    expect(await readFile(projectRoot, '.env')).toBe('A=2\n')
    expect(await readFile(projectRoot, '.env.local')).toBe('B=1\n')
  })
})

describe.skipIf(!isPosix)('permissions (POSIX)', () => {
  const modeOf = async (path: string) => (await stat(join(projectRoot, path))).mode & 0o777

  test('a replaced file keeps its mode (a 0600 .env stays 0600, a 0755 script stays 0755)', async () => {
    await writeFiles(projectRoot, { '.env': 'A=1\n', 'run.sh': '#!/bin/sh\n' })
    await chmod(join(projectRoot, '.env'), 0o600)
    await chmod(join(projectRoot, 'run.sh'), 0o755)
    await commitTransaction(
      [
        { path: '.env', content: 'A=2\n' },
        { path: 'run.sh', content: '#!/bin/sh\necho\n' },
      ],
      { io: nodeIo, projectRoot },
    )
    expect(await modeOf('.env')).toBe(0o600)
    expect(await modeOf('run.sh')).toBe(0o755)
  })

  test('new secret env files are created 0600; .env.example is not', async () => {
    await commitTransaction(
      [
        { path: '.env', content: 'A=1\n' },
        { path: 'config/.env.production', content: 'A=1\n' },
        { path: '.env.example', content: 'A=\n' },
        { path: 'plain.txt', content: 'x\n' },
      ],
      { io: nodeIo, projectRoot },
    )
    expect(await modeOf('.env')).toBe(0o600)
    expect(await modeOf('config/.env.production')).toBe(0o600)
    // `.env.example` is committed documentation: it gets the same default mode as any new file.
    expect(await modeOf('.env.example')).toBe(await modeOf('plain.txt'))
  })

  test('backups and journals are 0600 and staging folders 0700', async () => {
    await writeFiles(projectRoot, { '.env': 'SECRET=canary\n' })
    await chmod(join(projectRoot, '.env'), 0o600)
    await rejectionOf(
      commitTransaction(
        [
          { path: 'a.txt', content: 'A2\n' },
          { path: '.env', content: 'SECRET=next\n' },
        ],
        { io: faultyIo(2, { dieAfterFailure: true }), projectRoot },
      ),
    )
    const staging = stagingDir(projectRoot)
    const [tx] = await readdir(staging)
    expect(tx).toBeDefined()
    const dir = join(staging, tx as string)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'backup'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'backup', '1'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'journal.json'))).mode & 0o777).toBe(0o600)
  })

  test('recovery restores the original mode, without setuid bits from a journal', async () => {
    await writeFiles(projectRoot, { '.env': 'SECRET=canary\n' })
    await chmod(join(projectRoot, '.env'), 0o600)
    await rejectionOf(
      commitTransaction(
        [
          { path: '.env', content: null },
          { path: 'a.txt', content: 'A2\n' },
        ],
        { io: faultyIo(1, { dieAfterFailure: true }), projectRoot },
      ),
    )
    // The crash came after the delete: the original is gone, only the backup remains.
    expect(await readFile(projectRoot, '.env')).toBeUndefined()
    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(1)
    expect(await modeOf('.env')).toBe(0o600)

    await plantJournal([{ index: 0, path: 'tool', hadOriginal: true, mode: 0o4755 }], { 0: 'x' })
    await recoverTransactions({ io: nodeIo, projectRoot })
    expect((await stat(join(projectRoot, 'tool'))).mode & 0o7777).toBe(0o755)
  })
})
