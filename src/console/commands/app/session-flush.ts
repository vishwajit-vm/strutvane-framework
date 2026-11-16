/**
 * `node strut session:flush`: delete every session, which signs everyone out. For incidents (a
 * leaked session store, a compromised admin account). API tokens are separate: the auth package
 * revokes those.
 *
 * Destructive: it needs its exact name, and outside local and testing environments
 * `--force --i-understand`.
 *
 * @module
 */
import { SessionStoreToken } from '../../../session/contract.ts'
import type { AnyCommand } from '../../framework/command.ts'
import {
  type AppCommandDeps,
  BOOT_FLAGS,
  defineAppCommand,
  plural,
  withBootedApp,
} from './support.ts'

/**
 * The `session:flush` command.
 *
 * @example
 * sessionFlushCommand(DEFAULT_APP_DEPS)
 */
export function sessionFlushCommand(deps: AppCommandDeps): AnyCommand {
  return defineAppCommand({
    name: 'session:flush',
    description: 'Delete every session (signs everyone out)',
    details:
      "Uses the app's session store (the auth package's, or storage/framework/sessions). API tokens are not affected.",
    requiresProject: false,
    destructive: true,
    flags: BOOT_FLAGS,
    examples: ['node strut session:flush', 'node strut session:flush --force --i-understand'],
    async run(ctx) {
      const removed = await withBootedApp(ctx, deps, (app) => app.make(SessionStoreToken).flush())
      ctx.out.success(
        `${plural(removed, 'session')} deleted. Everyone signed in with a session must sign in again.`,
      )
      ctx.out.info('API tokens are not affected; revoke them with the auth package.')
      return { data: { removed } }
    },
  })
}
