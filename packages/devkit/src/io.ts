/**
 * The minimal file-system surface devkit needs. It is injected (rather than importing `node:fs`
 * everywhere) so tests can simulate failures, such as a rename that fails halfway through a
 * commit, and prove that transactions roll back or recover.
 *
 * All paths are absolute. Text is always UTF-8.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** File-system operations used by devkit. */
export interface DevkitIo {
  /** Read a UTF-8 file, or `undefined` if it does not exist. */
  readText(path: string): Promise<string | undefined>
  /** Write a UTF-8 file, creating parent directories. */
  writeText(path: string, content: string): Promise<void>
  /** Move a file over another (atomic on the same volume), creating parent directories. */
  rename(from: string, to: string): Promise<void>
  /** Remove a file or directory recursively; no error if it is missing. */
  remove(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** List files under `dir` recursively as sorted POSIX paths relative to `dir`, skipping `ignore` dir names. */
  listFiles(dir: string, ignore: readonly string[]): Promise<string[]>
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
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
  async writeText(path, content) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  },
  async rename(from, to) {
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true })
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

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
