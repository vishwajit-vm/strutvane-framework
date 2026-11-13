/**
 * The StorageManager: named disks with a default (`config/filesystems.ts`, RFC-0002 §5).
 * `@strutvane/files` registers cloud drivers (s3, azure-blob, gcs) through {@link StorageManager.extend}.
 *
 * @module
 */
import type { StorageDisk } from '@strutvane/contracts'

/** Named disks. */
export interface StorageManager {
  /** The default disk's name. */
  readonly defaultDisk: string
  /** A disk by name (default disk when omitted). Throws for an unknown name. */
  disk(name?: string): StorageDisk
  /** Add a disk (e.g. from `@strutvane/files`). Names are unique. */
  extend(disk: StorageDisk): void
  /** Configured disk names. */
  names(): readonly string[]
}

/** Create a manager from disks. */
export function createStorageManager(options: {
  readonly default: string
  readonly disks: readonly StorageDisk[]
}): StorageManager {
  const disks = new Map<string, StorageDisk>()
  const manager: StorageManager = {
    defaultDisk: options.default,
    disk(name = options.default) {
      const d = disks.get(name)
      if (!d)
        throw new Error(
          `Unknown storage disk "${name}" (configured: ${[...disks.keys()].join(', ') || 'none'})`,
        )
      return d
    },
    extend(disk) {
      if (disks.has(disk.name)) throw new Error(`Storage disk "${disk.name}" is already registered`)
      disks.set(disk.name, disk)
    },
    names: () => [...disks.keys()],
  }
  for (const d of options.disks) manager.extend(d)
  if (!disks.has(options.default))
    throw new Error(`Default disk "${options.default}" is not configured`)
  return manager
}
