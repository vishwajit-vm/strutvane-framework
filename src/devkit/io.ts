/**
 * The minimal file-system surface devkit needs. It is injected (rather than importing `node:fs`
 * everywhere) so tests can simulate failures, such as a rename that fails halfway through a
 * commit, and prove that transactions roll back or recover.
 *
 * All paths are absolute. Text is always UTF-8.
 *
 * Permissions: `mode` values are POSIX permission bits. On Windows, `chmod` can only toggle the
 * read-only attribute, so modes are best-effort there; they never make an operation fail.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { DevkitError } from './errors.ts'

/** What a path is, without following a final symlink (an `lstat`). Junctions report `symlink`. */
export type PathKind = 'file' | 'directory' | 'symlink' | 'other'

/** The result of {@link DevkitIo.inspect}. */
export interface PathInfo {
  readonly kind: PathKind
  /** Permission bits (`mode & 0o7777`). */
  readonly mode: number
  /** Owner's user id (always `0` on Windows, where ownership is not checked). */
  readonly uid: number
}

/** Options for {@link DevkitIo.writeText}. */
export interface WriteTextOptions {
  /** Permission bits for the file, applied on creation and enforced on an existing file. */
  readonly mode?: number
  /** Permission bits for parent directories this write creates (existing ones are untouched). */
  readonly dirMode?: number
}

/** File-system operations used by devkit. */
export interface DevkitIo {
  /** Read a UTF-8 file, or `undefined` if it does not exist. */
  readText(path: string): Promise<string | undefined>
  /** Write a UTF-8 file, creating parent directories. */
  writeText(path: string, content: string, options?: WriteTextOptions): Promise<void>
  /** Move a file over another (atomic on the same volume), creating parent directories. */
  rename(from: string, to: string): Promise<void>
  /**
   * Remove a file or directory recursively; no error if it is missing. Devkit only calls this on
   * its own staging folders, never on a project path (those use {@link DevkitIo.removeFile}).
   */
  remove(path: string): Promise<void>
  /**
   * Remove one regular file; no error if it is missing. Never recurses and never follows a
   * symlink: a directory, symlink, junction or other special file is refused with
   * `INVALID_PATH`, so a bad path can never delete more than the one file it names.
   */
  removeFile(path: string): Promise<void>
  /** Describe a path without following a final symlink, or `undefined` if it does not exist. */
  inspect(path: string): Promise<PathInfo | undefined>
  exists(path: string): Promise<boolean>
  /** List files under `dir` recursively as sorted POSIX paths relative to `dir`, skipping `ignore` dir names. */
  listFiles(dir: string, ignore: readonly string[]): Promise<string[]>
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}

function kindOf(stats: import('node:fs').Stats): PathKind {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  return 'other'
}

/** The real file system. */
export const nodeIo: DevkitIo = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  },
  async writeText(path, content, options = {}) {
    await mkdir(
      dirname(path),
      options.dirMode === undefined
        ? { recursive: true }
        : { recursive: true, mode: options.dirMode },
    )
    if (options.mode === undefined) {
      await writeFile(path, content, 'utf8')
      return
    }
    // `mode` on writeFile only applies when the file is created: chmod enforces it otherwise.
    await writeFile(path, content, { encoding: 'utf8', mode: options.mode })
    await chmod(path, options.mode)
  },
  async rename(from, to) {
    await mkdir(dirname(to), { recursive: true })
    await retryWhileBusy(() => rename(from, to))
  },
  async remove(path) {
    // Node retries EBUSY, EPERM, ENOTEMPTY… itself when asked to.
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  },
  async removeFile(path) {
    const info = await nodeIo.inspect(path)
    if (info === undefined) return
    if (info.kind !== 'file') {
      throw new DevkitError(
        'INVALID_PATH',
        `refusing to delete ${path}: it is a ${info.kind}, and devkit only deletes regular files`,
      )
    }
    try {
      await retryWhileBusy(() => unlink(path))
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  },
  async inspect(path) {
    try {
      const stats = await lstat(path)
      return { kind: kindOf(stats), mode: stats.mode & 0o7777, uid: stats.uid }
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  },
  async exists(path) {
    try {
      await stat(path)
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  },
  async listFiles(dir, ignore) {
    const results: string[] = []
    const walk = async (current: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch (error) {
        if (isNotFound(error)) return
        throw error
      }
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          if (!ignore.includes(entry.name)) await walk(full)
        } else if (entry.isFile()) {
          results.push(relative(dir, full).split(sep).join('/'))
        }
      }
    }
    await walk(dir)
    return results.sort()
  },
}

/** Error codes Windows reports while another process (antivirus, indexer, editor) holds a file. */
const BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Options for {@link retryWhileBusy}. */
export interface BusyRetryOptions {
  /** Default `process.platform`. Only Windows retries: elsewhere these codes are real refusals. */
  readonly platform?: NodeJS.Platform
  /** Total attempts. Default 12. */
  readonly attempts?: number
  /**
   * Delay before the n-th retry is `n × delayMs`, capped at {@link MAX_BUSY_DELAY_MS}. Default
   * 50 ms: with 12 attempts, about 3 s in all.
   */
  readonly delayMs?: number
}

/** Longest single wait between two busy retries. */
const MAX_BUSY_DELAY_MS = 500

/**
 * Run a rename or unlink, retrying on Windows while the file is held open by another process.
 * Without this, a scanner touching a freshly written file makes a whole transaction roll back.
 *
 * Why about 3 s: antivirus scanners, indexers and editors open new files without
 * FILE_SHARE_DELETE, and on a busy machine they hold them for a second or more. The earlier 0.3 s
 * budget lost that race (`make:model --force` rolled back with EPERM, seen as a flaky test under
 * load and reproduced with a file held open for 1.5 s). The wait stays bounded, so a file that is
 * really locked still fails the change instead of hanging the command. Any other error, or the
 * last busy error, is thrown unchanged.
 */
export async function retryWhileBusy<T>(
  operation: () => Promise<T>,
  options: BusyRetryOptions = {},
): Promise<T> {
  const platform = options.platform ?? process.platform
  const attempts = options.attempts ?? 12
  const delayMs = options.delayMs ?? 50
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      const busy = typeof code === 'string' && BUSY_CODES.has(code)
      if (platform !== 'win32' || !busy || attempt >= attempts) throw error
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delayMs * attempt, MAX_BUSY_DELAY_MS)),
      )
    }
  }
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
