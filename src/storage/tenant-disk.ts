/**
 * Tenant-scoped disks: every key a tenant's code uses is stored under `tenants/<tenantId>/`.
 *
 * Without this, isolation between tenants' files depends on every caller remembering to put the
 * tenant in the key. A tenant disk makes it structural: callers work with short keys
 * (`invoices/0190….pdf`), the prefix is added on the way in and removed on the way out, and
 * `list('')` can only ever see that tenant's files. The tenant id must be a UUID, so it can
 * never contain `/` or `..`.
 *
 * @module
 */
import type { FileListPage, StorageDisk, StoredFile } from '../contracts/index.ts'
import { assertTenantId } from '../database/types.ts'
import { assertSafeKey, assertSafePrefix } from './keys.ts'

/** The key prefix of a tenant's files on a shared disk. */
export function tenantPrefix(tenantId: string): string {
  assertTenantId(tenantId)
  return `tenants/${tenantId.toLowerCase()}/`
}

/** Wrap `disk` so every key is confined to the tenant's prefix. */
export function tenantDisk(disk: StorageDisk, tenantId: string): StorageDisk {
  const prefix = tenantPrefix(tenantId)
  const inner = (key: string): string => {
    assertSafeKey(key)
    return `${prefix}${key}`
  }
  const outer = (file: StoredFile): StoredFile =>
    file.key.startsWith(prefix) ? { ...file, key: file.key.slice(prefix.length) } : file
  return {
    name: disk.name,
    put: async (key, body, options) => outer(await disk.put(inner(key), body, options)),
    get: (key) => disk.get(inner(key)),
    exists: (key) => disk.exists(inner(key)),
    stat: async (key) => {
      const file = await disk.stat(inner(key))
      return file ? outer(file) : undefined
    },
    delete: (key) => disk.delete(inner(key)),
    async list(listPrefix, options = {}): Promise<FileListPage> {
      assertSafePrefix(listPrefix)
      const page = await disk.list(`${prefix}${listPrefix}`, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor !== undefined ? { cursor: `${prefix}${options.cursor}` } : {}),
      })
      return {
        items: page.items.filter((f) => f.key.startsWith(prefix)).map(outer),
        ...(page.nextCursor?.startsWith(prefix)
          ? { nextCursor: page.nextCursor.slice(prefix.length) }
          : {}),
      }
    },
    url: (key) => disk.url(inner(key)),
    temporaryUrl: (key, options) => disk.temporaryUrl(inner(key), options),
  }
}
