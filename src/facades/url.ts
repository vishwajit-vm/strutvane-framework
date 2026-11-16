/**
 * The `Url` facade: the current app's URL generator, Laravel's `URL::`. Route names and their
 * parameters are typed like `route()` once the app fills in `RouteRegistry`.
 *
 * @module
 */
import {
  type RouteArguments,
  type RouteName,
  type SignedRouteOptions,
  type UrlGenerator,
  UrlGeneratorToken,
  type UrlHelper,
  type UrlOptions,
} from '../routing/url.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<UrlGenerator> = {
  facade: 'Url',
  token: UrlGeneratorToken,
  provides: 'the URL generator',
  install:
    'The app binds the URL generator from its routes when it boots; call Url from a request, command or app.run(() => …).',
}

/**
 * What the `Url` facade offers: the `url` helper's methods plus `has`.
 *
 * @example
 * const urls: UrlFacade = Url
 */
export interface UrlFacade extends UrlHelper {
  /** Whether the app has a route with this name. */
  has(name: string): boolean
}

/**
 * Build plain, signed and temporary signed URLs to the current app's named routes.
 *
 * @example
 * Url.route('posts.show', { post })                           // '/api/posts/hello-world'
 * Url.signedRoute('unsubscribe', { user: 7 }, { absolute: true })
 * Url.temporarySignedRoute('downloads.show', Date.now() + 30 * 60_000, { file: 7 })
 */
export const Url: UrlFacade = Object.freeze({
  route: <TName extends RouteName>(name: TName, ...args: RouteArguments<TName>): string =>
    resolveFacade(binding, 'route').route(name, args[0], args[1]),
  signedRoute: <TName extends RouteName>(
    name: TName,
    ...args: RouteArguments<TName, SignedRouteOptions>
  ): string => resolveFacade(binding, 'signedRoute').signedRoute(name, args[0], args[1]),
  temporarySignedRoute: <TName extends RouteName>(
    name: TName,
    expiresAt: Date | number,
    ...args: RouteArguments<TName, UrlOptions & { readonly oneTime?: boolean }>
  ): string =>
    resolveFacade(binding, 'temporarySignedRoute').temporarySignedRoute(
      name,
      expiresAt,
      args[0],
      args[1],
    ),
  has: (name: string): boolean => resolveFacade(binding, 'has').has(name),
})
