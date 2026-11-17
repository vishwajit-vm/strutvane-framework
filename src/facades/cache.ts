/**
 * The `Cache` facade: the current app's cache manager (`config/cache.ts`), Laravel's `Cache::`.
 *
 * @module
 */
import { type CacheManager, CacheManagerToken, type CacheStore } from '../cache/contract.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<CacheManager> = {
  facade: 'Cache',
  token: CacheManagerToken,
  provides: 'the cache manager',
  install:
    'The app binds the cache manager from config/cache.ts when it boots; bind your own with app.container.value(CacheManagerToken, manager).',
}

/**
 * What the `Cache` facade offers: the default store's methods, `remember`, and `store(name)`.
 *
 * @example
 * const cache: CacheFacade = Cache
 */
export interface CacheFacade {
  /** The value, or `undefined` when missing or expired. */
  get(key: string): Promise<unknown>
  /** Whether a live value exists. */
  has(key: string): Promise<boolean>
  /** Store a value (`ttlSeconds` omitted: forever). */
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  /** Store only when absent; `true` when stored. */
  add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>
  /** Add to a counter and return the new value. */
  increment(key: string, by?: number, ttlSeconds?: number): Promise<number>
  /** Subtract from a counter and return the new value. */
  decrement(key: string, by?: number): Promise<number>
  /** The value, then remove it. */
  pull(key: string): Promise<unknown>
  /** Remove one key; `true` when something was removed. */
  forget(key: string): Promise<boolean>
  /** Remove everything in the default store. */
  flush(): Promise<void>
  /** The cached value, or `compute()`'s result stored for `ttlSeconds`. */
  remember<TValue>(
    key: string,
    ttlSeconds: number,
    compute: () => TValue | Promise<TValue>,
  ): Promise<TValue>
  /** The cached value, or `compute()`'s result stored forever. */
  rememberForever<TValue>(key: string, compute: () => TValue | Promise<TValue>): Promise<TValue>
  /** A store by name (the default store when omitted). */
  store(name?: string): CacheStore
}

async function remember<TValue>(
  member: string,
  key: string,
  ttlSeconds: number | undefined,
  compute: () => TValue | Promise<TValue>,
): Promise<TValue> {
  const store = resolveFacade(binding, member).store()
  const cached = await store.get(key)
  // Stored by a remember() call for this key from compute()'s result (JSON values).
  if (cached !== undefined) return cached as TValue
  const value = await compute()
  await store.put(key, value, ttlSeconds)
  return value
}

/**
 * Cache through the current app's default store, or a named one.
 *
 * `remember` is not a lock: two requests that miss at the same moment both compute. Guard with
 * `Cache.add()` when computing twice is harmful. Values are JSON, so a `Date` comes back as a
 * string.
 *
 * @example
 * const stats = await Cache.remember('stats', 60, () => computeStats())
 * await Cache.store('file').forget('stats')
 */
export const Cache: CacheFacade = Object.freeze({
  get: (key: string): Promise<unknown> => resolveFacade(binding, 'get').store().get(key),
  has: (key: string): Promise<boolean> => resolveFacade(binding, 'has').store().has(key),
  put: (key: string, value: unknown, ttlSeconds?: number): Promise<void> =>
    resolveFacade(binding, 'put').store().put(key, value, ttlSeconds),
  add: (key: string, value: unknown, ttlSeconds?: number): Promise<boolean> =>
    resolveFacade(binding, 'add').store().add(key, value, ttlSeconds),
  increment: (key: string, by?: number, ttlSeconds?: number): Promise<number> =>
    resolveFacade(binding, 'increment').store().increment(key, by, ttlSeconds),
  decrement: (key: string, by = 1): Promise<number> =>
    resolveFacade(binding, 'decrement').store().increment(key, -by),
  pull: async (key: string): Promise<unknown> => {
    const store = resolveFacade(binding, 'pull').store()
    const value = await store.get(key)
    await store.forget(key)
    return value
  },
  forget: (key: string): Promise<boolean> => resolveFacade(binding, 'forget').store().forget(key),
  flush: (): Promise<void> => resolveFacade(binding, 'flush').store().flush(),
  remember: <TValue>(
    key: string,
    ttlSeconds: number,
    compute: () => TValue | Promise<TValue>,
  ): Promise<TValue> => remember('remember', key, ttlSeconds, compute),
  rememberForever: <TValue>(
    key: string,
    compute: () => TValue | Promise<TValue>,
  ): Promise<TValue> => remember('rememberForever', key, undefined, compute),
  store: (name?: string): CacheStore => resolveFacade(binding, 'store').store(name),
})
