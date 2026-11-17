/**
 * Atomic file writes: write a temporary file in the same folder, then rename it over the target.
 * A reader (another process serving the app, or the next boot) sees the old file or the new one,
 * never half of each.
 *
 * Why the retry: on Windows a rename over a file that an antivirus scanner, the search indexer or
 * an editor has just opened fails with EPERM/EBUSY/EACCES for a few milliseconds. Spikes 14 and 16
 * both hit it in their test suites. A short backoff rides it out; a real permission problem still
 * throws after the last attempt, and the temporary file is always removed.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const TRANSIENT: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const ATTEMPTS = 8
const BACKOFF_MS = 15

/**
 * Write `content` to `target` atomically, creating the folder if needed.
 *
 * @example
 * writeFileAtomic('/srv/app/storage/framework/down', JSON.stringify(state))
 * writeFileAtomic('/srv/app/.env', text, { mode: 0o600 })
 */
export function writeFileAtomic(
  target: string,
  content: string | Uint8Array,
  options: { readonly mode?: number } = {},
): void {
  mkdirSync(dirname(target), { recursive: true })
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(temporary, content, { mode: options.mode ?? 0o644, flag: 'wx' })
    retryTransient(() => renameSync(temporary, target))
  } finally {
    // After a successful rename the temporary file is gone; after a failure it must not linger.
    rmSync(temporary, { force: true })
  }
}

/**
 * Delete a file if it exists, with the same Windows retry. Returns `true` when a file was removed.
 *
 * @example
 * removeFile('/srv/app/storage/framework/down') // true
 */
export function removeFile(target: string): boolean {
  let removed = false
  retryTransient(() => {
    try {
      rmSync(target)
      removed = true
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  })
  return removed
}

/**
 * Run `operation`, retrying briefly on Windows' transient sharing errors.
 *
 * @example
 * retryTransient(() => renameSync(from, to))
 */
export function retryTransient(operation: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      operation()
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (!TRANSIENT.has(code) || attempt >= ATTEMPTS) throw error
      // A synchronous pause: commands are synchronous here, and this only runs after a failure.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BACKOFF_MS * attempt)
    }
  }
}
