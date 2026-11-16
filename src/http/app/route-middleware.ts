/**
 * Work out the middleware a route really runs, from every style at once: its groups, its own
 * `.middleware()`, the controller's `static middleware`, a `withCsrf()`-style wrapper on a closure,
 * and the opt-outs (`.withoutMiddleware()`, group `withoutMiddleware`, controller `except`).
 *
 * The rules, chosen to fail closed:
 * 1. An opt-out removes the alias whatever group added it (the group defaults are the point of
 *    opting out).
 * 2. A route, controller or wrapper that adds an alias its *group* opted out of keeps it: the more
 *    specific declaration wins, and adding a protection is always safe.
 * 3. A route or controller opt-out of an alias the route itself adds (its own `.middleware()`, the
 *    controller's entry for this action, a wrapper) is a boot error: two contradictory
 *    declarations at the same level, and guessing would silently remove a protection someone
 *    wrote on purpose.
 * 4. An opt-out of an alias nobody registered is a boot error (a typo would opt out of nothing).
 * 5. Identical references are kept once; then Laravel-style priority orders them.
 *
 * @module
 */
import { BootError } from '../../foundation/boot-error.ts'
import type { CompiledRoute } from '../../routing/router.ts'
import { closestMatch } from '../../support/str.ts'
import {
  type MiddlewareConfig,
  type MiddlewareReference,
  parseMiddleware,
  sortByPriority,
} from './middleware.ts'
import { controllerMethods, protectionsOf, readControllerMiddleware } from './protection.ts'

/**
 * Where an opt-out was written.
 *
 * @example
 * const source: OptOutSource = 'controller'
 */
export type OptOutSource = 'route' | 'group' | 'controller'

/**
 * One opt-out that applies to a route, for `route:list --security`.
 *
 * @example
 * const optOut: OptOut = { alias: 'csrf', source: 'controller' }
 */
export interface OptOut {
  readonly alias: string
  readonly source: OptOutSource
}

/**
 * A route's final middleware and the opt-outs that shaped it.
 *
 * @example
 * resolved.references.map((reference) => reference.alias) // ['csrf', 'auth', 'throttle']
 */
export interface ResolvedRouteMiddleware {
  /** Run order, after exclusions, dedupe and priority. */
  readonly references: readonly MiddlewareReference[]
  readonly optOuts: readonly OptOut[]
}

/**
 * Resolve one route's middleware. Throws a friendly `BootError` for unknown aliases, conflicting
 * declarations and controller `only`/`except` lists naming methods that don't exist.
 *
 * @example
 * const { references, optOuts } = resolveRouteMiddleware(route, middlewareConfig)
 */
export function resolveRouteMiddleware(
  route: CompiledRoute,
  config: MiddlewareConfig,
): ResolvedRouteMiddleware {
  const where = `${route.methods.join('|')} ${route.uri}`
  const fromController = controllerDeclarations(route, where)
  const fromWrapper = route.action.kind === 'closure' ? protectionsOf(route.action.handler) : []
  const declared: OptOut[] = [...route.excluded, ...fromController.optOuts]
  for (const optOut of declared)
    if (config.resolveAlias(optOut.alias) === undefined)
      throw config.unknownAlias(optOut.alias, `${where} (withoutMiddleware)`)

  const explicit = new Set(
    [...route.ownMiddleware, ...fromController.adds, ...fromWrapper].map(
      (reference) => parseMiddleware(reference).alias,
    ),
  )
  // A group opt-out yields to a more specific add: re-adding a protection is always safe.
  const optOuts = declared.filter(
    (optOut) => optOut.source !== 'group' || !explicit.has(optOut.alias),
  )
  for (const optOut of optOuts) {
    if (explicit.has(optOut.alias)) {
      throw new BootError(
        'middleware_conflict',
        `${where} both adds "${optOut.alias}" and opts out of it (${optOut.source}).`,
        'Remove one of the two declarations. An opt-out can only remove middleware the route inherits from a group.',
      )
    }
  }
  const removed = new Set(optOuts.map((optOut) => optOut.alias))
  const all = config.expandGroups(
    [...route.middleware, ...fromController.adds, ...fromWrapper],
    where,
  )
  return {
    references: sortByPriority(dedupe(all.filter((reference) => !removed.has(reference.alias)))),
    optOuts: uniqueOptOuts(optOuts),
  }
}

/** What the controller's `static middleware` adds to, and removes from, this action. */
function controllerDeclarations(
  route: CompiledRoute,
  where: string,
): { adds: string[]; optOuts: OptOut[] } {
  if (route.action.kind !== 'controller') return { adds: [], optOuts: [] }
  const { controller, method } = route.action
  const entries = readControllerMiddleware(controller)
  const methods = entries.length === 0 ? [] : controllerMethods(controller)
  const adds: string[] = []
  const optOuts: OptOut[] = []
  for (const entry of entries) {
    for (const name of [...(entry.only ?? []), ...entry.except]) {
      if (!methods.includes(name)) {
        const suggestion = closestMatch(name, methods)
        throw new BootError(
          'unknown_controller_action',
          `${controller.name}.middleware names "${name}", which is not an action of ${controller.name} (${where}).`,
          suggestion === undefined
            ? `Actions: ${methods.join(', ')}.`
            : `Did you mean "${suggestion}"?`,
        )
      }
    }
    if (entry.except.includes(method)) optOuts.push({ alias: entry.alias, source: 'controller' })
    else if (entry.only === undefined || entry.only.includes(method)) adds.push(entry.reference)
  }
  return { adds, optOuts }
}

function dedupe(references: readonly MiddlewareReference[]): MiddlewareReference[] {
  const seen = new Set<string>()
  return references.filter((reference) => {
    const key = `${reference.alias}:${reference.params.join(',')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueOptOuts(optOuts: readonly OptOut[]): OptOut[] {
  const seen = new Set<string>()
  return optOuts.filter((optOut) => {
    const key = `${optOut.alias}:${optOut.source}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
