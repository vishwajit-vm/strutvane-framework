/**
 * The Laravel-style app commands of `node strut`: the `optimize` family, the application cache,
 * key rotation, env encryption, maintenance mode, `session:flush`, `security:check`,
 * `route:list` and the `make:command`/`make:rule`/`make:observer` generators.
 *
 * They work on an app (`bootstrap/app.ts`), found at or above the working directory. Commands
 * that need the running app load it through {@link AppCommandDeps} (the real loader by default),
 * so tests can hand them an app they built.
 *
 * @module
 */
import type { AnyCommand } from '../../framework/command.ts'
import { bootstrapCacheCommands } from './bootstrap-caches.ts'
import { cacheStoreCommands } from './cache-store.ts'
import { envCryptCommands } from './env-crypt.ts'
import { eventListCommand } from './event-list.ts'
import { keyRotateCommand } from './key-rotate.ts'
import { maintenanceCommands } from './maintenance.ts'
import { appMakeCommands } from './make.ts'
import { routeListCommand } from './route-list.ts'
import { securityCheckCommand } from './security-check.ts'
import { sessionFlushCommand } from './session-flush.ts'
import { type AppCommandDeps, DEFAULT_APP_DEPS } from './support.ts'

export type { AppCommandDeps } from './support.ts'
export { DEFAULT_APP_DEPS } from './support.ts'

/**
 * Build every app command with the given dependencies.
 *
 * @example
 * const commands = createAppCommands({ load: async () => testApp })
 */
export function createAppCommands(deps: AppCommandDeps = DEFAULT_APP_DEPS): readonly AnyCommand[] {
  return Object.freeze([
    ...bootstrapCacheCommands(deps),
    eventListCommand(deps),
    ...cacheStoreCommands(deps),
    keyRotateCommand(),
    ...envCryptCommands(),
    ...maintenanceCommands(deps),
    sessionFlushCommand(deps),
    securityCheckCommand(deps),
    routeListCommand(deps),
    ...appMakeCommands(),
  ])
}

/**
 * The app commands `node strut` ships with (spread into `BUILTIN_COMMANDS`).
 *
 * @example
 * APP_COMMANDS.map((command) => command.name) // ['config:cache', 'config:clear', …]
 */
export const APP_COMMANDS: readonly AnyCommand[] = createAppCommands()
