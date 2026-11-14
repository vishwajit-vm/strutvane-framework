/**
 * `@strutvane/framework/http`: custom routes and resource definitions for app code.
 *
 * @module
 */

export { HTTP_HOOKS } from '@strutvane/contracts'
export type {
  HttpRequestHookPayload,
  HttpResponseHookPayload,
} from '../http/create-http-app.ts'
export {
  defineResource,
  type ResourceAction,
  type ResourceConfig,
  type ResourceContext,
  type ResourceHooks,
} from '../http/resource.ts'
export {
  type RouteContext,
  type RouteDefinition,
  type RouteHandler,
  type RouteMethod,
  type RouteOptions,
  route,
} from '../http/route.ts'
