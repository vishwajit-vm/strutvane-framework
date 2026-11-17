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
 * Hardening (each covered by tests):
 * - **Permissions.** A replaced file keeps its permission bits (a `0600` `.env` stays `0600`); a
 *   new secret env file is created `0600`. Backups and journals are `0600` and every staging
 *   folder devkit creates is `0700`, because backups hold plaintext copies of files like `.env`.
 * - **No links in the staging area.** `.strutvane` and `.strutvane/staging` must be real folders,
 *   never symlinks or junctions, so staged secrets cannot be redirected elsewhere.
 * - **Recovery trusts nothing on disk.** A journal is data that anyone with write access to the
 *   project could have planted. Recovery refuses journals owned by another user (POSIX), journal
 *   paths that leave the project or touch protected locations (`.git/`, `node_modules/`, and
 *   anything under `.strutvane/` except the upgrade lock and merge bases; see `paths.ts`),
 *   backups that are not regular files, and targets that
 *   are directories or special files. It only ever replaces or unlinks single regular files:
 *   it never deletes recursively and never writes through a symlink. Every check runs before
 *   anything changes, and {@link planRecovery} shows the affected paths first.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { DevkitError, describeError, TransactionAbortedError } from './errors.ts'
import type { DevkitIo, WriteTextOptions } from './io.ts'
import { normaliseRelativePath, recoveryRefusal, resolveInsideProject } from './paths.ts'
import { isSecretEnvFile } from './secret-files.ts'

/** Folder for devkit state inside a project. */
export const STATE_DIR = '.strutvane'

/** Permission bits for staged backups, journals and new secret env files: owner only. */
const PRIVATE_FILE = 0o600
/** Permission bits for staging folders devkit creates: owner only. */
const PRIVATE_DIR = 0o700

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
  /** Permission bits of the original file, restored with it. Absent in older journals. */
  readonly mode?: number | undefined
}

interface Journal {
  readonly version: 1
  readonly entries: readonly JournalEntry[]
}

const JournalSchema: z.ZodType<Journal> = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        path: z.string().min(1),
        hadOriginal: z.boolean(),
        mode: z.number().int().min(0).max(0o7777).optional(),
      }),
    ),
  })
  .refine(
    (j) =>
      new Set(j.entries.map((e) => e.index)).size === j.entries.length &&
      new Set(j.entries.map((e) => e.path)).size === j.entries.length,
    { message: 'journal entries must have unique indexes and paths' },
  )

/** `<tx>/journal.json`, directly inside the staging folder (the only layout devkit writes). */
const JOURNAL = /^([^/]+)\/journal\.json$/

/** One thing recovery would do to a project file. */
export interface RecoveryStep {
  /** Project-relative POSIX path. */
  readonly path: string
  /** `restore`: put the backed-up original back. `delete`: remove a file the change created. */
  readonly action: 'restore' | 'delete'
}

/** One interrupted transaction and what recovering it would do (in order). */
export interface RecoveryTransaction {
  /** The staging folder name (`.strutvane/staging/<id>`). */
  readonly id: string
  readonly steps: readonly RecoveryStep[]
}

/** What {@link recoverTransactions} would do, computed without changing anything. */
export interface RecoveryPlan {
  readonly transactions: readonly RecoveryTransaction[]
  /** Every project path recovery would write or delete: sorted, without duplicates. */
  readonly paths: readonly string[]
}

/** True if an earlier transaction was interrupted and must be recovered first. */
export async function hasInterruptedTransaction(
  io: DevkitIo,
  projectRoot: string,
): Promise<boolean> {
  return (await io.listFiles(stagingDir(projectRoot), [])).some((f) => JOURNAL.test(f))
}

/**
 * Refuse a staging area reached through a link: `.strutvane` and `.strutvane/staging` must be
 * real folders (or not exist yet). A symlink or junction there would send plaintext backups,
 * or recovery's reads, somewhere outside devkit's control.
 */
async function assertSafeStateDirs(io: DevkitIo, projectRoot: string): Promise<void> {
  for (const rel of [STATE_DIR, `${STATE_DIR}/staging`]) {
    const info = await io.inspect(join(projectRoot, ...rel.split('/')))
    if (info !== undefined && info.kind !== 'directory') {
      throw new DevkitError(
        'path_outside_project',
        `${rel} is a ${info.kind}, not a folder; devkit refuses to stage changes through it (remove it and retry)`,
      )
    }
  }
}

/** Options for a staged file: `mode` only when known, plus private parent folders. */
function stagedFileOptions(mode: number | undefined): WriteTextOptions {
  return mode === undefined ? { dirMode: PRIVATE_DIR } : { mode, dirMode: PRIVATE_DIR }
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
  await assertSafeStateDirs(io, projectRoot)
  if (await hasInterruptedTransaction(io, projectRoot)) {
    throw new DevkitError(
      'interrupted_transaction',
      'a previous change was interrupted; run recovery first (node strut recover), then retry',
    )
  }
  const seen = new Set<string>()
  for (const op of operations) {
    if (seen.has(op.path)) {
      throw new DevkitError(
        'invalid_path',
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
      const info = await io.inspect(target)
      // Keep the original's permission bits; a new secret env file is private from the start.
      const originalMode = info?.kind === 'file' ? info.mode & 0o777 : undefined
      const mode = originalMode ?? (isSecretEnvFile(op.path) ? PRIVATE_FILE : undefined)
      if (op.content !== null) {
        await io.writeText(join(tx, 'staged', String(index)), op.content, stagedFileOptions(mode))
      }
      const original = await io.readText(target)
      if (original !== undefined) {
        await io.writeText(
          join(tx, 'backup', String(index)),
          original,
          stagedFileOptions(PRIVATE_FILE),
        )
      }
      entries.push({
        index,
        path: op.path,
        hadOriginal: original !== undefined,
        ...(original !== undefined && originalMode !== undefined ? { mode: originalMode } : {}),
      })
    }
    await io.writeText(
      join(tx, 'journal.json'),
      JSON.stringify({ version: 1, entries }),
      stagedFileOptions(PRIVATE_FILE),
    )
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
      if (op.content === null) await io.removeFile(target)
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
        'the change failed and automatic rollback also failed; run recovery (node strut recover)',
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

  // 3. Done. Deleting the journal is the commit point: once it is gone, recovery has nothing to
  // undo. It goes first, so a failure to delete the rest of the staging folder (Windows refuses
  // while a scanner or indexer holds a file) can never make recovery roll back applied changes.
  await io.removeFile(join(tx, 'journal.json'))
  try {
    await io.remove(tx)
    await removeIfEmpty(io, stagingDir(projectRoot))
  } catch {
    // The change is applied and complete. The leftover folder holds no journal, so it blocks
    // nothing; the next recovery (`node strut recover`) removes it with the rest of the staging area.
  }
}

/** A validated interrupted transaction, ready to restore. */
interface LoadedTransaction {
  readonly id: string
  readonly dir: string
  readonly entries: readonly JournalEntry[]
}

function refuse(message: string, cause?: unknown): DevkitError {
  return new DevkitError(
    'interrupted_transaction',
    message,
    cause === undefined ? undefined : { cause },
  )
}

/** Read and validate every interrupted transaction. Changes nothing; throws on anything unsafe. */
async function loadInterrupted(io: DevkitIo, projectRoot: string): Promise<LoadedTransaction[]> {
  await assertSafeStateDirs(io, projectRoot)
  const staging = stagingDir(projectRoot)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const loaded: LoadedTransaction[] = []
  for (const file of await io.listFiles(staging, [])) {
    const id = JOURNAL.exec(file)?.[1]
    if (id === undefined) continue
    const dir = join(staging, id)
    const journalPath = join(dir, 'journal.json')
    const info = await io.inspect(journalPath)
    if (info?.kind !== 'file')
      throw refuse(`journal ${file} is not a regular file; inspect ${staging} manually`)
    if (uid !== undefined && info.uid !== uid) {
      throw refuse(
        `journal ${file} is owned by another user (uid ${info.uid}); refusing to recover from it. Inspect ${staging} manually`,
      )
    }
    let journal: Journal
    try {
      journal = JournalSchema.parse(JSON.parse((await io.readText(journalPath)) ?? 'null'))
    } catch (error) {
      throw refuse(
        `journal ${file} is unreadable; inspect ${staging} manually: ${describeError(error)}`,
        error,
      )
    }
    for (const entry of journal.entries) {
      // Throws path_outside_project / invalid_path for escapes and protected locations.
      const target = resolveInsideProject(projectRoot, entry.path)
      const refusal = recoveryRefusal(normaliseRelativePath(entry.path))
      if (refusal !== undefined) throw new DevkitError('invalid_path', `${refusal}: ${entry.path}`)
      const current = await io.inspect(target)
      if (entry.hadOriginal) {
        const backup = await io.inspect(join(dir, 'backup', String(entry.index)))
        if (backup === undefined) throw refuse(`backup missing for ${entry.path} in ${file}`)
        if (backup.kind !== 'file') {
          throw refuse(`backup for ${entry.path} in ${file} is a ${backup.kind}, not a file`)
        }
        // Renaming over a symlink replaces the link itself, so it is safe to restore over one.
        if (current !== undefined && current.kind !== 'file' && current.kind !== 'symlink') {
          throw refuse(
            `cannot restore ${entry.path}: it is now a ${current.kind}; recovery only replaces files`,
          )
        }
      } else if (current !== undefined && current.kind !== 'file') {
        throw refuse(
          `cannot delete ${entry.path}: it is a ${current.kind}; recovery only deletes regular files`,
        )
      }
    }
    loaded.push({ id, dir, entries: journal.entries })
  }
  return loaded
}

function planOf(loaded: readonly LoadedTransaction[]): RecoveryPlan {
  const transactions = loaded.map((t) => ({
    id: t.id,
    steps: [...t.entries]
      .reverse()
      .map((e): RecoveryStep => ({ path: e.path, action: e.hadOriginal ? 'restore' : 'delete' })),
  }))
  const paths = [...new Set(transactions.flatMap((t) => t.steps.map((s) => s.path)))].sort()
  return { transactions, paths }
}

/**
 * Describe what {@link recoverTransactions} would do, without changing anything. Runs every
 * safety check recovery runs, so it throws for the same unsafe journals. Show `paths` to the user
 * and pass the plan back as `confirmed` to recover exactly what they approved.
 */
export async function planRecovery(options: {
  readonly io: DevkitIo
  readonly projectRoot: string
}): Promise<RecoveryPlan> {
  return planOf(await loadInterrupted(options.io, options.projectRoot))
}

/**
 * Restore the pre-transaction state of every interrupted transaction (idempotent).
 * Returns how many transactions were rolled back.
 *
 * Every journal is validated first (see the module documentation); if any is unsafe, nothing is
 * changed and an `interrupted_transaction`, `invalid_path` or `path_outside_project` error says
 * why. With `confirmed` (a plan from {@link planRecovery}), recovery also refuses to run if the
 * journals no longer describe exactly that plan.
 */
export async function recoverTransactions(options: {
  readonly io: DevkitIo
  readonly projectRoot: string
  readonly confirmed?: RecoveryPlan
}): Promise<number> {
  const { io, projectRoot } = options
  const staging = stagingDir(projectRoot)
  const loaded = await loadInterrupted(io, projectRoot)
  if (
    options.confirmed !== undefined &&
    JSON.stringify(planOf(loaded)) !== JSON.stringify(canonicalPlan(options.confirmed))
  ) {
    throw refuse('the interrupted changes differ from the confirmed recovery plan; plan again')
  }
  for (const t of loaded) {
    await restore(io, projectRoot, t.dir, t.entries)
    await io.remove(t.dir)
  }
  if (loaded.length > 0 || (await io.exists(staging))) await io.remove(staging)
  return loaded.length
}

/** Canonical form of a caller-supplied plan, so key order cannot cause a false mismatch. */
function canonicalPlan(plan: RecoveryPlan): RecoveryPlan {
  return {
    transactions: plan.transactions.map((t) => ({
      id: t.id,
      steps: t.steps.map((s) => ({ path: s.path, action: s.action })),
    })),
    paths: [...plan.paths],
  }
}

/**
 * Put every listed target back to its backed-up state, or delete it if it did not exist.
 *
 * A restore writes the backup to `<tx>/restore/<n>` and renames it over the target: atomic, never
 * follows a symlink at the target, and leaves the backup in place so a crash here can simply be
 * recovered again. A delete unlinks one regular file and nothing else.
 */
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
      if (backup === undefined) throw refuse(`backup missing for ${entry.path}`)
      const mode =
        entry.mode === undefined
          ? isSecretEnvFile(entry.path)
            ? PRIVATE_FILE
            : undefined
          : entry.mode & 0o777 // never restore setuid/setgid/sticky bits from a journal
      const temp = join(tx, 'restore', String(entry.index))
      await io.writeText(temp, backup, stagedFileOptions(mode))
      await io.rename(temp, target)
    } else {
      await io.removeFile(target)
    }
  }
}

async function removeIfEmpty(io: DevkitIo, dir: string): Promise<void> {
  if ((await io.exists(dir)) && (await io.listFiles(dir, [])).length === 0) await io.remove(dir)
}
