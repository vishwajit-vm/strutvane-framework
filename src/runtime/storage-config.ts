/**
 * `config/filesystems.ts` → storage disks and signed-link serving for a Strutvane app (RFC-0002 §5).
 *
 * ```ts
 * // config/filesystems.ts
 * export default defineConfig({
 *   default: 'local',
 *   disks: { local: { driver: 'local', root: 'storage/app/private' } },
 * })
 * ```
 *
 * - Without the file, the app gets one private `local` disk at `<root>/storage/app/private`
 *   (Laravel 11's layout): never the parent of the public disk's `storage/app/public`.
 * - Two local disks may not share a folder or sit inside each other: a private disk around the
 *   public one would let `storage:link` (or the public mount) reach private files.
 * - Relative roots resolve against the project root, never the working directory.
 * - Every disk signs temporary links with a key derived from `signingSecret`, else `config/app.ts`
 *   `key`, else `APP_KEY` (HKDF subkey, see storage/signing.ts). Disks with a secret are served at
 *   `/storage/<disk>/…` (signature checked on every request), so `disk.temporaryUrl(key)` links
 *   work out of the box.
 *
 * Failure scenarios (each throws at boot, naming the setting):
 * - an unknown `driver` (cloud drivers come from `@strutvane/files` via `StorageManager.extend`);
 * - a `default` that names no configured disk;
 * - a signing secret shorter than 32 bytes (a weak key would make links forgeable);
 * - two local disks whose roots are the same folder or nested.
 *
 * @module
 */
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { StorageDisk } from '../contracts/index.ts'
import { createLocalDisk } from '../storage/local-disk.ts'
import { createMemoryDisk } from '../storage/memory-disk.ts'
import type { SignedFileOptions } from '../storage/serve-signed.ts'

/** One disk in `config/filesystems.ts`. */
export interface AppDiskConfig {
  readonly driver: 'local' | 'memory'
  /**
   * Folder for `local` disks (relative to the project root). Default `storage/app/private` for
   * `local`, `storage/app/public` for `public`, else `storage/<disk name>`.
   */
  readonly root?: string
  readonly visibility?: 'private' | 'public'
  /** Base URL for public files. */
  readonly url?: string
}

/** `config/filesystems.ts`. */
export interface AppFilesystemsConfig {
  readonly default?: string
  readonly disks?: Readonly<Record<string, AppDiskConfig>>
  /** Secret for signed links (at least 32 bytes). Default: `config/app.ts` `key`, else `APP_KEY`. */
  readonly signingSecret?: string
}

/** What {@link storageFromConfig} builds. */
export interface AppStorage {
  readonly default: string
  readonly disks: readonly StorageDisk[]
  /** Disks whose signed links the HTTP app serves. */
  readonly signedFiles: readonly SignedFileOptions[]
}

/** Build the app's disks from `config/filesystems.ts`. */
export function storageFromConfig(
  config: AppFilesystemsConfig | undefined,
  options: { readonly root: string; readonly appKey?: string | undefined },
): AppStorage {
  const secret = config?.signingSecret || options.appKey || undefined
  if (secret !== undefined && Buffer.byteLength(secret) < 32)
    throw new Error(
      'config/filesystems.ts: the signing secret (signingSecret, app.key or APP_KEY) must be at least 32 bytes',
    )
  const entries = Object.entries(config?.disks ?? { local: { driver: 'local' as const } })
  const disks: StorageDisk[] = []
  const signedFiles: SignedFileOptions[] = []
  const roots: { readonly name: string; readonly root: string }[] = []
  for (const [name, disk] of entries) {
    const signing = secret !== undefined ? { signingSecret: secret } : {}
    const common = { name, ...signing, ...(disk.url ? { url: disk.url } : {}) }
    if (disk.driver === 'local') {
      const folder = disk.root ?? defaultLocalRoot(name)
      const root = resolve(isAbsolute(folder) ? folder : join(options.root, folder))
      assertSeparateRoot(roots, name, root)
      roots.push({ name, root })
      disks.push(
        createLocalDisk({
          ...common,
          ...(disk.visibility ? { visibility: disk.visibility } : {}),
          root,
        }),
      )
    } else if (disk.driver === 'memory') {
      disks.push(createMemoryDisk(common))
    } else {
      throw new Error(
        `config/filesystems.ts: disk "${name}" has unknown driver ${JSON.stringify((disk as { driver: unknown }).driver)} (built in: local, memory; cloud drivers come from @strutvane/files)`,
      )
    }
    if (secret !== undefined) signedFiles.push({ disk: disks.at(-1) as StorageDisk, secret })
  }
  const defaultDisk = config?.default ?? entries[0]?.[0] ?? 'local'
  if (!disks.some((d) => d.name === defaultDisk))
    throw new Error(`config/filesystems.ts: default disk "${defaultDisk}" is not configured`)
  return { default: defaultDisk, disks, signedFiles }
}

/**
 * Where a `local` disk lives when its config names no `root`: `storage/app/private` for
 * `local` and `storage/app/public` for `public` (Laravel 11), `storage/<name>` otherwise.
 *
 * @example
 * defaultLocalRoot('local') // 'storage/app/private'
 */
export function defaultLocalRoot(name: string): string {
  if (name === 'local') return join('storage', 'app', 'private')
  if (name === 'public') return join('storage', 'app', 'public')
  return join('storage', name)
}

/** Throw when `root` is, contains, or sits inside the root of an earlier local disk. */
function assertSeparateRoot(
  earlier: readonly { readonly name: string; readonly root: string }[],
  name: string,
  root: string,
): void {
  // Windows and macOS folders are case-insensitive by default: compare as the file system would.
  const fold = (path: string): string => (process.platform === 'linux' ? path : path.toLowerCase())
  const within = (inner: string, outer: string): boolean =>
    fold(inner) === fold(outer) ||
    fold(inner).startsWith(fold(outer.endsWith(sep) ? outer : outer + sep))
  for (const other of earlier) {
    if (!within(root, other.root) && !within(other.root, root)) continue
    throw new Error(
      `config/filesystems.ts: the disks "${other.name}" (${other.root}) and "${name}" (${root}) share a folder or one sits inside the other, so one disk's files (private ones included) would be reachable through the other. Give each local disk its own folder, e.g. local: storage/app/private and public: storage/app/public.`,
    )
  }
}
