/**
 * The `optimize` family, like artisan's: `config:cache`/`config:clear`, `route:cache`/
 * `route:clear`, `event:cache`/`event:clear`, and `optimize`/`optimize:clear` for all three.
 *
 * Every cache (`bootstrap/cache/<kind>.json`, see `foundation/bootstrap-cache.ts`) is encrypted
 * with an `APP_KEY` subkey and stamped with the code fingerprint, so a cache built with another
 * key, from other code, or edited by hand is ignored at boot with a warning, never silently used.
 *
 * **Why the old cache is removed before building:** a build boots the app, and a boot that used
 * the old cache would skip the route checks or read stale config. Clearing first means a cache is
 * only ever written from a fresh boot whose every start-up check passed.
 *
 * The `:clear` commands don't load the app at all, so they work even when the code can't boot
 * (the usual reason to clear a cache).
 *
 * @module
 */
import type { Application } from '../../../foundation/application.ts'
import { BootError } from '../../../foundation/boot-error.ts'
import { type CacheKind, clearCache, writeCache } from '../../../foundation/bootstrap-cache.ts'
import { encodeConfigTree, routeManifest } from '../../../foundation/cached-boot.ts'
import { discoverListeners } from '../../../foundation/listeners.ts'
import { KeyringToken } from '../../../security/keyring.ts'
import type { AnyCommand, CommandContext } from '../../framework/command.ts'
import {
  type AppCommandDeps,
  appRoot,
  BOOT_FLAGS,
  defineAppCommand,
  plural,
  withBootedApp,
} from './support.ts'

/** Labels and file names, per cache. */
const LABELS: Readonly<Record<CacheKind, string>> = {
  config: 'Configuration',
  routes: 'Route',
  events: 'Event',
}

/**
 * Refuse config that JSON can't hold exactly (functions, `NaN`, class instances, symbols): cached,
 * it would come back different and the app would behave differently from its files.
 *
 * @example
 * assertCacheable({ app: { name: 'Blog' } }, '') // fine
 * assertCacheable({ hooks: { onBoot: () => 1 } }, '') // throws config_not_cacheable
 */
export function assertCacheable(value: unknown, path: string): void {
  // `undefined` (an optional env var that is not set) is kept by encodeConfigTree.
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertCacheable(item, `${path}.${index}`)
    })
    return
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value))
      assertCacheable(item, path === '' ? key : `${path}.${key}`)
    return
  }
  const kind =
    typeof value === 'object' ? 'class instance' : typeof value === 'number' ? 'NaN' : typeof value
  throw new BootError(
    'config_not_cacheable',
    `config("${path}") is a ${kind}, which can't be cached.`,
    'Config values must be plain data (strings, numbers, booleans, arrays, objects). Move code into a provider.',
  )
}

/** Write the config cache from the real config files (never from a cache). */
function cacheConfig(app: Application, now: Date): void {
  const config = app.loadFreshConfig()
  assertCacheable(config.all, '')
  writeCache(app.basePath, 'config', app.make(KeyringToken), encodeConfigTree(config.all), now)
}

/** Write the route cache from the booted app's checked route table. */
function cacheRoutes(app: Application, now: Date): number {
  const manifest = routeManifest(app.routes, (route) => app.routeMiddleware(route))
  writeCache(app.basePath, 'routes', app.make(KeyringToken), manifest, now)
  return manifest.routes.length
}

/** Scan app/listeners and write the events cache. */
async function cacheEvents(app: Application, now: Date): Promise<number> {
  const entries = await discoverListeners(app.basePath)
  writeCache(app.basePath, 'events', app.make(KeyringToken), entries, now)
  return entries.length
}

/** Remove one cache and say so. */
function clearOne(ctx: CommandContext, root: string, kind: CacheKind): boolean {
  const removed = clearCache(root, kind)
  if (removed) ctx.out.success(`${LABELS[kind]} cache cleared (bootstrap/cache/${kind}.json).`)
  else ctx.out.line(`  ${LABELS[kind]} cache was not cached.`)
  return removed
}

/** One `<kind>:cache` command. */
function cacheCommand(
  deps: AppCommandDeps,
  name: string,
  kind: CacheKind,
  description: string,
  build: (app: Application, now: Date) => number | Promise<number> | undefined,
  details: string,
): AnyCommand {
  return defineAppCommand({
    name,
    description,
    details,
    requiresProject: false,
    flags: BOOT_FLAGS,
    examples: [`node strut ${name}`],
    async run(ctx) {
      clearCache(appRoot(ctx), kind)
      const count = await withBootedApp(ctx, deps, (app) =>
        build(app, new Date(ctx.services.clock.now())),
      )
      const what =
        kind === 'config'
          ? 'Configuration'
          : plural(count ?? 0, kind === 'routes' ? 'route' : 'listener')
      ctx.out.success(
        `${what} cached (bootstrap/cache/${kind}.json, encrypted with an APP_KEY subkey).`,
      )
      return { data: { cached: kind, ...(count === undefined ? {} : { count }) } }
    },
  })
}

/** One `<kind>:clear` command. */
function clearCommand(name: string, kind: CacheKind): AnyCommand {
  return defineAppCommand({
    name,
    description: `Remove the ${LABELS[kind].toLowerCase()} cache`,
    requiresProject: false,
    examples: [`node strut ${name}`],
    run(ctx) {
      return { data: { cleared: kind, removed: clearOne(ctx, appRoot(ctx), kind) } }
    },
  })
}

/**
 * The bootstrap cache commands.
 *
 * @example
 * const commands = bootstrapCacheCommands(DEFAULT_APP_DEPS) // config:cache … optimize:clear
 */
export function bootstrapCacheCommands(deps: AppCommandDeps): readonly AnyCommand[] {
  return [
    cacheCommand(
      deps,
      'config:cache',
      'config',
      'Cache the configuration (encrypted with APP_KEY)',
      (app, now) => {
        cacheConfig(app, now)
        return undefined
      },
      'After this, changes to .env are not seen until you run node strut config:cache again (or node strut config:clear). Secrets in the config are never written in plain text.',
    ),
    clearCommand('config:clear', 'config'),
    cacheCommand(
      deps,
      'route:cache',
      'routes',
      'Cache the checked route table so boot can skip the route checks',
      cacheRoutes,
      'The cache records that this exact route table, from this exact code, passed every start-up check. A changed table or code makes boot ignore it with a warning.',
    ),
    clearCommand('route:clear', 'routes'),
    cacheCommand(
      deps,
      'event:cache',
      'events',
      'Discover listeners in app/listeners and cache the list',
      cacheEvents,
      'Production then skips scanning app/listeners at boot. Run it again after adding or moving a listener (node strut optimize does).',
    ),
    clearCommand('event:clear', 'events'),
    defineAppCommand({
      name: 'optimize',
      description: 'Cache the config, routes and events in one go',
      details: 'Run it on every deploy. The application cache is separate: node strut cache:clear.',
      requiresProject: false,
      flags: BOOT_FLAGS,
      examples: ['node strut optimize'],
      async run(ctx) {
        const root = appRoot(ctx)
        for (const kind of ['config', 'routes', 'events'] as const) clearCache(root, kind)
        const now = new Date(ctx.services.clock.now())
        const counts = await withBootedApp(ctx, deps, async (app) => {
          cacheConfig(app, now)
          return { routes: cacheRoutes(app, now), listeners: await cacheEvents(app, now) }
        })
        ctx.out.success(
          `Cached: configuration, ${plural(counts.routes, 'route')}, ${plural(counts.listeners, 'listener')}.`,
        )
        return { data: { cached: ['config', 'routes', 'events'], ...counts } }
      },
    }),
    defineAppCommand({
      name: 'optimize:clear',
      description: 'Remove every bootstrap cache (config, routes, events)',
      details: 'The application cache is separate: node strut cache:clear.',
      requiresProject: false,
      examples: ['node strut optimize:clear'],
      run(ctx) {
        const root = appRoot(ctx)
        const removed = (['config', 'routes', 'events'] as const).filter((kind) =>
          clearOne(ctx, root, kind),
        )
        return { data: { cleared: removed } }
      },
    }),
  ]
}
