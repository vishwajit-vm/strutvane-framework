/**
 * Custom API routes (`app/http/routes/*.ts`): endpoints that don't fit CRUD.
 *
 * ```ts
 * import { route } from '@strutvane/framework/http'
 * export default [
 *   route.get('/hello', { public: true, handler: () => ({ message: 'Hello' }) }),
 *   route.post('/reports/revenue', { permission: 'report.revenue', handler: (c) => build(c) }),
 * ]
 * ```
 *
 * Authorization is deny-by-default, like the CRUD routes:
 * - `permission` → the PermissionProvider must allow it (401 anonymous, 403 otherwise);
 * - `public: true` → anyone, including anonymous callers (an explicit opt-in);
 * - neither → any **authenticated** actor (anonymous callers get 401).
 *
 * The registry compiler (`sv registry:build`) reads these calls statically, so `path`, `name` and
 * `permission` must be string literals.
 *
 * @module
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Actor, Permission, PermissionProvider } from '@strutvane/contracts'
import { ForbiddenError, UnauthenticatedError } from '@strutvane/core'
import { type HttpEnv, readJsonBody } from './resource-routes.ts'

/** HTTP methods a custom route may use. */
export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** What a route handler receives. */
export interface RouteContext {
  readonly request: Request
  /** Path parameters (`/reports/:year` → `{ year: '2026' }`). */
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  readonly actor: Actor | null
  readonly tenantId: string | undefined
  readonly requestId: string
  readonly locale: string
  /** The client address (socket peer, or a trusted proxy hop), when known. */
  readonly clientAddress?: string
  /**
   * The JSON request body. A body that is not `application/json` is a 415
   * `UNSUPPORTED_MEDIA_TYPE` problem (so a cross-site form post can never reach the handler as
   * JSON); malformed JSON is a 400 `MALFORMED_REQUEST` problem.
   */
  json<T = unknown>(): Promise<T>
}

/**
 * A handler returns a `Response` (sent as is), `undefined` (204 No Content) or a JSON-serialisable
 * value (200 JSON). Throw a Strutvane error (`NotFoundError`, `ValidationError`, …) for failures.
 */
export type RouteHandler = (context: RouteContext) => unknown

/** Options for one route. */
export interface RouteOptions {
  /** Stable route name, e.g. `reports.revenue` (shown by `sv routes`). */
  readonly name?: string
  /** Permission required, e.g. `report.revenue`. */
  readonly permission?: string
  /** Allow anonymous callers. Ignored when `permission` is set. */
  readonly public?: boolean
  readonly handler: RouteHandler
}

/** A defined route. */
export interface RouteDefinition extends RouteOptions {
  readonly method: RouteMethod
  /** Path relative to the API base path, starting with `/`. */
  readonly path: string
}

const PATH = /^\/[A-Za-z0-9\-._~/:]*$/
const PERMISSION = /^[a-z][a-zA-Z0-9_-]{0,63}\.[a-zA-Z*][a-zA-Z0-9_-]{0,63}$/

function define(method: RouteMethod, path: string, options: RouteOptions): RouteDefinition {
  // Validate at definition time so a bad route stops the app at boot, not at the first request.
  if (!PATH.test(path) || path.includes('//') || path.split('/').some((s) => s === '..')) {
    throw new TypeError(`route.${method}(${JSON.stringify(path)}): path must start with "/"`)
  }
  if (typeof options?.handler !== 'function')
    throw new TypeError(`route.${method}(${JSON.stringify(path)}): handler must be a function`)
  if (options.permission !== undefined && !PERMISSION.test(options.permission)) {
    throw new TypeError(
      `route.${method}(${JSON.stringify(path)}): permission ${JSON.stringify(options.permission)} must look like "report.revenue"`,
    )
  }
  return Object.freeze({ ...options, method, path })
}

/** Route builders, one per HTTP method. */
export const route: Readonly<
  Record<RouteMethod, (path: string, options: RouteOptions) => RouteDefinition>
> = Object.freeze({
  get: (path: string, options: RouteOptions) => define('get', path, options),
  post: (path: string, options: RouteOptions) => define('post', path, options),
  put: (path: string, options: RouteOptions) => define('put', path, options),
  patch: (path: string, options: RouteOptions) => define('patch', path, options),
  delete: (path: string, options: RouteOptions) => define('delete', path, options),
})

/** Is `value` a route created by {@link route}? (Used when loading route files.) */
export function isRouteDefinition(value: unknown): value is RouteDefinition {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['method'] === 'string' &&
    typeof v['path'] === 'string' &&
    typeof v['handler'] === 'function'
  )
}

/** Mount custom routes under `basePath`. */
export function registerCustomRoutes(
  http: OpenAPIHono<HttpEnv>,
  routes: readonly RouteDefinition[],
  deps: { readonly basePath: string; readonly permissions: PermissionProvider },
): void {
  const seen = new Set<string>()
  for (const r of routes) {
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) throw new TypeError(`Duplicate route: ${key.toUpperCase()}`)
    seen.add(key)
    http.on(r.method.toUpperCase(), `${deps.basePath}${r.path}`, async (c) => {
      const s = c.get('sv')
      if (r.permission !== undefined) {
        const decision = await deps.permissions.can(s.actor, r.permission as Permission)
        if (!decision.allowed)
          throw s.actor === null ? new UnauthenticatedError() : new ForbiddenError()
      } else if (r.public !== true && s.actor === null) {
        throw new UnauthenticatedError()
      }
      const context: RouteContext = {
        request: c.req.raw,
        params: c.req.param() as Record<string, string>,
        query: new URL(c.req.url).searchParams,
        actor: s.actor,
        tenantId: s.tenantId,
        requestId: s.requestId,
        locale: s.locale,
        ...(s.clientAddress !== undefined ? { clientAddress: s.clientAddress } : {}),
        json: async <T>() => (await readJsonBody(c)) as T,
      }
      const result = await r.handler(context)
      if (result instanceof Response) return result
      if (result === undefined) return c.body(null, 204)
      return c.json(result as object)
    })
  }
}
