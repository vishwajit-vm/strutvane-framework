/**
 * A small in-memory {@link CacheStore}: the rate limiter's counter store when the app binds no
 * cache (`CacheManagerToken`). One process only; clusters bind the cache package's shared store.
 *
 * Bounded: expired entries are dropped when touched and swept when the store is full, and the
 * oldest entries go first after that, so a flood of distinct keys (rotating addresses) can't grow
 * memory without limit.
 *
 * @module
 */
import type { CacheStore } from '../../cache/contract.ts'
import type { Clock } from '../../core/clock.ts'

interface Entry {
  value: unknown
  expiresAt: number | undefined
}

/**
 * The in-memory cache store.
 *
 * @example
 * const store = new MemoryCacheStore({ now: () => clock.now() })
 * await store.increment('throttle:api:ip:203.0.113.7', 1, 60) // 1
 */
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, Entry>()
  readonly #clock: Clock
  readonly #max: number

  constructor(options: { readonly clock: Clock; readonly maxEntries?: number }) {
    this.#clock = options.clock
    this.#max = options.maxEntries ?? 100_000
  }

  async get(key: string): Promise<unknown> {
    return this.#live(key)?.value
  }

  async has(key: string): Promise<boolean> {
    return this.#live(key) !== undefined
  }

  async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.#set(key, value, ttlSeconds)
  }

  async add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    if (this.#live(key) !== undefined) return false
    this.#set(key, value, ttlSeconds)
    return true
  }

  async increment(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    const entry = this.#live(key)
    if (entry === undefined || typeof entry.value !== 'number') {
      this.#set(key, by, ttlSeconds)
      return by
    }
    // Fixed windows: an existing counter keeps its expiry.
    entry.value += by
    return entry.value
  }

  async ttl(key: string): Promise<number | undefined> {
    const entry = this.#live(key)
    if (entry?.expiresAt === undefined) return undefined
    return Math.max(0, Math.ceil((entry.expiresAt - this.#clock.now()) / 1000))
  }

  async forget(key: string): Promise<boolean> {
    return this.#entries.delete(key)
  }

  async flush(): Promise<void> {
    this.#entries.clear()
  }

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.#clock.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry
  }

  #set(key: string, value: unknown, ttlSeconds: number | undefined): void {
    this.#entries.delete(key)
    this.#makeRoom()
    this.#entries.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? undefined : this.#clock.now() + ttlSeconds * 1000,
    })
  }

  #makeRoom(): void {
    if (this.#entries.size < this.#max) return
    const now = this.#clock.now()
    for (const [key, entry] of this.#entries)
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.#entries.delete(key)
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < this.#max) break
      this.#entries.delete(key)
    }
  }
}
