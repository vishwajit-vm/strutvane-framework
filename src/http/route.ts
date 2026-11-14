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
import { type Application, ForbiddenError, UnauthenticatedError } from '@strutvane/core'
import { createRepository, type Repository, type Scope } from '../data/repository.ts'
import type { Database } from '../database/types.ts'
import type { AnyModel, ModelDefinition } from '../model/define-model.ts'
import type { ModelRegistry } from '../model/registry.ts'
import { bindFilter } from '../query/bind.ts'
import { queryFields } from '../query/fields.ts'
import type { StorageManager } from '../storage/manager.ts'
import { type MultipartLimits, type MultipartResult, parseMultipart } from '../storage/multipart.ts'
import { StorageManagerToken } from '../tokens.ts'
import { permissionFor } from './permissions.ts'
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
  /** The booted application (container, config, logger): `app.make(Token)`. */
  readonly app: Application
  /**
   * `{ tenantId }` of this request. Pass it to repository calls: a tenant-scoped model refuses
   * (TENANT_REQUIRED) to run without it, so forgetting it fails closed.
   */
  readonly scope: Scope
  /**
   * The repository of a model (by model or name). It applies only the scope you pass: use
   * {@link RouteContext.scope} for tenant isolation, or {@link RouteContext.scopeFor} to also
   * apply the actor's policy filter, exactly as the CRUD routes do.
   */
  repository(model: AnyModel | ModelDefinition | string): Repository
  /**
   * The tenant scope plus the PermissionProvider's row filter for `<model>.<action>` (e.g.
   * `scopeFor(Invoice, 'update')`): rows the actor may not touch are invisible, and writes must
   * stay inside the filter (403 otherwise).
   */
  scopeFor(model: AnyModel | ModelDefinition | string, action: string): Promise<Scope>
  /**
   * Require a permission (e.g. `invoice.update`, optionally for one record): 401 for anonymous
   * callers, 403 otherwise.
   */
  authorize(permission: string, record?: Readonly<Record<string, unknown>>): Promise<void>
  /** The storage disks (`config/filesystems.ts`). */
  readonly storage: StorageManager
  /**
   * Parse a `multipart/form-data` body with limits enforced while streaming (RFC-0002). Temp
   * files are deleted when the handler finishes, whatever happens; call `file.store()` to keep
   * one. The route's `bodyLimit` must allow the upload size (default 1 MiB).
   */
  multipart(limits?: MultipartLimits): Promise<MultipartResult>
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
  /**
   * Maximum request body in bytes for this route (e.g. an upload endpoint). Default: the app's
   * body limit (1 MiB). Multipart limits still apply per file on top of it.
   */
  readonly bodyLimit?: number
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
  if (
    options.bodyLimit !== undefined &&
    (!Number.isSafeInteger(options.bodyLimit) || options.bodyLimit < 1)
  ) {
    throw new TypeError(
      `route.${method}(${JSON.stringify(path)}): bodyLimit must be a positive number of bytes`,
    )
  }
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

/** What custom routes need from the app (resolved once by `createHttpApp`). */
export interface CustomRouteDeps {
  readonly basePath: string
  readonly permissions: PermissionProvider
  readonly app: Application
  readonly db: Database
  readonly registry: ModelRegistry
  readonly ids: () => string
  readonly now: () => Date
}

/** `/notes/:id/attachments` under `/api/v1` → a RegExp matching concrete request paths. */
export function routePattern(basePath: string, path: string): RegExp {
  const escaped = `${basePath}${path}`
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${escaped}/?$`)
}

/** Mount custom routes under `basePath`. */
export function registerCustomRoutes(
  http: OpenAPIHono<HttpEnv>,
  routes: readonly RouteDefinition[],
  deps: CustomRouteDeps,
): void {
  const repos = new Map<string, Repository>()
  const definitionOf = (model: AnyModel | ModelDefinition | string): ModelDefinition =>
    deps.registry.require(
      typeof model === 'string'
        ? model
        : 'definition' in model
          ? model.definition.name
          : model.name,
    )
  const repository = (model: AnyModel | ModelDefinition | string): Repository => {
    const def = definitionOf(model)
    let repo = repos.get(def.name)
    if (!repo) {
      repo = createRepository({
        db: deps.db,
        model: def,
        registry: deps.registry,
        ids: deps.ids,
        now: deps.now,
      })
      repos.set(def.name, repo)
    }
    return repo
  }
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
      const scope: Scope = s.tenantId !== undefined ? { tenantId: s.tenantId } : {}
      const uploads: MultipartResult[] = []
      const context: RouteContext = {
        app: deps.app,
        scope,
        repository,
        storage: deps.app.make(StorageManagerToken),
        authorize: async (permission, record) => {
          const [prefix, ...rest] = permission.split('.')
          const decision = await deps.permissions.can(
            s.actor,
            permission as Permission,
            prefix && rest.length > 0 ? { type: prefix, ...(record ? { record } : {}) } : undefined,
          )
          if (!decision.allowed)
            throw s.actor === null ? new UnauthenticatedError() : new ForbiddenError()
        },
        scopeFor: async (model, action) => {
          const def = definitionOf(model)
          const raw = await deps.permissions.filterFor(
            s.actor,
            permissionFor(def.permission, action),
            def.permission,
          )
          // Policy filters are trusted code: any operator the field supports may be used.
          const filter = bindFilter(raw, {
            fields: queryFields(def),
            operators: 'any',
            actor: s.actor,
          })
          return { ...scope, filter }
        },
        multipart: async (limits) => {
          const parsed = await parseMultipart(c.req.raw, limits)
          uploads.push(parsed)
          return parsed
        },
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
      try {
        const result = await r.handler(context)
        if (result instanceof Response) return result
        if (result === undefined) return c.body(null, 204)
        return c.json(result as object)
      } finally {
        // Temp files never outlive the request, whether the handler stored, failed or forgot them.
        await Promise.all(uploads.map((u) => u.cleanup().catch(() => undefined)))
      }
    })
  }
}
