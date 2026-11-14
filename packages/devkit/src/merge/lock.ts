/**
 * Upgrade state: the smallest amount of information needed to three-way merge ejected files.
 *
 *   .strutvane/lock.json          which files were ejected from which template version
 *   .strutvane/base/<path>        the pristine template output at that version (the merge base)
 *
 * Design rules (ADR-0012):
 * - The lock is validated with a schema on every read. Anything invalid is treated as corrupt:
 *   backed up, never silently trusted.
 * - Every base copy is verified against the SHA-256 recorded in the lock. A missing or altered
 *   base downgrades that file to a two-way merge instead of producing a wrong three-way merge.
 *
 * @module
 */
import { z } from 'zod'
import { type DevkitIo, sha256 } from '../io.ts'
import { resolveInsideProject } from '../paths.ts'
import { STATE_DIR } from '../transaction.ts'

/** One ejected file in the lock. */
export interface LockEntry {
  /** Template id, e.g. `framework/controller`. */
  readonly template: string
  /** Template version that produced the base, e.g. `1.2.0`. */
  readonly templateVersion: string
  /** SHA-256 (hex) of `.strutvane/base/<path>`. */
  readonly baseSha256: string
  /** `active` normally; `deleted-by-user` once the user deleted the file (never recreated). */
  readonly status: 'active' | 'deleted-by-user'
  /** True after an upgrade left conflict markers the user has not resolved yet. */
  readonly conflicted: boolean
}

/** The lock file. */
export interface LockFile {
  readonly lockfileVersion: 1
  readonly files: Readonly<Record<string, LockEntry>>
}

const RelativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !/^[a-zA-Z]:/.test(p) &&
      !p.split('/').includes('..') &&
      !p.includes('\\'),
    { message: 'must be a relative POSIX path inside the project' },
  )

const LockFileSchema: z.ZodType<LockFile> = z.object({
  lockfileVersion: z.literal(1),
  files: z.record(
    RelativePath,
    z.object({
      template: z.string().min(1),
      templateVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
      baseSha256: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(['active', 'deleted-by-user']).default('active'),
      conflicted: z.boolean().default(false),
    }),
  ),
})

/** Project-relative path of the lock file. */
export const LOCK_PATH: string = `${STATE_DIR}/lock.json`

/** Project-relative path of a file's merge base. */
export function basePathOf(file: string): string {
  return `${STATE_DIR}/base/${file}`
}

/** The result of reading the lock. */
export type LockReadResult =
  | { readonly status: 'ok'; readonly lock: LockFile }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt'; readonly reason: string; readonly backupPath: string }

/** Read and validate the lock. A corrupt lock is copied aside (never deleted) and reported. */
export async function readLock(io: DevkitIo, projectRoot: string): Promise<LockReadResult> {
  const path = resolveInsideProject(projectRoot, LOCK_PATH)
  const raw = await io.readText(path)
  if (raw === undefined) return { status: 'missing' }
  let reason: string
  try {
    const parsed = LockFileSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return { status: 'ok', lock: parsed.data }
    reason = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
  } catch (error) {
    reason = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
  }
  const backupPath = `${LOCK_PATH}.corrupt-${Date.now()}`
  await io.writeText(resolveInsideProject(projectRoot, backupPath), raw)
  return { status: 'corrupt', reason, backupPath }
}

/** Serialise a lock deterministically (sorted keys), so diffs in version control stay small. */
export function serializeLock(lock: LockFile): string {
  const files = Object.fromEntries(
    Object.entries(lock.files).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  )
  return `${JSON.stringify({ lockfileVersion: lock.lockfileVersion, files }, null, 2)}\n`
}

/** The result of reading a merge base. */
export type BaseReadResult =
  | { readonly status: 'ok'; readonly content: string }
  | { readonly status: 'missing' }
  | { readonly status: 'mismatch'; readonly expected: string; readonly actual: string }

/** Read a base copy and verify it against the lock's hash. */
export async function readBase(
  io: DevkitIo,
  projectRoot: string,
  file: string,
  entry: LockEntry,
): Promise<BaseReadResult> {
  const content = await io.readText(resolveInsideProject(projectRoot, basePathOf(file)))
  if (content === undefined) return { status: 'missing' }
  const actual = sha256(content)
  return actual === entry.baseSha256
    ? { status: 'ok', content }
    : { status: 'mismatch', expected: entry.baseSha256, actual }
}
