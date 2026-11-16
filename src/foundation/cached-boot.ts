/**
 * How boot uses the bootstrap caches (see `bootstrap-cache.ts`), kept out of the application
 * class so each rule is small and testable:
 *
 * - **config:** a valid cache replaces running the config files against the environment (only
 *   `APP_KEY`/`APP_PREVIOUS_KEYS` are read, to open the cache). As in Laravel, changing `.env`
 *   then needs `config:cache` again.
 * - **routes:** routes are always compiled from the routes files (they hold the controller
 *   classes), but when the cache's manifest matches the compiled table, the expensive boot checks
 *   (building every controller, discovering policies, bindings) are skipped: the cache records
 *   that this exact table, from this exact code, already passed them.
 * - **events:** a valid cache replaces scanning `app/listeners`.
 *
 * The code fingerprint is computed at most once per boot, and only if a cache file exists.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { Logger } from '../contracts/logger.ts'
import type { ResolvedRouteMiddleware } from '../http/app/route-middleware.ts'
import { actionLabel, type CompiledRoute } from '../routing/router.ts'
import { Keyring } from '../security/keyring.ts'
import { type CacheUse, readCache } from './bootstrap-cache.ts'
import { type ConfigFiles, ConfigRepository, loadConfig } from './config.ts'
import type { EnvSource } from './env.ts'
import { codeFingerprint } from './fingerprint.ts'
import { discoverListeners, isListenerList, type ListenerEntry } from './listeners.ts'

/**
 * Load config from the cache when valid, else from the config files.
 *
 * @example
 * const { config, use } = loadConfigWithCache(basePath, files, source, logger, fingerprintOnce(basePath))
 */
export function loadConfigWithCache(
  basePath: string,
  files: ConfigFiles,
  source: EnvSource,
  logger: Pick<Logger, 'warn'>,
  fingerprint: () => string,
): { readonly config: ConfigRepository; readonly use: CacheUse } {
  const keyring = keyringFrom(source)
  if (keyring !== undefined) {
    const cached = readCache(basePath, 'config', keyring, logger, fingerprint)
    if (
      cached.use === 'used' &&
      typeof cached.payload === 'object' &&
      cached.payload !== null &&
      !Array.isArray(cached.payload)
    )
      return {
        config: new ConfigRepository(
          decodeConfigTree(cached.payload) as Readonly<Record<string, unknown>>,
        ),
        use: 'used',
      }
    if (cached.use !== 'none') return { config: loadConfig(files, source), use: 'ignored' }
  }
  return { config: loadConfig(files, source), use: 'none' }
}

/**
 * The code fingerprint, computed at most once per boot and only when asked.
 *
 * @example
 * const fingerprint = fingerprintOnce('/srv/blog')
 */
export function fingerprintOnce(basePath: string): () => string {
  let value: string | undefined
  return () => {
    value ??= codeFingerprint(basePath)
    return value
  }
}

/** Stands in for `undefined` in the config cache: JSON would drop the key, and `config()` would then throw for it. */
const UNDEFINED = Object.freeze({ $strutvane: 'undefined' })

/**
 * Prepare a config tree for JSON: `undefined` values (optional env vars that are not set) become
 * a marker, so the cached tree has exactly the same keys as the live one (spike 12 finding 11).
 *
 * @example
 * encodeConfigTree({ db: { password: undefined } }) // { db: { password: { $strutvane: 'undefined' } } }
 */
export function encodeConfigTree(value: unknown): unknown {
  if (value === undefined) return UNDEFINED
  if (Array.isArray(value)) return value.map(encodeConfigTree)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeConfigTree(item)]),
    )
  return value
}

/**
 * Undo {@link encodeConfigTree}.
 *
 * @example
 * decodeConfigTree({ password: { $strutvane: 'undefined' } }) // { password: undefined }
 */
export function decodeConfigTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeConfigTree)
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    if (
      keys.length === 1 &&
      keys[0] === '$strutvane' &&
      (value as { $strutvane: unknown }).$strutvane === 'undefined'
    )
      return undefined
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeConfigTree(item)]),
    )
  }
  return value
}

/** The cache keyring straight from the environment; a broken key means "no cache" (boot then fails on it). */
function keyringFrom(source: EnvSource): Keyring | undefined {
  try {
    return Keyring.from(source['APP_KEY'], source['APP_PREVIOUS_KEYS'] ?? '')
  } catch {
    return undefined
  }
}

/**
 * The route table as plain data: what `route:cache` stores and boot compares.
 *
 * @example
 * routeManifest(app.routes, (route) => app.routeMiddleware(route))
 */
export function routeManifest(
  routes: readonly CompiledRoute[],
  middleware: (route: CompiledRoute) => ResolvedRouteMiddleware,
): { readonly hash: string; readonly routes: readonly Record<string, unknown>[] } {
  const rows = routes.map((route) => ({
    methods: route.methods,
    uri: route.uri,
    name: route.name ?? null,
    action: actionLabel(route.action),
    middleware: middleware(route).references.map((reference) =>
      [reference.alias, ...reference.params].join(':'),
    ),
    optOuts: middleware(route).optOuts,
  }))
  return {
    hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    routes: rows,
  }
}

/**
 * Decide whether the route checks can be skipped: the cache is valid and describes exactly the
 * table that was just compiled.
 *
 * @example
 * const use = routeCacheUse(basePath, keyring, logger, manifest.hash, fingerprint)
 */
export function routeCacheUse(
  basePath: string,
  keyring: Keyring,
  logger: Pick<Logger, 'warn'>,
  liveHash: string,
  fingerprint: () => string,
): CacheUse {
  const cached = readCache(basePath, 'routes', keyring, logger, fingerprint)
  if (cached.use !== 'used') return cached.use
  const payload = cached.payload
  const hash =
    typeof payload === 'object' && payload !== null && 'hash' in payload ? payload.hash : undefined
  if (hash === liveHash) return 'used'
  logger.warn(
    'Ignoring bootstrap/cache/routes.json: the routes changed since it was built. Run `node strut route:cache` again.',
  )
  return 'ignored'
}

/**
 * The listeners: from the events cache when valid, else by scanning `app/listeners`.
 *
 * @example
 * const { entries, use } = await loadListeners(basePath, keyring, logger, fingerprint)
 */
export async function loadListeners(
  basePath: string,
  keyring: Keyring,
  logger: Pick<Logger, 'warn'>,
  fingerprint: () => string,
): Promise<{ readonly entries: readonly ListenerEntry[]; readonly use: CacheUse }> {
  const cached = readCache(basePath, 'events', keyring, logger, fingerprint)
  if (cached.use === 'used' && isListenerList(cached.payload))
    return { entries: cached.payload, use: 'used' }
  if (cached.use === 'used')
    logger.warn(
      'Ignoring bootstrap/cache/events.json: its listener list is malformed. Run `node strut event:cache` again.',
    )
  return {
    entries: await discoverListeners(basePath),
    use: cached.use === 'none' ? 'none' : 'ignored',
  }
}
