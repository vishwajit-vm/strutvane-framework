/**
 * The `Storage` facade: the current app's disks (`config/filesystems.ts`), Laravel's `Storage::`.
 *
 * @module
 */
import type { FileBody, PutOptions, StorageDisk, StoredFile } from '../contracts/storage.ts'
import type { StorageManager } from '../storage/manager.ts'
import { StorageManagerToken } from '../tokens.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<StorageManager> = {
  facade: 'Storage',
  token: StorageManagerToken,
  provides: 'the storage manager',
  install:
    'Configure config/filesystems.ts; the framework provider binds the disks when the app boots.',
}

/**
 * What the `Storage` facade offers: named disks, tenant-confined disks, and shortcuts to the
 * default disk.
 *
 * @example
 * const storage: StorageFacade = Storage
 */
export interface StorageFacade {
  /** A disk by name (the default disk when omitted). */
  disk(name?: string): StorageDisk
  /** A disk confined to one tenant (`tenants/<id>/`); use it for tenant data. */
  forTenant(tenantId: string, name?: string): StorageDisk
  /** The configured disk names. */
  names(): readonly string[]
  /** Store a file on the default disk. */
  put(key: string, body: FileBody, options?: PutOptions): Promise<StoredFile>
  /** Read a file from the default disk as a stream. */
  get(key: string): Promise<ReadableStream<Uint8Array>>
  /** Whether a file exists on the default disk. */
  exists(key: string): Promise<boolean>
  /** Delete a file from the default disk. */
  delete(key: string): Promise<void>
  /** A short-lived signed URL for a file on the default disk. */
  temporaryUrl(key: string, options?: { readonly expiresInSeconds?: number }): Promise<string>
}

/**
 * Read and write files on the current app's disks.
 *
 * @example
 * await Storage.put('avatars/7.png', bytes, { contentType: 'image/png' })
 * const link = await Storage.disk('local').temporaryUrl('avatars/7.png')
 */
export const Storage: StorageFacade = Object.freeze({
  disk: (name?: string): StorageDisk => resolveFacade(binding, 'disk').disk(name),
  forTenant: (tenantId: string, name?: string): StorageDisk =>
    resolveFacade(binding, 'forTenant').forTenant(tenantId, name),
  names: (): readonly string[] => resolveFacade(binding, 'names').names(),
  put: (key: string, body: FileBody, options?: PutOptions): Promise<StoredFile> =>
    resolveFacade(binding, 'put').disk().put(key, body, options),
  get: (key: string): Promise<ReadableStream<Uint8Array>> =>
    resolveFacade(binding, 'get').disk().get(key),
  exists: (key: string): Promise<boolean> => resolveFacade(binding, 'exists').disk().exists(key),
  delete: (key: string): Promise<void> => resolveFacade(binding, 'delete').disk().delete(key),
  temporaryUrl: (key: string, options?: { readonly expiresInSeconds?: number }): Promise<string> =>
    resolveFacade(binding, 'temporaryUrl').disk().temporaryUrl(key, options),
})
