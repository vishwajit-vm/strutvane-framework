/**
 * The `memory` disk: files in a Map. For tests and ephemeral data only (contents are buffered,
 * which is fine for the small files tests use).
 *
 * @module
 */
import type {
  FileBody,
  FileListPage,
  PutOptions,
  StorageDisk,
  StoredFile,
} from '../contracts/index.ts'
import { FileNotFoundError, measuring, toStream } from './body.ts'
import { assertSafeKey, assertSafePrefix } from './keys.ts'
import { signUrl } from './signing.ts'

/** Options for {@link createMemoryDisk}. */
export interface MemoryDiskOptions {
  readonly name?: string
  /** Base for public URLs, e.g. `/storage`. */
  readonly url?: string
  /** Secret for `temporaryUrl` (at least 32 bytes). */
  readonly signingSecret?: string
  readonly now?: () => Date
}

/** Create an in-memory disk. */
export function createMemoryDisk(options: MemoryDiskOptions = {}): StorageDisk {
  const name = options.name ?? 'memory'
  const now = options.now ?? (() => new Date())
  const files = new Map<string, { info: StoredFile; bytes: Uint8Array }>()

  return {
    name,
    async put(key: string, body: FileBody, put: PutOptions = {}): Promise<StoredFile> {
      assertSafeKey(key)
      assertStorableContentType(put.contentType)
      const m = measuring()
      const chunks: Uint8Array[] = []
      const reader = toStream(body).pipeThrough(m.stream).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const bytes = new Uint8Array(Buffer.concat(chunks))
      const { size, sha256 } = m.result()
      const info: StoredFile = {
        disk: name,
        key,
        size,
        sha256,
        contentType: put.contentType ?? 'application/octet-stream',
        visibility: put.visibility ?? 'private',
        createdAt: now().toISOString(),
      }
      files.set(key, { info, bytes })
      return info
    },
    async get(key) {
      assertSafeKey(key)
      const f = files.get(key)
      if (!f) throw new FileNotFoundError(key)
      return toStream(f.bytes.slice())
    },
    async exists(key) {
      assertSafeKey(key)
      return files.has(key)
    },
    async stat(key) {
      assertSafeKey(key)
      return files.get(key)?.info
    },
    async delete(key) {
      assertSafeKey(key)
      files.delete(key)
    },
    async list(prefix, opts = {}): Promise<FileListPage> {
      assertSafePrefix(prefix)
      const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
      const keys = [...files.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = opts.cursor ? keys.findIndex((k) => k > (opts.cursor as string)) : 0
      const slice = start < 0 ? [] : keys.slice(start, start + limit)
      const items = slice.map((k) => (files.get(k) as { info: StoredFile }).info)
      const last = slice.at(-1)
      return {
        items,
        ...(start >= 0 && start + limit < keys.length && last ? { nextCursor: last } : {}),
      }
    },
    async url(key) {
      assertSafeKey(key)
      const f = files.get(key)
      if (!f) throw new FileNotFoundError(key)
      if (f.info.visibility !== 'public' || !options.url)
        throw new Error(`"${key}" has no public URL`)
      return `${options.url.replace(/\/+$/, '')}/${key}`
    },
    async temporaryUrl(key, opts = {}) {
      assertSafeKey(key)
      if (!options.signingSecret)
        throw new Error(`Disk "${name}" has no signing secret for temporary URLs`)
      return signUrl(options.url ?? `/storage/${name}`, name, key, opts.expiresInSeconds ?? 300, {
        secret: options.signingSecret,
        now: () => now().getTime(),
      })
    },
  }
}
