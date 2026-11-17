/**
 * `@strutvane/framework/http`: custom routes and resource definitions for app code.
 *
 * @module
 */

export { HTTP_HOOKS } from '../contracts/index.ts'
export type {
  HttpRequestHookPayload,
  HttpResponseHookPayload,
} from '../http/create-http-app.ts'
export { CSRF_ERROR_CODE, type CsrfOptions } from '../http/csrf.ts'
export {
  defineResource,
  type ResourceAction,
  type ResourceConfig,
  type ResourceContext,
  type ResourceHooks,
  type WriteChange,
  type WriteContext,
} from '../http/resource.ts'
export type {
  RouteContext,
  RouteDefinition,
  RouteHandler,
  RouteMethod,
  RouteOptions,
} from '../http/route.ts'
export {
  DEFAULT_SESSION_COOKIE,
  type SessionCookie,
  SessionCookieToken,
  sessionCookieName,
  XSRF_COOKIE,
} from '../http/session-cookie.ts'
// The callable route() URL helper; it keeps the v1 route.get/post/… builders (deprecated).
export { type RouteHelper, route } from '../routing/route-helper.ts'
