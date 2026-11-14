/** Multi-file transactions: all or nothing, rollback, crash recovery. */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type DevkitError, TransactionAbortedError } from '../src/errors.ts'
import { type DevkitIo, nodeIo } from '../src/io.ts'
import {
  commitTransaction,
  hasInterruptedTransaction,
  recoverTransactions,
  stagingDir,
} from '../src/transaction.ts'
import {
  failingWriteIo,
  faultyIo,
  readFile,
  rejectionOf,
  snapshot,
  tempProject,
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

describe('commitTransaction', () => {
  test('applies creates, updates and deletes, and leaves no staging behind', async () => {
    await commitTransaction(ops, { io: nodeIo, projectRoot })
    expect(await snapshot(projectRoot)).toEqual({
      'a.txt': 'A2\n',
      'b.txt': 'B2\n',
      'new/c.txt': 'C\n',
    })
    expect(await nodeIo.exists(stagingDir(projectRoot))).toBe(false)
  })

  test('an empty transaction is a no-op', async () => {
    const before = await snapshot(projectRoot)
    await commitTransaction([], { io: nodeIo, projectRoot })
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('rejects the same path twice and paths outside the project, before writing anything', async () => {
    const before = await snapshot(projectRoot)
    const dup = await rejectionOf(
      commitTransaction(
        [
          { path: 'a.txt', content: '1' },
          { path: 'a.txt', content: '2' },
        ],
        { io: nodeIo, projectRoot },
      ),
    )
    expect((dup as DevkitError).code).toBe('INVALID_PATH')
    const outside = await rejectionOf(
      commitTransaction([{ path: '../evil.txt', content: 'x' }], { io: nodeIo, projectRoot }),
    )
    expect((outside as DevkitError).code).toBe('PATH_OUTSIDE_PROJECT')
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('a failure while staging changes nothing and cleans up', async () => {
    const before = await snapshot(projectRoot)
    const error = await rejectionOf(commitTransaction(ops, { io: failingWriteIo(2), projectRoot }))
    expect(error).toBeInstanceOf(TransactionAbortedError)
    expect((error as TransactionAbortedError).rolledBack).toBe(true)
    expect((error as Error).message).toMatch(/nothing was modified/)
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test.each([1, 2, 3])('rollback when rename #%i fails mid-commit', async (n) => {
    const before = await snapshot(projectRoot)
    const error = await rejectionOf(commitTransaction(ops, { io: faultyIo(n), projectRoot }))
    expect((error as TransactionAbortedError).rolledBack).toBe(true)
    expect((error as TransactionAbortedError).cause).toBeInstanceOf(Error)
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('a failed delete mid-commit is rolled back too', async () => {
    const before = await snapshot(projectRoot)
    let removes = 0
    const io: DevkitIo = {
      ...nodeIo,
      async removeFile(path) {
        // The first removal is the deletion of gone.txt (op #3); fail it.
        if (path.endsWith('gone.txt') && removes++ === 0) throw new Error('EBUSY')
        return nodeIo.removeFile(path)
      },
    }
    const error = await rejectionOf(commitTransaction(ops, { io, projectRoot }))
    expect((error as TransactionAbortedError).rolledBack).toBe(true)
    expect(await snapshot(projectRoot)).toEqual(before)
  })
})

describe('crash recovery', () => {
  test('a crash mid-commit keeps the journal; new transactions refuse; recovery restores', async () => {
    const before = await snapshot(projectRoot)
    const error = await rejectionOf(
      commitTransaction(ops, { io: faultyIo(2, { dieAfterFailure: true }), projectRoot }),
    )
    expect((error as TransactionAbortedError).rolledBack).toBe(false)
    expect(await readFile(projectRoot, 'a.txt')).toBe('A2\n') // half-applied on disk
    expect(await hasInterruptedTransaction(nodeIo, projectRoot)).toBe(true)

    const refused = await rejectionOf(
      commitTransaction([{ path: 'x.txt', content: 'x' }], { io: nodeIo, projectRoot }),
    )
    expect((refused as DevkitError).code).toBe('INTERRUPTED_TRANSACTION')

    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(1)
    expect(await snapshot(projectRoot)).toEqual(before)
    expect(await hasInterruptedTransaction(nodeIo, projectRoot)).toBe(false)
    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(0)
  })

  test('recovery works after the project folder was moved (journal paths are relative)', async () => {
    const before = await snapshot(projectRoot)
    await rejectionOf(
      commitTransaction(ops, { io: faultyIo(2, { dieAfterFailure: true }), projectRoot }),
    )
    const { root: moved, cleanup: cleanMoved } = await tempProject()
    try {
      for (const [path, content] of Object.entries(await snapshot(projectRoot))) {
        await nodeIo.writeText(join(moved, path), content)
      }
      expect(await recoverTransactions({ io: nodeIo, projectRoot: moved })).toBe(1)
      expect(await snapshot(moved)).toEqual(before)
    } finally {
      await cleanMoved()
    }
  })

  test('an unreadable journal is reported, never guessed at', async () => {
    await nodeIo.writeText(join(stagingDir(projectRoot), 'tx1', 'journal.json'), '{"version":2}')
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as DevkitError).code).toBe('INTERRUPTED_TRANSACTION')
    expect((error as Error).message).toMatch(/unreadable/)
  })

  test('a journal pointing outside the project is refused', async () => {
    await nodeIo.writeText(
      join(stagingDir(projectRoot), 'tx1', 'journal.json'),
      JSON.stringify({ version: 1, entries: [{ index: 0, path: '../x', hadOriginal: false }] }),
    )
    const error = await rejectionOf(recoverTransactions({ io: nodeIo, projectRoot }))
    expect((error as DevkitError).code).toBe('PATH_OUTSIDE_PROJECT')
  })

  test('a missing backup during recovery is an error, not silent data loss', async () => {
    await nodeIo.writeText(
      join(stagingDir(projectRoot), 'tx1', 'journal.json'),
      JSON.stringify({ version: 1, entries: [{ index: 0, path: 'a.txt', hadOriginal: true }] }),
    )
    await expect(recoverTransactions({ io: nodeIo, projectRoot })).rejects.toThrow(/backup missing/)
  })

  test('leftover empty staging folders are cleaned up', async () => {
    await nodeIo.writeText(join(stagingDir(projectRoot), 'junk', 'staged', '0'), 'x')
    expect(await recoverTransactions({ io: nodeIo, projectRoot })).toBe(0)
    expect(await nodeIo.exists(stagingDir(projectRoot))).toBe(false)
  })
})
