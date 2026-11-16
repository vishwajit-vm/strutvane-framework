/**
 * A per-key lock file shared by every process on one machine: what makes the file cache store's
 * `add` and `increment` atomic across processes (rate-limit counters from cluster workers).
 *
 * **How:** the lock is a file created with `O_CREAT | O_EXCL` (`'wx'`), which the operating system
 * guarantees only one process can create. The holder runs its (short, synchronous) read-modify-write
 * and deletes the file. Others retry with a short backoff.
 *
 * **Failure scenarios:**
 * - a holder crashes and leaves its lock: a lock older than `staleMs` is taken over (renamed away
 *   first, so only one waiter can take it);
 * - the lock can't be taken within `timeoutMs` (a stuck process, a full disk): the operation fails
 *   with the 503 `cache_unavailable` problem, and nothing was written;
 * - Windows reports a file that is being deleted as `EPERM`/`EACCES` instead of `EEXIST`: treated as
 *   "held", so the next attempt sees it gone.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { StrutvaneError } from '../core/errors/errors.ts'
import { removeFile } from '../support/atomic-write.ts'

/** Errors that mean "someone else holds the lock". */
const HELD: ReadonlySet<string> = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])

/**
 * Lock timings. Real wall-clock time: locks are about other processes, not the app's clock.
 *
 * @example
 * const options: FileLockOptions = { staleMs: 10_000, timeoutMs: 5_000 }
 */
export interface FileLockOptions {
  /** A lock older than this is assumed abandoned by a crashed process. Default 10 s. */
  readonly staleMs?: number
  /** Give up (503 `cache_unavailable`) after this long. Default 5 s. */
  readonly timeoutMs?: number
}

/**
 * Run `work` while holding the lock file at `path`; the lock is always released afterwards.
 *
 * @example
 * const next = await withFileLock('/srv/blog/storage/framework/cache/ab12.json.lock', () => bump())
 */
export async function withFileLock<TResult>(
  path: string,
  work: () => TResult,
  options: FileLockOptions = {},
): Promise<TResult> {
  const staleMs = options.staleMs ?? 10_000
  const timeoutMs = options.timeoutMs ?? 5_000
  mkdirSync(dirname(path), { recursive: true })
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    if (tryCreate(path)) break
    if (isStale(path, staleMs)) {
      takeOver(path)
      continue
    }
    if (Date.now() - started >= timeoutMs)
      throw new StrutvaneError('cache_unavailable', { status: 503 })
    await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 25)))
  }
  try {
    return work()
  } finally {
    removeFile(path)
  }
}

function tryCreate(path: string): boolean {
  try {
    closeSync(openSync(path, 'wx'))
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (HELD.has(code)) return false
    throw error
  }
}

function isStale(path: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs
  } catch {
    // Gone already: the next attempt will take it.
    return false
  }
}

/** Rename first: only one waiter's rename of the abandoned lock can succeed. */
function takeOver(path: string): void {
  const aside = `${path}.${randomBytes(6).toString('hex')}.stale`
  try {
    renameSync(path, aside)
  } catch {
    return
  }
  removeFile(aside)
}
