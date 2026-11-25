/**
 * The `local` disk: files under a root folder, streamed in and out.
 *
 * - **Path safety:** keys are validated ({@link assertSafeKey}) *and* the resolved path is
 *   checked to stay inside the root, so no key can reach `../` or an absolute path on any OS.
 * - **Atomic writes:** a file is written to a temp name and renamed into place, so readers never
 *   see half a file and a failed write leaves nothing behind.
 * - **Metadata** (type, sha256, visibility, time) and in-progress uploads live **next to** the
 *   root, never inside it ({@link localDiskSidecar}: `<parent>/.strutvane-disks/<root name>/`).
 *   A web server that serves the root (`storage:link` → `public/storage`) can then never hand
 *   out a metadata file or half an upload. Sidecars an older version kept inside the root
 *   (`.strutvane-meta/`, `.strutvane-tmp/`) are moved out on first use.
 * - **Overwrites** never serve the new bytes under the old metadata: the old metadata is removed
 *   before the new bytes take its place, and the new metadata is written atomically.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  stat as fsStat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type {
  FileBody,
  FileListPage,
  PutOptions,
  StorageDisk,
  StoredFile,
} from '../contracts/index.ts'
import { FileNotFoundError, measuring, toStream } from './body.ts'
import { assertSafeKey, assertSafePrefix, UnsafeKeyError } from './keys.ts'
import { assertStorableContentType } from './mime.ts'
import { signUrl } from './signing.ts'

/** Where versions before 0.2.0-next.3 kept the sidecars: inside the root (moved out on first use). */
const LEGACY_META_DIR = '.strutvane-meta'
const LEGACY_TMP_DIR = '.strutvane-tmp'
/** The folder, next to a disk's root, that holds the sidecars of every root in that parent. */
export const SIDECAR_DIR = '.strutvane-disks'

/**
 * Where a local disk keeps its metadata and in-progress uploads: beside the root, in
 * `<parent>/.strutvane-disks/<root name>/{meta,tmp}`, on the same file system (so the final
 * rename is atomic) and outside every served folder. Throws for a root with no parent (`/`).
 *
 * @example
 * localDiskSidecar('/srv/app/storage/app/public')
 * // { meta: '/srv/app/storage/app/.strutvane-disks/public/meta', tmp: '…/public/tmp' }
 */
export function localDiskSidecar(root: string): { readonly meta: string; readonly tmp: string } {
  const full = resolve(root)
  const parent = dirname(full)
  if (parent === full)
    throw new Error(
      `A local disk can't use the file system root (${full}) as its root: its metadata would sit inside it. Use a folder such as storage/app/private.`,
    )
  const base = join(parent, SIDECAR_DIR, basename(full))
  return { meta: join(base, 'meta'), tmp: join(base, 'tmp') }
}

/** Options for {@link createLocalDisk}. */
export interface LocalDiskOptions {
  readonly name?: string
  /** Root folder (created if missing). */
  readonly root: string
  /** Default visibility. Default `private`. */
  readonly visibility?: 'private' | 'public'
  /** Base for public URLs, e.g. `/storage`. */
  readonly url?: string
  /** Secret for `temporaryUrl` (at least 32 bytes). */
  readonly signingSecret?: string
  readonly now?: () => Date
}

/** Create a local-folder disk. */
export function createLocalDisk(options: LocalDiskOptions): StorageDisk {
  const name = options.name ?? 'local'
  const root = resolve(options.root)
  const now = options.now ?? (() => new Date())
  const sidecar = localDiskSidecar(root)
  // Once per disk: move sidecars an older version kept inside the root out of it.
  let moved: Promise<void> | undefined
  const ready = (): Promise<void> => {
    moved ??= moveLegacySidecars(root, sidecar.meta)
    return moved
  }

  const pathOf = (key: string, base = root): string => {
    assertSafeKey(key)
    const full = resolve(base, ...key.split('/'))
    const rel = relative(base, full)
    if (
      rel === '' ||
      rel.startsWith('..') ||
      rel.includes(`..${sep}`) ||
      resolve(base, rel) !== full
    ) {
      throw new UnsafeKeyError(`key escapes the disk root: ${key}`)
    }
    return full
  }
  const metaOf = (key: string): string => `${pathOf(key, sidecar.meta)}.json`

  const readMeta = async (key: string): Promise<StoredFile | undefined> => {
    await ready()
    try {
      return JSON.parse(await readFile(metaOf(key), 'utf8')) as StoredFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  return {
    name,
    async put(key: string, body: FileBody, put: PutOptions = {}): Promise<StoredFile> {
      const target = pathOf(key)
      assertStorableContentType(put.contentType)
      await ready()
      await mkdir(sidecar.tmp, { recursive: true })
      const tmp = join(sidecar.tmp, `${randomUUID()}.part`)
      const meta = metaOf(key)
      const m = measuring()
      // Open eagerly: a lazily-opened stream could create the file *after* a failed write was
      // cleaned up. Wait for 'close' before renaming or deleting (Windows locks open files).
      const handle = await open(tmp, 'wx')
      const out = handle.createWriteStream()
      const closed = new Promise<void>((r) => out.once('close', () => r()))
      try {
        await toStream(body).pipeThrough(m.stream).pipeTo(Writable.toWeb(out))
        await closed
        await mkdir(dirname(target), { recursive: true })
        // Overwrite: drop the old metadata first, so the new bytes are never served under the
        // old file's visibility or type (a public file replaced by a private one, for example).
        await rm(meta, { force: true })
        await rename(tmp, target)
      } catch (error) {
        out.destroy()
        await closed
        await rm(tmp, { force: true })
        throw error
      }
      const { size, sha256 } = m.result()
      const info: StoredFile = {
        disk: name,
        key,
        size,
        sha256,
        contentType: put.contentType ?? 'application/octet-stream',
        visibility: put.visibility ?? options.visibility ?? 'private',
        createdAt: now().toISOString(),
      }
      await mkdir(dirname(meta), { recursive: true })
      // Atomic, like the bytes: a reader sees the old metadata, none, or the new, never half.
      const metaTmp = join(sidecar.tmp, `${randomUUID()}.json`)
      await writeFile(metaTmp, JSON.stringify(info), 'utf8')
      await rename(metaTmp, meta)
      return info
    },
    async get(key) {
      const path = pathOf(key)
      try {
        const s = await fsStat(path)
        if (!s.isFile()) throw new FileNotFoundError(key)
      } catch (error) {
        if (
          error instanceof FileNotFoundError ||
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          throw new FileNotFoundError(key)
        }
        throw error
      }
      return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
    },
    async exists(key) {
      try {
        return (await fsStat(pathOf(key))).isFile()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    async stat(key) {
      pathOf(key)
      return readMeta(key)
    },
    async delete(key) {
      await ready()
      // Metadata first: a file without metadata is never served publicly.
      await rm(metaOf(key), { force: true })
      await rm(pathOf(key), { force: true })
    },
    async list(prefix, opts = {}): Promise<FileListPage> {
      assertSafePrefix(prefix)
      await ready()
      const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
      const keys: string[] = []
      const walk = async (dir: string, parts: string[]): Promise<void> => {
        let entries: import('node:fs').Dirent[]
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        for (const e of entries) {
          if (e.name === LEGACY_META_DIR || e.name === LEGACY_TMP_DIR) continue
          if (e.isDirectory()) await walk(join(dir, e.name), [...parts, e.name])
          else if (e.isFile()) keys.push([...parts, e.name].join('/'))
        }
      }
      await walk(root, [])
      const matching = keys.filter((k) => k.startsWith(prefix)).sort()
      const start = opts.cursor ? matching.findIndex((k) => k > (opts.cursor as string)) : 0
      const slice = start < 0 ? [] : matching.slice(start, start + limit)
      const items: StoredFile[] = []
      for (const k of slice) {
        const meta = await readMeta(k)
        if (meta) items.push(meta)
      }
      const last = slice.at(-1)
      return {
        items,
        ...(start >= 0 && start + limit < matching.length && last ? { nextCursor: last } : {}),
      }
    },
    async url(key) {
      const meta = await readMeta(key)
      if (!meta) throw new FileNotFoundError(key)
      if (meta.visibility !== 'public' || !options.url)
        throw new Error(`"${key}" has no public URL`)
      return `${options.url.replace(/\/+$/, '')}/${key}`
    },
    async temporaryUrl(key, opts = {}) {
      pathOf(key)
      if (!options.signingSecret)
        throw new Error(`Disk "${name}" has no signing secret for temporary URLs`)
      return signUrl(options.url ?? `/storage/${name}`, name, key, opts.expiresInSeconds ?? 300, {
        secret: options.signingSecret,
        now: () => now().getTime(),
      })
    },
  }
}

/**
 * Move the sidecars an older version kept inside `root` out of it (what a disk does on first
 * use), for tools that look at the folder without opening a disk (`storage:link`).
 *
 * @example
 * await moveLocalDiskSidecars('/srv/app/storage/app/public')
 */
export function moveLocalDiskSidecars(root: string): Promise<void> {
  const full = resolve(root)
  return moveLegacySidecars(full, localDiskSidecar(full).meta)
}

/**
 * Move the sidecars an older version kept inside the root to {@link localDiskSidecar}: metadata
 * is moved (merged when both exist, the newer location winning), leftover partial uploads are
 * deleted. Idempotent; a missing legacy folder is the normal case.
 */
async function moveLegacySidecars(root: string, meta: string): Promise<void> {
  const legacyMeta = join(root, LEGACY_META_DIR)
  await rm(join(root, LEGACY_TMP_DIR), { recursive: true, force: true })
  try {
    await fsStat(legacyMeta)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await mkdir(dirname(meta), { recursive: true })
  try {
    await rename(legacyMeta, meta)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Another process (a second worker on the same root) moved it first: nothing left to do.
    if (code === 'ENOENT') return
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error
  }
  try {
    await cp(legacyMeta, meta, { recursive: true, force: false, errorOnExist: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await rm(legacyMeta, { recursive: true, force: true })
}
