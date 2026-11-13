/**
 * The staged file system behind every installer, generator and editor.
 *
 * Writes are recorded in memory, not on disk. Callers can then:
 * - **preview** them (`changes()`, `diff()`), which is what `--dry-run` shows,
 * - **discard** them (an installer failed halfway, so nothing touches the project), or
 * - **commit** them as one transaction (all files or none; see `transaction.ts`).
 *
 * Reads see staged content first, so several editors can build on each other's changes (e.g. two
 * installers both editing `.env`).
 *
 * Safety rules:
 * - every path goes through `resolveInsideProject` (no traversal, no absolute paths, no symlink
 *   escape),
 * - an existing file is never overwritten unless the caller says `overwrite: true`; writing the
 *   identical content is a no-op, which keeps installers idempotent,
 * - updating a CRLF file keeps it CRLF.
 *
 * @module
 */
import type { InstallFs } from '@strutvane/contracts'
import { createTwoFilesPatch } from 'diff'
import { DevkitError } from './errors.ts'
import { type DevkitIo, nodeIo } from './io.ts'
import { normaliseRelativePath, resolveInsideProject } from './paths.ts'
import { matchLineEndings } from './text.ts'
import { commitTransaction } from './transaction.ts'

/** One pending change, as shown in previews. */
export interface FileChange {
  readonly path: string
  readonly kind: 'create' | 'update' | 'delete'
  /** Current content on disk (`undefined` for creates). */
  readonly before?: string
  /** Content after commit (`undefined` for deletes). */
  readonly after?: string
}

/** Options for {@link StagedFs.write}. */
export interface WriteOptions {
  /** Replace an existing file with different content. Default `false`. */
  readonly overwrite?: boolean
  /**
   * Re-encode the content in the existing file's line-ending style (CRLF stays CRLF).
   * Default `true`.
   */
  readonly preserveLineEndings?: boolean
}

/** The contracts' `InstallFs`, plus deletion, previews and the transaction controls. */
export interface StagedFs extends InstallFs {
  readonly projectRoot: string
  write(path: string, content: string, options?: WriteOptions): Promise<void>
  /** Stage the deletion of a file. Deleting a missing file is a no-op. */
  remove(path: string): Promise<void>
  /** Pending changes, sorted by path. Writes identical to disk are not changes. */
  changes(): Promise<FileChange[]>
  /** A unified diff of every pending change, for `--dry-run`. Empty string when nothing changes. */
  diff(): Promise<string>
  /** Apply every pending change as one transaction, then clear the stage. Returns changed paths. */
  commit(): Promise<string[]>
  /** Drop every pending change. */
  discard(): void
}

/** Create a staged file system rooted at `projectRoot`. */
export function createStagedFs(
  projectRoot: string,
  options: { readonly io?: DevkitIo } = {},
): StagedFs {
  const io = options.io ?? nodeIo
  /** path → staged content (`null` = staged deletion). Insertion order is irrelevant; output is sorted. */
  const staged = new Map<string, string | null>()

  const readDisk = (path: string): Promise<string | undefined> =>
    io.readText(resolveInsideProject(projectRoot, path))

  const current = async (path: string): Promise<string | undefined> => {
    const rel = normaliseRelativePath(path)
    if (staged.has(rel)) return staged.get(rel) ?? undefined
    return readDisk(rel)
  }

  const fs: StagedFs = {
    projectRoot,

    async exists(path) {
      return (await current(path)) !== undefined
    },

    async read(path) {
      const content = await current(path)
      if (content === undefined) throw new DevkitError('FILE_NOT_FOUND', `file not found: ${path}`)
      return content
    },

    async write(path, content, writeOptions = {}) {
      const rel = normaliseRelativePath(path)
      resolveInsideProject(projectRoot, rel) // validate now, not at commit time
      const existing = await current(rel)
      let next = content
      if (existing !== undefined && writeOptions.preserveLineEndings !== false) {
        next = matchLineEndings(existing, content)
      }
      if (existing === next) return // identical: no-op (keeps installers idempotent)
      if (existing !== undefined && writeOptions.overwrite !== true) {
        throw new DevkitError(
          'FILE_EXISTS',
          `${rel} already exists with different content; pass { overwrite: true } to replace it`,
        )
      }
      staged.set(rel, next)
    },

    async remove(path) {
      const rel = normaliseRelativePath(path)
      resolveInsideProject(projectRoot, rel)
      if ((await readDisk(rel)) === undefined) staged.delete(rel)
      else staged.set(rel, null)
    },

    async changes() {
      const out: FileChange[] = []
      for (const path of [...staged.keys()].sort()) {
        const after = staged.get(path)
        const before = await readDisk(path)
        if (after === null) {
          if (before !== undefined) out.push({ path, kind: 'delete', before })
        } else if (after !== undefined && before !== after) {
          out.push(
            before === undefined
              ? { path, kind: 'create', after }
              : { path, kind: 'update', before, after },
          )
        }
      }
      return out
    },

    async diff() {
      const patches = (await fs.changes()).map((c) =>
        createTwoFilesPatch(
          c.kind === 'create' ? '/dev/null' : `a/${c.path}`,
          c.kind === 'delete' ? '/dev/null' : `b/${c.path}`,
          c.before ?? '',
          c.after ?? '',
        ),
      )
      return patches.join('')
    },

    async commit() {
      const changes = await fs.changes()
      await commitTransaction(
        changes.map((c) => ({ path: c.path, content: c.after ?? null })),
        { io, projectRoot },
      )
      staged.clear()
      return changes.map((c) => c.path)
    },

    discard() {
      staged.clear()
    },
  }
  return fs
}
