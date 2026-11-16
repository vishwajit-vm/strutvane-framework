/**
 * Which protections apply to a route, and which were switched off and where: the data behind
 * `node strut route:list --security`. The blueprint's rule is that opting out is always explicit
 * *and visible*, so every opt-out (route, group, controller, app-wide CSRF exception) is listed,
 * and an unsafe route with no CSRF check at all is a warning.
 *
 * @module
 */
import type { CompiledRoute } from '../../routing/router.ts'
import type { ResolvedSecurity } from '../../security/settings.ts'
import { matchesPathPattern } from '../csrf.ts'
import { CSP_REPORT_ROUTE } from './csp-report.ts'
import { referenceFor } from './middleware.ts'
import type { OptOutSource, ResolvedRouteMiddleware } from './route-middleware.ts'

/**
 * The aliases `route:list --security` reports; other middleware isn't a security control.
 *
 * @example
 * SECURITY_ALIASES.includes('csrf') // true
 */
export const SECURITY_ALIASES: readonly string[] = Object.freeze([
  'csrf',
  'signed',
  'auth',
  'can',
  'throttle',
  'idempotent',
])

/** Laravel-style "unsafe" methods: they change state, so they need CSRF on cookie sessions. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * One opt-out as printed: the alias, where it was written, and for app-wide CSRF exceptions the
 * pattern that matched.
 *
 * @example
 * const optOut: ProfileOptOut = { alias: 'csrf', source: 'app', detail: 'api/webhooks/*' }
 */
export interface ProfileOptOut {
  readonly alias: string
  readonly source: OptOutSource | 'app'
  readonly detail?: string
}

/**
 * The security view of one route.
 *
 * @example
 * profile.protections // ['csrf', 'auth', 'throttle:api']
 */
export interface RouteSecurityProfile {
  readonly protections: readonly string[]
  readonly optOuts: readonly ProfileOptOut[]
  readonly warnings: readonly string[]
}

/**
 * Build the profile of one route from its resolved middleware and the app's settings.
 *
 * @example
 * securityProfile(route, app.routeMiddleware(route), app.make(SecurityToken))
 */
export function securityProfile(
  route: CompiledRoute,
  resolved: ResolvedRouteMiddleware,
  security: ResolvedSecurity,
): RouteSecurityProfile {
  const protections = resolved.references
    .filter((reference) => SECURITY_ALIASES.includes(reference.alias))
    .map((reference) => referenceFor(reference.alias, reference.params))
  const optOuts: ProfileOptOut[] = [...resolved.optOuts]
  const hasCsrf = resolved.references.some((reference) => reference.alias === 'csrf')
  const exception = hasCsrf
    ? security.csrf.except.find((pattern) => matchesPathPattern(pattern, route.uri))
    : undefined
  if (exception !== undefined) optOuts.push({ alias: 'csrf', source: 'app', detail: exception })
  const warnings: string[] = []
  const unsafe = route.methods.some((method) => UNSAFE_METHODS.has(method))
  if (unsafe && !hasCsrf && !optOuts.some((optOut) => optOut.alias === 'csrf'))
    warnings.push('unsafe method with no CSRF check')
  // The CSP report endpoint is public by design: browsers post to it without credentials.
  if (
    route.uri.startsWith('/_') &&
    route.name !== CSP_REPORT_ROUTE &&
    !protections.some(
      (protection) =>
        protection === 'auth' || protection.startsWith('can:') || protection === 'signed',
    )
  )
    warnings.push('developer tool route without auth')
  return { protections, optOuts, warnings }
}

/**
 * An opt-out as text: `csrf (route)`, `csrf (app: api/webhooks/*)`.
 *
 * @example
 * describeOptOut({ alias: 'csrf', source: 'controller' }) // 'csrf (controller)'
 */
export function describeOptOut(optOut: ProfileOptOut): string {
  return `${optOut.alias} (${optOut.source}${optOut.detail === undefined ? '' : `: ${optOut.detail}`})`
}
