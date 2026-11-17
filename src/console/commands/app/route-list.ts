/**
 * `node strut route:list`: every route of the app with its method, URI, name, action and
 * middleware, Laravel's `php artisan route:list`. Booting first means a broken route (unknown
 * middleware, a missing binding, a resource without a policy) fails here, before any request.
 *
 * `--security` swaps the middleware column for the protections that really apply (after groups,
 * the route, the controller and handler wrappers), lists every opt-out with where it was written
 * (`route`, `group`, `controller`, `app: webhooks/*`), and warns about unsafe routes without a
 * CSRF check and `/_…` developer routes without auth: the security surface in one table.
 *
 * **`route:list` and `routes`:** `route:list` lists the routes of an app (`bootstrap/app.ts`).
 * The older `node strut routes` lists the CRUD routes a `strutvane.config.ts` project generates
 * from its models, without booting anything; both stay.
 *
 * @module
 */
import type { CompiledRoute } from '../../../routing/router.ts'
import { actionLabel } from '../../../routing/router.ts'
import type { AnyCommand } from '../../framework/command.ts'
import {
  type AppCommandDeps,
  BOOT_FLAGS,
  defineAppCommand,
  plural,
  withBootedApp,
} from './support.ts'

/**
 * One row of `route:list`.
 *
 * @example
 * const row: RouteListRow = { method: 'GET|HEAD', uri: '/posts', name: 'posts.index', action: 'PostController@index', middleware: ['csrf'] }
 */
export interface RouteListRow {
  readonly method: string
  readonly uri: string
  readonly name: string | null
  readonly action: string
  readonly middleware: readonly string[]
  readonly fallback: boolean
}

/**
 * One row of `route:list --security`.
 *
 * @example
 * const row: RouteSecurityRow = { method: 'POST', uri: '/hook', name: null, protections: [], optOuts: ['csrf (route)'], warnings: [] }
 */
export interface RouteSecurityRow {
  readonly method: string
  readonly uri: string
  readonly name: string | null
  readonly protections: readonly string[]
  readonly optOuts: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * The `route:list` command.
 *
 * @example
 * routeListCommand(DEFAULT_APP_DEPS)
 */
export function routeListCommand(deps: AppCommandDeps): AnyCommand {
  return defineAppCommand({
    name: 'route:list',
    description: 'List every route of the app (--security: protections, opt-outs, warnings)',
    details:
      'Projects with strutvane.config.ts also have node strut routes, which lists the CRUD routes generated from their models.',
    requiresProject: false,
    flags: {
      ...BOOT_FLAGS,
      path: { type: 'string', valueName: '<text>', description: 'Only URIs containing this' },
      name: { type: 'string', valueName: '<text>', description: 'Only names containing this' },
      method: { type: 'string', valueName: '<METHOD>', description: 'Only this HTTP method' },
      security: {
        type: 'boolean',
        description: 'Show the protections, opt-outs and warnings of each route',
      },
    },
    examples: [
      'node strut route:list --path=posts',
      'node strut route:list --security',
      'node strut route:list --security --json',
    ],
    async run(ctx) {
      const { flags, out } = ctx
      const method = flags.method?.toUpperCase()
      const keep = (route: CompiledRoute): boolean =>
        (flags.path === undefined || route.uri.includes(flags.path)) &&
        (flags.name === undefined || (route.name ?? '').includes(flags.name)) &&
        (method === undefined || route.methods.some((candidate) => candidate === method))
      if (flags.security === true) {
        // Loaded here: the security view pulls in the middleware stack, which help doesn't need.
        const { describeOptOut } = await import('../../../http/app/security-profile.ts')
        const rows = await withBootedApp(ctx, deps, (app) =>
          [...app.routes, ...app.fallbacks].filter(keep).map((route): RouteSecurityRow => {
            const profile = app.securityProfile(route)
            return {
              method: route.methods.join('|'),
              uri: route.uri,
              name: route.name ?? null,
              protections: profile.protections,
              optOuts: profile.optOuts.map(describeOptOut),
              warnings: profile.warnings,
            }
          }),
        )
        out.table(
          ['Method', 'URI', 'Name', 'Protections', 'Opt-outs', 'Warnings'],
          rows.map((row) => [
            row.method,
            row.uri,
            row.name ?? '',
            row.protections.join(', ') || out.style.dim('(none)'),
            row.optOuts.map((text) => out.style.yellow(`! ${text}`)).join(', '),
            row.warnings.map((text) => out.style.red(`! ${text}`)).join(', '),
          ]),
        )
        const optOuts = rows.reduce((total, row) => total + row.optOuts.length, 0)
        const warnings = rows.reduce((total, row) => total + row.warnings.length, 0)
        out.line()
        out.line(
          `  ${plural(rows.length, 'route')}, ${plural(optOuts, 'opt-out')}, ${plural(warnings, 'warning')}.`,
        )
        return { data: { routes: rows, optOuts, warnings } }
      }
      const { rows, total } = await withBootedApp(ctx, deps, (app) => {
        const all = [...app.routes, ...app.fallbacks]
        return {
          total: all.length,
          rows: all.filter(keep).map(
            (route): RouteListRow => ({
              method: route.methods.join('|'),
              uri: route.uri,
              name: route.name ?? null,
              action: actionLabel(route.action),
              middleware: app
                .routeMiddleware(route)
                .references.map((reference) => [reference.alias, ...reference.params].join(':')),
              fallback: route.fallback === true,
            }),
          ),
        }
      })
      out.table(
        ['Method', 'URI', 'Name', 'Action', 'Middleware'],
        rows.map((row) => [
          row.method,
          row.fallback ? `${row.uri} ${out.style.dim('(fallback)')}` : row.uri,
          row.name ?? '',
          row.action,
          row.middleware.join(', '),
        ]),
      )
      out.line()
      out.line(`  Showing ${rows.length} of ${plural(total, 'route')}.`)
      return { data: { routes: rows, total } }
    },
  })
}
