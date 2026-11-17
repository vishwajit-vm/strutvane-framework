/**
 * `node strut event:list`: every event and its listeners (discovered in `app/listeners`, read from
 * the events cache, or registered by a provider), Laravel's `php artisan event:list`.
 *
 * @module
 */
import type { AnyCommand } from '../../framework/command.ts'
import { type AppCommandDeps, BOOT_FLAGS, defineAppCommand, withBootedApp } from './support.ts'

/**
 * The `event:list` command.
 *
 * @example
 * eventListCommand(DEFAULT_APP_DEPS)
 */
export function eventListCommand(deps: AppCommandDeps): AnyCommand {
  return defineAppCommand({
    name: 'event:list',
    description: 'List every event and its listeners',
    requiresProject: false,
    flags: {
      ...BOOT_FLAGS,
      event: { type: 'string', valueName: '<text>', description: 'Only events containing this' },
    },
    examples: ['node strut event:list', 'node strut event:list --event post --json'],
    async run(ctx) {
      const filter = ctx.flags.event
      const events = await withBootedApp(ctx, deps, (app) =>
        app.events.list().filter((entry) => filter === undefined || entry.event.includes(filter)),
      )
      if (events.length === 0)
        ctx.out.line('  No listeners. Add a *.listener.ts file in app/listeners.')
      else
        ctx.out.table(
          ['Event', 'Listeners'],
          events.map((entry) => [entry.event, entry.listeners.join(', ')]),
        )
      return { data: { events } }
    },
  })
}
