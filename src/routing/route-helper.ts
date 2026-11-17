/**
 * The `route` export: Laravel's `route('posts.show', { post })` URL helper, which also keeps the
 * v1 custom-route builders (`route.get(…)` for `createHttpApp`) working, so existing apps don't
 * break when the export changes from an object to a function.
 *
 * ```ts
 * route('posts.show', { post })                   // '/api/posts/hello-world' (typed)
 * route.get('/hello', { public: true, handler })   // v1 custom route (deprecated: use Route.get)
 * ```
 *
 * @module
 */
import { route as legacyRoutes, type RouteBuilder } from '../http/route.ts'
import { type RouteArguments, type RouteName, routeUrl } from './url.ts'

/**
 * The callable `route()` helper plus the v1 builders.
 *
 * @example
 * route('posts.index', {}, { query: { page: 2 } })
 */
export interface RouteHelper {
  /** Build the URL of a named route of the current app, typed against `RouteRegistry`. */
  <TName extends RouteName>(name: TName, ...args: RouteArguments<TName>): string
  /** @deprecated A v1 custom route for `createHttpApp`; use `Route.get` in routes files. */
  readonly get: RouteBuilder
  /** @deprecated A v1 custom route for `createHttpApp`; use `Route.post` in routes files. */
  readonly post: RouteBuilder
  /** @deprecated A v1 custom route for `createHttpApp`; use `Route.put` in routes files. */
  readonly put: RouteBuilder
  /** @deprecated A v1 custom route for `createHttpApp`; use `Route.patch` in routes files. */
  readonly patch: RouteBuilder
  /** @deprecated A v1 custom route for `createHttpApp`; use `Route.delete` in routes files. */
  readonly delete: RouteBuilder
}

/**
 * Build the URL of a named route (checked against the app's routes files by the compiler), or
 * use the deprecated v1 builders `route.get/post/put/patch/delete`.
 *
 * @example
 * route('posts.show', { post })              // '/api/posts/hello-world'
 * route('posts.shwo', { post })              // compile error once RouteRegistry is filled in
 */
export const route: RouteHelper = Object.freeze(
  Object.assign(
    <TName extends RouteName>(name: TName, ...args: RouteArguments<TName>): string =>
      routeUrl(name, ...args),
    {
      get: legacyRoutes.get,
      post: legacyRoutes.post,
      put: legacyRoutes.put,
      patch: legacyRoutes.patch,
      delete: legacyRoutes.delete,
    },
  ),
)
