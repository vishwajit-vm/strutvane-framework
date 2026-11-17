/**
 * The cache manager: named stores from `config/cache.ts`, bound as the default
 * `CacheManagerToken` (a provider's own binding, such as the Redis package's, wins).
 *
 * ```ts
 * // config/cache.ts
 * export default defineConfig((env) => ({
 *   default: env.string('CACHE_STORE', 'file'),
 *   stores: { file: { driver: 'file' }, memory: { driver: 'memory' } },
 * }))
 * ```
 *
 * Two drivers ship today:
 * - `memory`: one process, bounded (the framework's `MemoryCacheStore`); the default without a
 *   config file, and what tests use;
 * - `file`: `storage/framework/cache` (or `path`), shared by every process on one machine, with
 *   atomic `add`/`increment` across processes (`FileCacheStore`).
 *
 * Both names always exist (a config can repoint them); the database and `@strutvane/redis` stores
 * come in 0.3. Stores are created on first use, so an app that never touches the file store never
 * creates its folder. A bad config (unknown driver, a default that names no store) stops boot with
 * a friendly error instead of failing on the first cache call.
 *
 * @module
 */
import { isAbsolute, join } from 'node:path'
import type { Clock } from '../core/clock.ts'
import { BootError } from '../foundation/boot-error.ts'
import { MemoryCacheStore } from '../http/app/memory-cache.ts'
import { closestMatch } from '../support/str.ts'
import type { CacheManager, CacheStore } from './contract.ts'
import { FILE_CACHE_FOLDER, FileCacheStore } from './file-store.ts'

export { MemoryCacheStore } from '../http/app/memory-cache.ts'
export { FILE_CACHE_FOLDER, FileCacheStore } from './file-store.ts'

/**
 * The drivers a store can use.
 *
 * @example
 * const driver: CacheDriver = 'file'
 */
export type CacheDriver = 'memory' | 'file'

const DRIVERS: readonly CacheDriver[] = ['memory', 'file']

/**
 * One store in `config/cache.ts`.
 *
 * @example
 * const store: CacheStoreConfig = { driver: 'file', path: 'storage/framework/cache' }
 */
export interface CacheStoreConfig {
  readonly driver: CacheDriver
  /** File stores only: the folder, relative to the app (or absolute). */
  readonly path?: string
}

/**
 * The shape of `config/cache.ts`.
 *
 * @example
 * const cache: CacheConfig = { default: 'file', stores: { file: { driver: 'file' } } }
 */
export interface CacheConfig {
  /** The default store's name. Default `memory`. */
  readonly default?: string
  readonly stores?: Readonly<Record<string, CacheStoreConfig>>
}

/**
 * What {@link createCacheManager} needs.
 *
 * @example
 * createCacheManager({ basePath: '/srv/blog', clock, config: app.config('cache') })
 */
export interface CacheManagerOptions {
  /** The app root: relative file-store paths resolve against it. */
  readonly basePath: string
  /** The app's clock, for expiry. */
  readonly clock: Clock
  /** The `cache` config tree (unchecked: it is validated here). Omitted means the defaults. */
  readonly config?: unknown
}

/**
 * The built-in cache manager.
 *
 * @example
 * const manager = new StoreCacheManager(new Map([['memory', () => store]]), 'memory')
 * await manager.store().put('k', 1)
 */
export class StoreCacheManager implements CacheManager {
  readonly defaultStore: string
  readonly #factories: ReadonlyMap<string, () => CacheStore>
  readonly #stores = new Map<string, CacheStore>()

  constructor(factories: ReadonlyMap<string, () => CacheStore>, defaultStore: string) {
    if (!factories.has(defaultStore)) throw unknownStore(defaultStore, [...factories.keys()])
    this.#factories = factories
    this.defaultStore = defaultStore
  }

  get storeNames(): readonly string[] {
    return [...this.#factories.keys()].sort()
  }

  store(name: string = this.defaultStore): CacheStore {
    const existing = this.#stores.get(name)
    if (existing !== undefined) return existing
    const factory = this.#factories.get(name)
    if (factory === undefined) throw unknownStore(name, this.storeNames)
    const created = factory()
    this.#stores.set(name, created)
    return created
  }
}

/**
 * Build the cache manager from the `cache` config tree, checking it.
 *
 * @example
 * const manager = createCacheManager({ basePath, clock, config: { default: 'file' } })
 * manager.store('file') // FileCacheStore in storage/framework/cache
 */
export function createCacheManager(options: CacheManagerOptions): CacheManager {
  const config = readConfig(options.config)
  const stores: Record<string, CacheStoreConfig> = {
    memory: { driver: 'memory' },
    file: { driver: 'file' },
    ...config.stores,
  }
  const factories = new Map<string, () => CacheStore>()
  for (const [name, store] of Object.entries(stores))
    factories.set(name, () =>
      store.driver === 'memory'
        ? new MemoryCacheStore({ clock: options.clock })
        : new FileCacheStore({
            directory: folder(options.basePath, store.path ?? FILE_CACHE_FOLDER),
            clock: options.clock,
          }),
    )
  return new StoreCacheManager(factories, config.default ?? 'memory')
}

function folder(basePath: string, path: string): string {
  return isAbsolute(path) ? path : join(basePath, path)
}

/** Check the config tree (it came from app code, typed or not). */
function readConfig(value: unknown): CacheConfig {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidConfig('config/cache.ts must export an object such as { default, stores }.')
  const record = value as Record<string, unknown>
  const name = record['default']
  if (name !== undefined && typeof name !== 'string')
    throw invalidConfig('cache.default must be a store name.')
  const raw = record['stores']
  if (raw === undefined) return name === undefined ? {} : { default: name }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw invalidConfig('cache.stores must map store names to { driver }.')
  const stores: Record<string, CacheStoreConfig> = {}
  for (const [store, entry] of Object.entries(raw)) {
    const driver =
      typeof entry === 'object' && entry !== null ? (entry as { driver?: unknown }).driver : entry
    const path =
      typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined
    if (!DRIVERS.includes(driver as CacheDriver))
      throw new BootError(
        'unknown_cache_driver',
        `The "${store}" cache store uses the driver ${JSON.stringify(driver) ?? 'undefined'}, which doesn't exist.`,
        'Use "memory" or "file". Database and Redis stores come in 0.3 (@strutvane/redis).',
      )
    if (path !== undefined && (typeof path !== 'string' || path.trim() === ''))
      throw invalidConfig(`cache.stores.${store}.path must be a folder path.`)
    stores[store] = { driver: driver as CacheDriver, ...(path === undefined ? {} : { path }) }
  }
  return { ...(name === undefined ? {} : { default: name }), stores }
}

function invalidConfig(message: string): BootError {
  return new BootError(
    'invalid_cache_config',
    message,
    "Example: defineConfig((env) => ({ default: env.string('CACHE_STORE', 'file'), stores: { file: { driver: 'file' } } }))",
  )
}

function unknownStore(name: string, names: readonly string[]): BootError {
  const suggestion = closestMatch(name, names)
  return new BootError(
    'unknown_cache_store',
    `There is no "${name}" cache store.`,
    suggestion === undefined
      ? `The stores are: ${names.join(', ')} (config/cache.ts).`
      : `Did you mean "${suggestion}"?`,
  )
}
