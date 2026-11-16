/**
 * `node strut cache:clear [--store=file]` and `cache:forget <key> [--store=file]`: the
 * application cache (`CacheManagerToken`; not the bootstrap caches, which `optimize:clear`
 * removes).
 *
 * `cache:clear` empties a whole store, which resets every rate-limit counter and cached value, so
 * outside local and testing environments it needs `--force --i-understand` (the CLI's production
 * guard). A `memory` store lives inside each running process: the command says so instead of
 * pretending to clear it.
 *
 * @module
 */
import type { CacheManager } from '../../../cache/contract.ts'
import { CacheManagerToken } from '../../../cache/contract.ts'
import type { Application } from '../../../foundation/application.ts'
import type { AnyCommand } from '../../framework/command.ts'
import { type AppCommandDeps, BOOT_FLAGS, defineAppCommand, withBootedApp } from './support.ts'

const STORE_FLAG = {
  store: {
    type: 'string',
    valueName: '<name>',
    description: 'The store (default: config/cache.ts default)',
  },
} as const

function managerOf(app: Application): CacheManager {
  return app.make(CacheManagerToken)
}

function memoryNote(name: string): string {
  return `The "${name}" store lives inside each running process; restart the app to empty it there.`
}

/**
 * The `cache:clear` and `cache:forget` commands.
 *
 * @example
 * cacheStoreCommands(DEFAULT_APP_DEPS)
 */
export function cacheStoreCommands(deps: AppCommandDeps): readonly AnyCommand[] {
  return [
    defineAppCommand({
      name: 'cache:clear',
      description: 'Flush the application cache',
      details:
        'Unless APP_ENV is local, test, testing or development this needs --force --i-understand: it resets rate limits too.',
      requiresProject: false,
      flags: { ...BOOT_FLAGS, ...STORE_FLAG },
      examples: ['node strut cache:clear', 'node strut cache:clear --store=file'],
      async run(ctx) {
        ctx.guardDestructive()
        const name = await withBootedApp(ctx, deps, async (app) => {
          const manager = managerOf(app)
          const chosen = ctx.flags.store ?? manager.defaultStore
          await manager.store(chosen).flush()
          return chosen
        })
        ctx.out.success(`Application cache cleared (the "${name}" store).`)
        if (name === 'memory') ctx.out.info(memoryNote(name))
        return { data: { store: name, cleared: true } }
      },
    }),
    defineAppCommand({
      name: 'cache:forget',
      description: 'Remove one key from the application cache',
      requiresProject: false,
      args: { key: { required: true, description: 'The cache key' } },
      flags: { ...BOOT_FLAGS, ...STORE_FLAG },
      examples: ['node strut cache:forget stats', 'node strut cache:forget stats --store=file'],
      async run(ctx) {
        const { key } = ctx.args
        const result = await withBootedApp(ctx, deps, async (app) => {
          const manager = managerOf(app)
          const name = ctx.flags.store ?? manager.defaultStore
          return { name, removed: await manager.store(name).forget(key) }
        })
        if (result.removed) ctx.out.success(`Removed "${key}" from the "${result.name}" store.`)
        else ctx.out.line(`  "${key}" was not in the "${result.name}" store.`)
        return { data: { store: result.name, key, removed: result.removed } }
      },
    }),
  ]
}
