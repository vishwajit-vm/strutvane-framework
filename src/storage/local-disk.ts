/**
 * The `local` disk: files under a root folder, streamed in and out.
 *
 * - **Path safety:** keys are validated ({@link assertSafeKey}) *and* the resolved path is
 *   checked to stay inside the root, so no key can reach `../` or an absolute path on any OS.
 * - **Atomic writes:** a file is written to a temp name and renamed into place, so readers never
 *   see half a file and a failed write leaves nothing behind.
 * - **Metadata** (type, sha256, visibility, time) lives in a sidecar under `.strutvane-meta/`,
 *   which no valid key can address (segments cannot start with a dot).
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  stat as fsStat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
import { signUrl } from './signing.ts'

const META_DIR = '.strutvane-meta'
const TMP_DIR = '.strutvane-tmp'

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
  const metaOf = (key: string): string => `${pathOf(key, join(root, META_DIR))}.json`

  const readMeta = async (key: string): Promise<StoredFile | undefined> => {
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
      const tmpDir = join(root, TMP_DIR)
      await mkdir(tmpDir, { recursive: true })
      const tmp = join(tmpDir, `${randomUUID()}.part`)
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
      const meta = metaOf(key)
      await mkdir(dirname(meta), { recursive: true })
      await writeFile(meta, JSON.stringify(info), 'utf8')
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
      await rm(pathOf(key), { force: true })
      await rm(metaOf(key), { force: true })
    },
    async list(prefix, opts = {}): Promise<FileListPage> {
      assertSafePrefix(prefix)
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
          if (e.name === META_DIR || e.name === TMP_DIR) continue
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
