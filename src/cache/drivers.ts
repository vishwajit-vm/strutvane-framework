/**
 * Cache drivers from packages, Laravel's `Cache::extend('redis', …)`: a package registers a
 * driver name and a factory in its provider's `register()`, and any store in `config/cache.ts`
 * can then say `{ driver: 'redis', connection: 'cache' }`.
 *
 * ```ts
 * override register(app: Application): void {
 *   app.make(CacheDriverRegistryToken).extend('redis', (store, { name }) => new RedisCacheStore(name, store))
 * }
 * ```
 *
 * **Why a registry instead of replacing the whole manager:** the built-in manager validates
 * `config/cache.ts`, creates stores lazily and keeps `cache:clear --store=<name>` working. A
 * package that rebinds `CacheManagerToken` has to redo all of that; a driver factory only builds
 * one store.
 *
 * Failure scenarios (each a `BootError` that names the fix):
 * - a driver name that isn't lowercase letters, digits, `-` or `_`;
 * - a package trying to replace `memory` or `file`, or two packages claiming the same name
 *   (silently swapping a store would change where data goes);
 * - a driver registered after the cache manager was built (`register()` is the place).
 *
 * @module
 */
import type { Clock } from '../core/clock.ts'
import { type Token, token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'
import type { CacheStore } from './contract.ts'

/**
 * What a driver factory gets besides the store's own settings.
 *
 * @example
 * const context: CacheDriverContext = { store: 'redis', basePath: '/srv/blog', clock: systemClock }
 */
export interface CacheDriverContext {
  /** The store's name in `config/cache.ts` (`stores.<name>`). */
  readonly store: string
  /** The app root, for drivers that keep files. */
  readonly basePath: string
  /** The app's clock (expiry). */
  readonly clock: Clock
}

/**
 * Builds one store from its `config/cache.ts` entry (every key of the entry, `driver` included;
 * unchecked: validate what you read). Called once, the first time the store is used.
 *
 * @example
 * const factory: CacheDriverFactory = (store, { clock }) => new MemoryCacheStore({ clock })
 */
export type CacheDriverFactory = (
  config: Readonly<Record<string, unknown>>,
  context: CacheDriverContext,
) => CacheStore

/** The drivers the framework ships; packages can't take these names. */
export const BUILT_IN_CACHE_DRIVERS: readonly string[] = Object.freeze(['memory', 'file'])

const DRIVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/

/**
 * The cache drivers packages added. One per app (the container token below).
 *
 * @example
 * registry.extend('redis', (store, context) => new RedisCacheStore(store, context))
 */
export class CacheDriverRegistry {
  readonly #factories = new Map<string, CacheDriverFactory>()
  #sealed = false

  /**
   * Add a driver. Call it in a provider's `register()`.
   *
   * @example
   * app.make(CacheDriverRegistryToken).extend('redis', factory)
   */
  extend(driver: string, factory: CacheDriverFactory): this {
    if (!DRIVER_NAME.test(driver))
      throw new BootError(
        'invalid_cache_driver_name',
        `"${driver.slice(0, 80)}" is not a valid cache driver name.`,
        'Use lowercase letters, digits, "-" or "_", starting with a letter (for example "redis").',
      )
    if (typeof factory !== 'function')
      throw new BootError(
        'invalid_cache_driver',
        `The cache driver "${driver}" was registered without a factory function.`,
        'Pass (store, context) => CacheStore as the second argument.',
      )
    if (BUILT_IN_CACHE_DRIVERS.includes(driver) || this.#factories.has(driver))
      throw new BootError(
        'duplicate_cache_driver',
        `The cache driver "${driver}" already exists.`,
        BUILT_IN_CACHE_DRIVERS.includes(driver)
          ? 'The memory and file drivers are built in; give your driver its own name.'
          : 'Two providers registered the same driver. Keep one of them in bootstrap/providers.ts.',
      )
    if (this.#sealed)
      throw new BootError(
        'cache_driver_after_boot',
        `The cache driver "${driver}" was registered after the cache manager was built.`,
        "Register cache drivers in a provider's register() method.",
      )
    this.#factories.set(driver, factory)
    return this
  }

  /** The registered drivers, by name. */
  get factories(): ReadonlyMap<string, CacheDriverFactory> {
    return this.#factories
  }

  /** Refuse further drivers (the app calls this when it builds the cache manager). */
  seal(): void {
    this.#sealed = true
  }
}

/**
 * The container token for the app's cache driver registry. Bound when the app is created, so
 * providers can use it in `register()`.
 *
 * @example
 * app.make(CacheDriverRegistryToken).extend('redis', factory)
 */
export const CacheDriverRegistryToken: Token<CacheDriverRegistry> =
  token<CacheDriverRegistry>('strutvane.cache.drivers')
