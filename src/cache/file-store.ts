/**
 * The file cache store: one JSON file per key in `storage/framework/cache`, shared by every process
 * of the app on one machine (Laravel's `file` driver).
 *
 * - **Safe names:** a file is named by the SHA-256 of its key, so a key like `../../.env` can never
 *   become a path, and any string is a valid key.
 * - **Atomic writes:** every write is a temporary file renamed over the target (`atomic-write.ts`),
 *   so a reader in another process sees the old entry or the new one, never half of each.
 * - **Atomic `add` and `increment` across processes:** writes run under a per-key lock file
 *   (`file-lock.ts`), so two workers counting the same rate limit never lose an increment.
 * - **Corrupt or hand-edited files are a miss,** never a crash: entries are parsed with depth and
 *   key limits and checked against the key they claim to hold.
 * - Expiry uses the app's clock, so tests move time instead of sleeping.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../core/clock.ts'
import { parseJsonSafely } from '../security/safe-json.ts'
import { removeFile, writeFileAtomic } from '../support/atomic-write.ts'
import type { CacheStore } from './contract.ts'
import { type FileLockOptions, withFileLock } from './file-lock.ts'

/**
 * The file store's default folder, relative to the app.
 *
 * @example
 * join(basePath, FILE_CACHE_FOLDER) // '/srv/blog/storage/framework/cache'
 */
export const FILE_CACHE_FOLDER: string = join('storage', 'framework', 'cache')

/** What one cache file holds. */
interface Entry {
  readonly key: string
  readonly value: unknown
  /** Epoch milliseconds, or `null` for "forever". */
  readonly expiresAt: number | null
}

/**
 * Options for {@link FileCacheStore}.
 *
 * @example
 * const options: FileCacheStoreOptions = { directory: '/srv/blog/storage/framework/cache', clock }
 */
export interface FileCacheStoreOptions {
  /** The folder the entries live in (created on first write). */
  readonly directory: string
  /** The app's clock (`ClockToken`): expiry is computed from it. */
  readonly clock: Clock
  /** Lock timings for cross-process writes. */
  readonly lock?: FileLockOptions
}

/**
 * The file cache store.
 *
 * @example
 * const store = new FileCacheStore({ directory: join(basePath, FILE_CACHE_FOLDER), clock })
 * await store.increment('throttle:login:203.0.113.7', 1, 60) // 1, even across processes
 */
export class FileCacheStore implements CacheStore {
  readonly #directory: string
  readonly #clock: Clock
  readonly #lock: FileLockOptions

  constructor(options: FileCacheStoreOptions) {
    this.#directory = options.directory
    this.#clock = options.clock
    this.#lock = options.lock ?? {}
  }

  /** The folder the entries live in. */
  get directory(): string {
    return this.#directory
  }

  async get(key: string): Promise<unknown> {
    return this.#live(key)?.value
  }

  async has(key: string): Promise<boolean> {
    return this.#live(key) !== undefined
  }

  async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.#locked(key, () => this.#write(key, value, this.#expiry(ttlSeconds)))
  }

  async add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    return this.#locked(key, () => {
      if (this.#live(key) !== undefined) return false
      this.#write(key, value, this.#expiry(ttlSeconds))
      return true
    })
  }

  async increment(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    return this.#locked(key, () => {
      const entry = this.#live(key)
      if (entry === undefined || typeof entry.value !== 'number') {
        this.#write(key, by, this.#expiry(ttlSeconds))
        return by
      }
      // Fixed windows: an existing counter keeps its expiry.
      const next = entry.value + by
      this.#write(key, next, entry.expiresAt)
      return next
    })
  }

  async ttl(key: string): Promise<number | undefined> {
    const expiresAt = this.#live(key)?.expiresAt
    if (expiresAt === undefined || expiresAt === null) return undefined
    return Math.max(0, Math.ceil((expiresAt - this.#clock.now()) / 1000))
  }

  async forget(key: string): Promise<boolean> {
    return this.#locked(key, () => {
      const existed = this.#live(key) !== undefined
      return removeFile(this.#path(key)) && existed
    })
  }

  async flush(): Promise<void> {
    if (!existsSync(this.#directory)) return
    for (const name of readdirSync(this.#directory))
      if (/^[a-f0-9]{64}\.json$/.test(name)) removeFile(join(this.#directory, name))
  }

  /** The entry for `key` when present, well-formed and not expired. */
  #live(key: string): Entry | undefined {
    const path = this.#path(key)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
    let value: unknown
    try {
      value = parseJsonSafely(text, { maxDepth: 64, maxKeys: 100_000 })
    } catch {
      return undefined
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const entry = value as Record<string, unknown>
    const raw = entry['expiresAt']
    const expiresAt = typeof raw === 'number' ? raw : raw === null ? null : undefined
    if (entry['key'] !== key || !('value' in entry) || expiresAt === undefined) return undefined
    if (expiresAt !== null && expiresAt <= this.#clock.now()) return undefined
    return { key, value: entry['value'], expiresAt }
  }

  #write(key: string, value: unknown, expiresAt: number | null): void {
    const entry: Entry = { key, value, expiresAt }
    writeFileAtomic(this.#path(key), JSON.stringify(entry), { mode: 0o600 })
  }

  #expiry(ttlSeconds: number | undefined): number | null {
    return ttlSeconds === undefined ? null : this.#clock.now() + ttlSeconds * 1000
  }

  #locked<TResult>(key: string, work: () => TResult): Promise<TResult> {
    return withFileLock(`${this.#path(key)}.lock`, work, this.#lock)
  }

  #path(key: string): string {
    return join(this.#directory, `${createHash('sha256').update(key).digest('hex')}.json`)
  }
}
