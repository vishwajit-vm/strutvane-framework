/**
 * The `Route` facade: read-only questions about the current app's routes and the current
 * request's route, Laravel's `Route::has()` and `Route::currentRouteName()`.
 *
 * **Not the routing builder.** Routes are *declared* with the `Route` builder from
 * `@strutvane/framework` (`Route.get('/posts', …)` in `routes/*.ts`). This facade only *reads*,
 * and lives in `@strutvane/framework/facades` so the two never collide; import it under another
 * name where a module needs both (`import { Route as Routes } from '@strutvane/framework/facades'`).
 *
 * @module
 */
import { currentHttpContext, type MatchedRoute } from '../http/app/context.ts'
import { type UrlGenerator, UrlGeneratorToken } from '../routing/url.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<UrlGenerator> = {
  facade: 'Route',
  token: UrlGeneratorToken,
  provides: "the app's route table",
  install:
    'The app compiles its routes when it boots; call Route from a request, command or app.run(() => …).',
}

/**
 * What the `Route` facade offers.
 *
 * @example
 * const routes: RouteFacade = Route
 */
export interface RouteFacade {
  /** Whether the app has a route with this name. */
  has(name: string): boolean
  /** The route of the current request, or `undefined` outside a routed request (404s included). */
  current(): MatchedRoute | undefined
  /** The current route's name, or `undefined`. */
  currentRouteName(): string | undefined
  /** Whether the current route's name matches one of the patterns (`*` matches anything). */
  is(...patterns: readonly string[]): boolean
}

/**
 * Ask about the current app's routes.
 *
 * @example
 * if (Route.has('billing.portal')) links.push(Url.route('billing.portal'))
 * if (Route.is('admin.*')) Log.info('Admin area visited')
 */
export const Route: RouteFacade = Object.freeze({
  has: (name: string): boolean => resolveFacade(binding, 'has').has(name),
  current: (): MatchedRoute | undefined => currentHttpContext()?.route,
  currentRouteName: (): string | undefined => currentHttpContext()?.route?.name,
  is: (...patterns: readonly string[]): boolean => {
    const name = currentHttpContext()?.route?.name
    return name !== undefined && patterns.some((pattern) => wildcard(pattern).test(name))
  },
})

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}
