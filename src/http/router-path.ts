/**
 * The request path exactly as Hono's router sees it (percent-decoded with `decodeURI` rules, so
 * `%2F` stays encoded), for every path-keyed decision made outside the router: CSRF exceptions,
 * per-route body limits and timeouts, idempotency scopes.
 *
 * Why one helper: when a check matches the raw path while the router matches the decoded one,
 * `/api/v1/upl%6Fads` reaches the upload route but escapes the upload route's own limit (or a
 * CSRF exception matches a path the router never serves). Using the router's own function means
 * a check and the route it guards can never disagree about which path a request is for.
 *
 * @module
 */
import { getPath } from 'hono/utils/url'

/**
 * The router's view of `request`'s path.
 *
 * @example
 * routerPath(new Request('http://x/api/v1/upl%6Fads?a=1')) // '/api/v1/uploads'
 */
export function routerPath(request: Request): string {
  return getPath(request)
}
