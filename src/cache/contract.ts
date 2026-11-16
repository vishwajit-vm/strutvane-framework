/**
 * The cache contract: what `Cache`, the rate limiter (CONSISTENCY #21: limits live in the cache so
 * they hold across processes) and `node strut cache:clear` talk to.
 *
 * Stores are swappable behind {@link CacheStore}: memory (one process, the test default), file
 * (`storage/framework/cache`, shared by every process on one machine) and, from 0.3, the database
 * and `@strutvane/redis`. The manager picks one by name (`cache:clear --store=file`).
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'

/**
 * One cache store. Values are JSON-serialisable; `ttlSeconds` omitted means "forever".
 *
 * @example
 * await store.put('stats', { posts: 3 }, 60)
 */
export interface CacheStore {
  /** The value, or `undefined` when missing or expired. */
  get(key: string): Promise<unknown>
  /** Whether a live value exists. */
  has(key: string): Promise<boolean>
  /** Store a value. */
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  /** Store only when absent (atomic within the store); `true` when stored. */
  add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>
  /**
   * Add `by` to a counter (atomic within the store) and return the new value. A missing or expired
   * counter starts at 0 and gets `ttlSeconds`; an existing one keeps its expiry (fixed windows).
   */
  increment(key: string, by?: number, ttlSeconds?: number): Promise<number>
  /** Seconds until `key` expires, `undefined` when missing or without expiry. */
  ttl(key: string): Promise<number | undefined>
  /** Remove one key; `true` when something was removed. */
  forget(key: string): Promise<boolean>
  /** Remove everything in this store. */
  flush(): Promise<void>
}

/**
 * The cache manager: named stores plus the default one.
 *
 * @example
 * await app.make(CacheManagerToken).store('file').flush()
 */
export interface CacheManager {
  /** The default store's name (`config/cache.ts` `default`, else `memory`). */
  readonly defaultStore: string
  /** Every configured store name. */
  readonly storeNames: readonly string[]
  /** A store by name (default store when omitted); throws a friendly error for unknown names. */
  store(name?: string): CacheStore
}

/**
 * The container token for the cache manager.
 *
 * @example
 * app.make(CacheManagerToken).store()
 */
export const CacheManagerToken: Token<CacheManager> = token<CacheManager>('strutvane.cache')
