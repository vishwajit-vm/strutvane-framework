/**
 * Multi-file transactions: either every file operation is applied, or none is.
 *
 * Protocol (proven in spike 06, ADR-0012):
 *   1. **Stage.** Write every new content and a backup of every original into
 *      `.strutvane/staging/<tx>/`, plus a `journal.json`. Nothing in the project changes yet.
 *   2. **Commit.** Rename each staged file over its target (atomic per file on the same volume),
 *      or delete it.
 *   3. **On failure,** restore the already-committed targets from their backups (rollback).
 *   4. **If the process dies mid-commit,** the journal survives. `recoverTransactions()` restores
 *      the pre-transaction state on the next run, and new transactions refuse to start until it
 *      has.
 *
 * Journal paths are project-relative, so recovery still works if the project folder was moved.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { DevkitError, describeError, TransactionAbortedError } from './errors.ts'
import type { DevkitIo } from './io.ts'
import { resolveInsideProject } from './paths.ts'

/** Folder for devkit state inside a project. */
export const STATE_DIR = '.strutvane'

/** One file operation. `content: null` deletes the file. `path` is project-relative POSIX. */
export interface FileOperation {
  readonly path: string
  readonly content: string | null
}

/** Where staged transactions live. */
export function stagingDir(projectRoot: string): string {
  return join(projectRoot, STATE_DIR, 'staging')
}

interface JournalEntry {
  readonly index: number
  readonly path: string
  readonly hadOriginal: boolean
}

interface Journal {
  readonly version: 1
  readonly entries: readonly JournalEntry[]
}

const JournalSchema: z.ZodType<Journal> = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      path: z.string().min(1),
      hadOriginal: z.boolean(),
    }),
  ),
})

/** True if an earlier transaction was interrupted and must be recovered first. */
export async function hasInterruptedTransaction(
  io: DevkitIo,
  projectRoot: string,
): Promise<boolean> {
  return (await io.listFiles(stagingDir(projectRoot), [])).some((f) => f.endsWith('journal.json'))
}

/**
 * Apply `operations` as one transaction. Throws {@link TransactionAbortedError} on failure, after
 * rolling back. If rollback itself fails, the journal is kept for {@link recoverTransactions}.
 */
export async function commitTransaction(
  operations: readonly FileOperation[],
  options: { readonly io: DevkitIo; readonly projectRoot: string },
): Promise<void> {
  const { io, projectRoot } = options
  if (operations.length === 0) return
  if (await hasInterruptedTransaction(io, projectRoot)) {
    throw new DevkitError(
      'INTERRUPTED_TRANSACTION',
      'a previous change was interrupted; run recovery first (sv recover), then retry',
    )
  }
  const seen = new Set<string>()
  for (const op of operations) {
    if (seen.has(op.path)) {
      throw new DevkitError(
        'INVALID_PATH',
        `the same file appears twice in one transaction: ${op.path}`,
      )
    }
    seen.add(op.path)
  }
  const targets = operations.map((op) => resolveInsideProject(projectRoot, op.path))
  const tx = join(stagingDir(projectRoot), `${Date.now()}-${randomBytes(4).toString('hex')}`)
  const entries: JournalEntry[] = []

  // 1. Stage new contents and back up originals. Nothing in the project changes yet.
  try {
    for (const [index, op] of operations.entries()) {
      const target = targets[index] as string
      if (op.content !== null) await io.writeText(join(tx, 'staged', String(index)), op.content)
      const original = await io.readText(target)
      if (original !== undefined) await io.writeText(join(tx, 'backup', String(index)), original)
      entries.push({ index, path: op.path, hadOriginal: original !== undefined })
    }
    await io.writeText(join(tx, 'journal.json'), JSON.stringify({ version: 1, entries }))
  } catch (error) {
    await io.remove(tx)
    await removeIfEmpty(io, stagingDir(projectRoot))
    throw new TransactionAbortedError(
      `could not prepare the change (nothing was modified): ${describeError(error)}`,
      true,
      { cause: error },
    )
  }

  // 2. Commit.
  let committed = 0
  try {
    for (const [index, op] of operations.entries()) {
      const target = targets[index] as string
      if (op.content === null) await io.remove(target)
      else await io.rename(join(tx, 'staged', String(index)), target)
      committed++
    }
  } catch (error) {
    try {
      await restore(io, projectRoot, tx, entries.slice(0, committed))
      await io.remove(tx)
      await removeIfEmpty(io, stagingDir(projectRoot))
    } catch (rollbackError) {
      throw new TransactionAbortedError(
        'the change failed and automatic rollback also failed; run recovery (sv recover)',
        false,
        { cause: rollbackError },
      )
    }
    throw new TransactionAbortedError(
      `the change failed and was rolled back: ${describeError(error)}`,
      true,
      { cause: error },
    )
  }

  // 3. Done: drop the staging area.
  await io.remove(tx)
  await removeIfEmpty(io, stagingDir(projectRoot))
}

/**
 * Restore the pre-transaction state of every interrupted transaction (idempotent).
 * Returns how many transactions were rolled back.
 */
export async function recoverTransactions(options: {
  readonly io: DevkitIo
  readonly projectRoot: string
}): Promise<number> {
  const { io, projectRoot } = options
  const staging = stagingDir(projectRoot)
  const journals = (await io.listFiles(staging, [])).filter((f) => f.endsWith('/journal.json'))
  for (const j of journals) {
    const tx = join(staging, j.slice(0, -'/journal.json'.length))
    const raw = await io.readText(join(staging, j))
    let journal: Journal
    try {
      journal = JournalSchema.parse(JSON.parse(raw ?? 'null'))
    } catch (error) {
      throw new DevkitError(
        'INTERRUPTED_TRANSACTION',
        `journal ${j} is unreadable; inspect ${staging} manually: ${describeError(error)}`,
        { cause: error },
      )
    }
    await restore(io, projectRoot, tx, journal.entries)
    await io.remove(tx)
  }
  if (journals.length > 0 || (await io.exists(staging))) await io.remove(staging)
  return journals.length
}

/** Put every listed target back to its backed-up state (or remove it if it did not exist). */
async function restore(
  io: DevkitIo,
  projectRoot: string,
  tx: string,
  entries: readonly JournalEntry[],
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    const target = resolveInsideProject(projectRoot, entry.path)
    if (entry.hadOriginal) {
      const backup = await io.readText(join(tx, 'backup', String(entry.index)))
      if (backup === undefined) throw new Error(`backup missing for ${entry.path}`)
      await io.writeText(target, backup)
    } else {
      await io.remove(target)
    }
  }
}

async function removeIfEmpty(io: DevkitIo, dir: string): Promise<void> {
  if ((await io.exists(dir)) && (await io.listFiles(dir, [])).length === 0) await io.remove(dir)
}
