/**
 * `sv upgrade` for ejected files: plan → preview → apply (transactional) → recover.
 *
 * For every file the new template version produces, the planner decides one action:
 *
 *   unchanged          nothing to do (template unchanged, or its change is already in the file)
 *   update             clean merge: apply
 *   conflict           merge with conflict markers: apply, mark conflicted in the lock, report
 *   create             the new template version adds a file the project doesn't have yet
 *   skip-user-deleted  the user deleted the file: never recreate it (remembered in the lock)
 *   blocked            unsafe to touch (unresolved markers, ambiguous move, someone else's file)
 *
 * Applying uses the shared transaction engine: every file, every new merge base and the lock are
 * committed together or not at all. After applying, callers must run the project's typecheck and
 * tests, because line merges can't see semantic conflicts such as a renamed identifier (ADR-0012).
 *
 * @module
 */
import { createTwoFilesPatch } from 'diff'
import { type DevkitIo, nodeIo, sha256 } from '../io.ts'
import { resolveInsideProject } from '../paths.ts'
import { commitTransaction, type FileOperation, STATE_DIR } from '../transaction.ts'
import { type Formatter, tryFormat } from './format.ts'
import { parseHeader } from './header.ts'
import {
  basePathOf,
  LOCK_PATH,
  type LockEntry,
  type LockFile,
  type LockReadResult,
  readBase,
  readLock,
  serializeLock,
} from './lock.ts'
import {
  type Conflict,
  hasConflictMarkers,
  type MergeResult,
  mergeThreeWay,
  mergeTwoWay,
} from './merge.ts'

/** One file produced by the NEW template version. */
export interface TemplateOutput {
  /** Project-relative POSIX path where the template writes this file. */
  readonly path: string
  readonly template: string
  readonly version: string
  readonly content: string
}

/** What the planner decided for one file. */
export type PlanAction =
  | 'unchanged'
  | 'update'
  | 'conflict'
  | 'create'
  | 'skip-user-deleted'
  | 'blocked'

/** One planned file. */
export interface PlanItem {
  /** The lock key (where the template originally wrote the file). */
  readonly lockKey: string
  /** Where the file is now (differs from `lockKey` if the user moved it). */
  readonly path: string
  readonly renamedFrom?: string
  readonly action: PlanAction
  readonly mode: 'three-way' | 'two-way' | 'none'
  readonly template: string
  readonly version: string
  /** Current file content (undefined if the file does not exist). */
  readonly before?: string
  /** Content after the upgrade (undefined when the file is not written). */
  readonly after?: string
  /** The raw new template output: becomes the next merge base. */
  readonly newBase: string
  readonly conflicts: readonly Conflict[]
  readonly notes: readonly string[]
}

/** A complete upgrade plan. */
export interface UpgradePlan {
  readonly lockStatus: LockReadResult['status']
  readonly items: readonly PlanItem[]
  readonly notes: readonly string[]
}

/** Options for {@link planUpgrade}. */
export interface PlanUpgradeOptions {
  readonly projectRoot: string
  readonly templates: readonly TemplateOutput[]
  readonly io?: DevkitIo
  /** The user's formatter. Applied to base + theirs only when the user's file is already formatted. */
  readonly formatter?: Formatter
  readonly ignoreTrailingWhitespace?: boolean
}

const SCAN_IGNORE = ['node_modules', '.git', STATE_DIR, 'dist', 'build', 'coverage']

/** Decide what the upgrade would do for every template output. Reads only, except that a corrupt lock is backed up. */
export async function planUpgrade(options: PlanUpgradeOptions): Promise<UpgradePlan> {
  const io = options.io ?? nodeIo
  const { projectRoot, templates } = options
  const lockRead = await readLock(io, projectRoot)
  const lock: LockFile =
    lockRead.status === 'ok' ? lockRead.lock : { lockfileVersion: 1, files: {} }
  const notes: string[] = []
  if (lockRead.status === 'missing') {
    notes.push(
      'no .strutvane/lock.json: files with a Strutvane header are merged two-way (every difference is a conflict)',
    )
  }
  if (lockRead.status === 'corrupt') {
    notes.push(
      `lock was corrupt (${lockRead.reason}); a copy was saved to ${lockRead.backupPath}; falling back to two-way merges`,
    )
  }

  const tracked = new Set(Object.keys(lock.files))
  let projectFiles: string[] | undefined
  const listProject = async () => {
    projectFiles ??= await io.listFiles(projectRoot, SCAN_IGNORE)
    return projectFiles
  }
  const items: PlanItem[] = []
  for (const t of templates) {
    items.push(await planOne(t, lock.files[t.path], { ...options, io, tracked, listProject }))
  }
  return { lockStatus: lockRead.status, items, notes }
}

interface PlanContext extends PlanUpgradeOptions {
  readonly io: DevkitIo
  readonly tracked: ReadonlySet<string>
  readonly listProject: () => Promise<string[]>
}

async function planOne(
  t: TemplateOutput,
  entry: LockEntry | undefined,
  ctx: PlanContext,
): Promise<PlanItem> {
  const { io, projectRoot } = ctx
  const read = (path: string) => io.readText(resolveInsideProject(projectRoot, path))
  const common = { lockKey: t.path, template: t.template, version: t.version, newBase: t.content }
  const notes: string[] = []

  if (entry?.status === 'deleted-by-user') {
    return {
      ...common,
      path: t.path,
      action: 'skip-user-deleted',
      mode: 'none',
      conflicts: [],
      notes: ['you deleted this file earlier; it will not be recreated'],
    }
  }

  let path = t.path
  let renamedFrom: string | undefined
  let current = await read(t.path)

  if (current === undefined) {
    if (entry === undefined) {
      return {
        ...common,
        path,
        action: 'create',
        mode: 'none',
        after: t.content,
        conflicts: [],
        notes: ['new file in this template version'],
      }
    }
    // The user moved/renamed or deleted the file. Look for its header elsewhere.
    const candidates: string[] = []
    for (const file of await ctx.listProject()) {
      if (ctx.tracked.has(file)) continue
      const text = await read(file)
      if (text !== undefined && parseHeader(text)?.template === entry.template)
        candidates.push(file)
    }
    if (candidates.length > 1) {
      return {
        ...common,
        path,
        action: 'blocked',
        mode: 'none',
        conflicts: [],
        notes: [
          `file is missing and ${candidates.length} files claim to be ${entry.template}: ${candidates.join(', ')}; move all but one or delete the extra header`,
        ],
      }
    }
    const found = candidates[0]
    if (found === undefined) {
      return {
        ...common,
        path,
        action: 'skip-user-deleted',
        mode: 'none',
        conflicts: [],
        notes: ['file not found: treated as deleted by you; it will not be recreated'],
      }
    }
    renamedFrom = t.path
    path = found
    current = await read(found)
    notes.push(`you moved this file to ${found}; merging there`)
  }
  if (current === undefined) throw new Error(`unreachable: ${path} vanished during planning`)
  const moved = renamedFrom === undefined ? {} : { renamedFrom }

  if (hasConflictMarkers(current)) {
    return {
      ...common,
      path,
      ...moved,
      action: 'blocked',
      mode: 'none',
      before: current,
      conflicts: [],
      notes: [
        'file still contains conflict markers from a previous upgrade; resolve them, then re-run',
      ],
    }
  }
  if (entry === undefined && parseHeader(current)?.template !== t.template) {
    return {
      ...common,
      path,
      action: 'blocked',
      mode: 'none',
      before: current,
      conflicts: [],
      notes: [
        'a file you created already exists at this path and was not generated by this template; move it, then re-run',
      ],
    }
  }

  // Resolve the merge base.
  let base: string | undefined
  if (entry !== undefined) {
    const b = await readBase(io, projectRoot, t.path, entry)
    if (b.status === 'ok') base = b.content
    else {
      notes.push(
        b.status === 'missing'
          ? 'merge base missing (.strutvane/base): falling back to two-way merge'
          : 'merge base was modified (hash mismatch): falling back to two-way merge',
      )
    }
  }

  // Optional formatter step: only when the user's file is already in the formatter's style.
  let theirs = t.content
  if (ctx.formatter !== undefined && base !== undefined) {
    const oursFmt = await tryFormat(ctx.formatter, current, path)
    if (oursFmt.formatted && oursFmt.text === current) {
      const [bf, tf] = await Promise.all([
        tryFormat(ctx.formatter, base, path),
        tryFormat(ctx.formatter, theirs, path),
      ])
      base = bf.text
      theirs = tf.text
      for (const n of [bf.note, tf.note]) if (n !== undefined) notes.push(n)
    } else if (oursFmt.note !== undefined) notes.push(oursFmt.note)
  }

  const mergeOptions = {
    ...(ctx.ignoreTrailingWhitespace === undefined
      ? {}
      : { ignoreTrailingWhitespace: ctx.ignoreTrailingWhitespace }),
    labels: {
      ours: 'yours',
      base: `${t.template}@${entry?.templateVersion ?? '?'} (original)`,
      theirs: `${t.template}@${t.version} (new)`,
    },
  }
  const result: MergeResult =
    base !== undefined
      ? mergeThreeWay({ base, ours: current, theirs }, mergeOptions)
      : mergeTwoWay({ ours: current, theirs }, mergeOptions)
  notes.push(...result.notes)

  const action: PlanAction =
    result.status === 'conflicted' ? 'conflict' : result.text === current ? 'unchanged' : 'update'
  return {
    ...common,
    path,
    ...moved,
    action,
    mode: result.mode,
    before: current,
    ...(action === 'unchanged' ? {} : { after: result.text }),
    conflicts: result.conflicts,
    notes,
  }
}

/** Human-readable dry run: a summary line per file plus unified diffs. Writes nothing. */
export function renderUpgradePreview(plan: UpgradePlan): string {
  const out: string[] = [...plan.notes.map((n) => `note: ${n}`)]
  for (const item of plan.items) {
    const where = item.renamedFrom === undefined ? item.path : `${item.renamedFrom} → ${item.path}`
    const extra = item.conflicts.length > 0 ? `, ${item.conflicts.length} conflict(s)` : ''
    out.push(`${item.action.padEnd(17)} ${where} [${item.mode}${extra}]`)
    for (const n of item.notes) out.push(`    ${n}`)
    if (item.after !== undefined) {
      out.push(
        createTwoFilesPatch(
          item.path,
          item.path,
          item.before ?? '',
          item.after,
          'current',
          'after upgrade',
        ),
      )
    }
  }
  return out.join('\n')
}

/** What an applied upgrade changed. */
export interface ApplyUpgradeResult {
  readonly written: readonly string[]
  readonly conflicted: readonly string[]
}

/** Turn a plan into file operations plus the next lock (written last). */
function operationsFor(
  plan: UpgradePlan,
  lock: LockFile,
): { ops: FileOperation[]; written: string[]; conflicted: string[] } {
  const ops: FileOperation[] = []
  const written: string[] = []
  const conflicted: string[] = []
  const files: Record<string, LockEntry> = { ...lock.files }

  for (const item of plan.items) {
    if (item.action === 'blocked') continue
    if (item.after !== undefined) {
      ops.push({ path: item.path, content: item.after })
      written.push(item.path)
    }
    if (item.action === 'conflict') conflicted.push(item.path)
    // The new template output becomes the merge base, stored under the file's CURRENT path.
    if (item.renamedFrom !== undefined) {
      delete files[item.renamedFrom]
      ops.push({ path: basePathOf(item.renamedFrom), content: null })
    }
    ops.push({ path: basePathOf(item.path), content: item.newBase })
    files[item.path] = {
      template: item.template,
      templateVersion: item.version,
      baseSha256: sha256(item.newBase),
      status: item.action === 'skip-user-deleted' ? 'deleted-by-user' : 'active',
      conflicted: item.action === 'conflict',
    }
  }
  ops.push({ path: LOCK_PATH, content: serializeLock({ lockfileVersion: 1, files }) })
  return { ops, written, conflicted }
}

/**
 * Apply a plan as one transaction (files, merge bases and lock together). On failure everything is
 * rolled back; if the process dies, `recoverTransactions()` restores the previous state.
 */
export async function applyUpgrade(options: {
  readonly projectRoot: string
  readonly plan: UpgradePlan
  readonly io?: DevkitIo
}): Promise<ApplyUpgradeResult> {
  const io = options.io ?? nodeIo
  const lockRead = await readLock(io, options.projectRoot)
  const lock: LockFile =
    lockRead.status === 'ok' ? lockRead.lock : { lockfileVersion: 1, files: {} }
  const { ops, written, conflicted } = operationsFor(options.plan, lock)
  await commitTransaction(ops, { io, projectRoot: options.projectRoot })
  return { written, conflicted }
}

/**
 * Record files a generator just ejected, so a later upgrade can three-way merge them: writes each
 * file, its merge base and the lock in one transaction. Existing lock entries are kept.
 */
export async function recordEjection(options: {
  readonly projectRoot: string
  readonly outputs: readonly TemplateOutput[]
  readonly io?: DevkitIo
}): Promise<void> {
  const io = options.io ?? nodeIo
  const lockRead = await readLock(io, options.projectRoot)
  const files: Record<string, LockEntry> =
    lockRead.status === 'ok' ? { ...lockRead.lock.files } : {}
  const ops: FileOperation[] = []
  for (const o of options.outputs) {
    ops.push({ path: o.path, content: o.content }, { path: basePathOf(o.path), content: o.content })
    files[o.path] = {
      template: o.template,
      templateVersion: o.version,
      baseSha256: sha256(o.content),
      status: 'active',
      conflicted: false,
    }
  }
  ops.push({ path: LOCK_PATH, content: serializeLock({ lockfileVersion: 1, files }) })
  await commitTransaction(ops, { io, projectRoot: options.projectRoot })
}
