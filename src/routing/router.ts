/**
 * Turn routes files into one flat, validated route table: prefixes and name prefixes applied,
 * middleware collected in order, parameters parsed, duplicates refused. The table drives request
 * matching, 405s with `Allow`, URL generation and `node strut route:list`.
 *
 * **Why our own matcher:** routes are matched in registration order, like Laravel
 * (`/posts/create` before `/posts/{post}` because the resource table lists it first), against the
 * path exactly as the framework's other path checks see it (`routerPath`), and the same table
 * answers "which methods exist here?" for 405s and "is anything here at all?" for the fallback.
 *
 * @module
 */
import { BootError } from '../foundation/boot-error.ts'
import { closestMatch } from '../support/str.ts'
import { type FallbackRoute, type HttpMethod, type RouteEntry, RouteGroup } from './route.ts'
import {
  type ActionHandler,
  type ControllerClass,
  INVOKE_METHOD,
  type StoredAction,
} from './types.ts'

/**
 * A route action after compilation: a closure, or a controller class plus method name
 * (`__invoke` for an invokable controller).
 *
 * @example
 * const action: CompiledAction = { kind: 'controller', controller: PostController, method: 'show' }
 */
export type CompiledAction =
  | { readonly kind: 'closure'; readonly handler: ActionHandler }
  | { readonly kind: 'controller'; readonly controller: ControllerClass; readonly method: string }

/**
 * A path parameter: `{post:slug}` → `{ name: 'post', field: 'slug' }`.
 *
 * @example
 * const param: RouteParameter = { name: 'post', field: undefined }
 */
export interface RouteParameter {
  readonly name: string
  /** The column to bind by, when the path says so (`{post:slug}`). */
  readonly field: string | undefined
}

/**
 * One opt-out: `.withoutMiddleware('csrf')` on a route (`route`) or on an enclosing group (`group`).
 *
 * @example
 * const exclusion: MiddlewareExclusion = { alias: 'csrf', source: 'route' }
 */
export interface MiddlewareExclusion {
  readonly alias: string
  readonly source: 'route' | 'group'
}

/**
 * One fully resolved route.
 *
 * @example
 * table.find((route) => route.name === 'posts.show')?.uri // '/api/posts/{post:slug}'
 */
export interface CompiledRoute {
  readonly methods: readonly HttpMethod[]
  /** The full path with placeholders, including group and file prefixes. */
  readonly uri: string
  readonly name: string | undefined
  readonly action: CompiledAction
  /** Middleware references in run order (group aliases like `api` are expanded later). */
  readonly middleware: readonly string[]
  /**
   * The references the route itself adds (`.middleware()`, `middlewareFor()`), as opposed to
   * those it inherits from groups. An explicit add and an opt-out of the same alias conflict.
   */
  readonly ownMiddleware: readonly string[]
  /** Aliases the route opts out of, and where each opt-out was written. */
  readonly excluded: readonly MiddlewareExclusion[]
  readonly parameters: readonly RouteParameter[]
  /** Matches a concrete path; capture groups follow `parameters`. */
  readonly pattern: RegExp
  /** The resource action this route serves (`posts.show` → `show`), for boot checks. */
  readonly resourceAction?: string
  /** `true` for a `Route.fallback()`. */
  readonly fallback?: boolean
}

/**
 * The evaluated routes files `compileRoutes` takes.
 *
 * @example
 * const files: RoutingFiles = { web: webEntries, api: apiEntries, apiPrefix: '/api' }
 */
export interface RoutingFiles {
  readonly web?: readonly RouteEntry[]
  readonly api?: readonly RouteEntry[]
  /** Laravel's `apiPrefix`; `/api` by default. */
  readonly apiPrefix?: string
  /** Extra route lists contributed by packages and the framework, with their prefix and group. */
  readonly extra?: readonly {
    readonly entries: readonly RouteEntry[]
    readonly prefix: string
    readonly group: string | undefined
  }[]
}

/**
 * The compiled table: routes in match order, plus the fallbacks (tried only when no route
 * matched the path at all).
 *
 * @example
 * const { routes, fallbacks } = compileRoutes({ web, api })
 */
export interface RouteTable {
  readonly routes: readonly CompiledRoute[]
  readonly fallbacks: readonly CompiledFallback[]
}

/**
 * A compiled fallback: the routes file's prefix it serves under, and the prefixes it must never
 * answer (the API prefix for a web fallback, framework paths).
 *
 * @example
 * const fallback: CompiledFallback = { route, prefix: '/', excludes: ['/api', '/_strutvane'] }
 */
export interface CompiledFallback {
  readonly route: CompiledRoute
  readonly prefix: string
  readonly excludes: readonly string[]
}

/** Everything inherited from the enclosing groups while flattening. */
interface Scope {
  readonly prefix: string
  readonly namePrefix: string
  readonly middleware: readonly string[]
  readonly excluded: readonly MiddlewareExclusion[]
}

const PLACEHOLDER = /\{([^{}]*)\}/g
const PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/
/** Paths the framework itself serves; no app fallback ever answers them. */
const FRAMEWORK_PREFIX = '/_strutvane'

/**
 * Compile routes files into a route table. Web routes get the `web` middleware group; API routes
 * get the `api` group and the `/api` prefix, as in Laravel.
 *
 * @example
 * const { routes } = compileRoutes({ web: webEntries, api: apiEntries })
 */
export function compileRoutes(files: RoutingFiles): RouteTable {
  const routes: CompiledRoute[] = []
  const fallbacks: CompiledFallback[] = []
  const apiPrefix = joinPath(files.apiPrefix ?? '/api')
  const scopes: { entries: readonly RouteEntry[]; scope: Scope; excludes: readonly string[] }[] = []
  if (files.web !== undefined)
    scopes.push({
      entries: files.web,
      scope: { prefix: '', namePrefix: '', middleware: ['web'], excluded: [] },
      excludes: files.api === undefined ? [FRAMEWORK_PREFIX] : [apiPrefix, FRAMEWORK_PREFIX],
    })
  if (files.api !== undefined)
    scopes.push({
      entries: files.api,
      scope: { prefix: apiPrefix, namePrefix: '', middleware: ['api'], excluded: [] },
      excludes: [FRAMEWORK_PREFIX],
    })
  for (const extra of files.extra ?? [])
    scopes.push({
      entries: extra.entries,
      scope: {
        prefix: extra.prefix,
        namePrefix: '',
        middleware: extra.group === undefined ? [] : [extra.group],
        excluded: [],
      },
      excludes: [FRAMEWORK_PREFIX],
    })
  for (const { entries, scope, excludes } of scopes) {
    const found: FallbackRoute[] = []
    flatten(entries, scope, routes, found)
    if (found.length > 1)
      throw new BootError(
        'duplicate_fallback',
        `A routes file declares Route.fallback() ${found.length} times.`,
        'Keep one fallback per routes file: only one can answer.',
      )
    const [fallback] = found
    if (fallback !== undefined) {
      const prefix = joinPath(scope.prefix)
      fallbacks.push({
        route: compileOne({
          methods: ['GET'],
          uri: joinPath(prefix, '{fallbackPlaceholder}'),
          name: undefined,
          action: compileAction(fallback.action),
          middleware: [...scope.middleware, ...fallback.middlewareList],
          ownMiddleware: fallback.middlewareList,
          excluded: scope.excluded,
          fallback: true,
        }),
        prefix,
        excludes: excludes.filter((path) => path !== prefix),
      })
    }
  }
  assertUnique(routes)
  return { routes, fallbacks }
}

function flatten(
  entries: readonly RouteEntry[],
  scope: Scope,
  table: CompiledRoute[],
  fallbacks: FallbackRoute[],
): void {
  for (const entry of entries) {
    if (entry.kind === 'route') {
      table.push(
        compileOne({
          methods: entry.methods,
          uri: joinPath(scope.prefix, entry.path),
          name: entry.routeName === undefined ? undefined : `${scope.namePrefix}${entry.routeName}`,
          action: compileAction(entry.action),
          middleware: [...scope.middleware, ...entry.middlewareList],
          ownMiddleware: entry.middlewareList,
          excluded: [
            ...scope.excluded,
            ...entry.excludedMiddleware.map((alias) => ({ alias, source: 'route' as const })),
          ],
        }),
      )
    } else if (entry instanceof RouteGroup) {
      flatten(
        entry.entries,
        {
          prefix: joinPath(scope.prefix, entry.prefix),
          namePrefix: `${scope.namePrefix}${entry.namePrefix}`,
          middleware: [...scope.middleware, ...entry.middlewareList],
          excluded: [
            ...scope.excluded,
            ...entry.excludedMiddleware.map((alias) => ({ alias, source: 'group' as const })),
          ],
        },
        table,
        fallbacks,
      )
    } else if (entry.kind === 'fallback') {
      fallbacks.push(entry)
    } else {
      for (const route of entry.routes) {
        const own = [...entry.middlewareList, ...(entry.middlewareByAction[route.action] ?? [])]
        table.push(
          compileOne({
            methods: route.methods,
            uri: joinPath(scope.prefix, route.path),
            name: `${scope.namePrefix}${entry.resourceName}.${route.action}`,
            action: { kind: 'controller', controller: entry.controller, method: route.action },
            middleware: [...scope.middleware, ...own],
            ownMiddleware: own,
            excluded: [
              ...scope.excluded,
              ...entry.excludedMiddleware.map((alias) => ({ alias, source: 'route' as const })),
            ],
            resourceAction: route.action,
          }),
        )
      }
    }
  }
}

function compileAction(action: StoredAction): CompiledAction {
  if (Array.isArray(action)) {
    const [controller, method] = action as readonly [ControllerClass, string]
    return { kind: 'controller', controller, method }
  }
  if (isInvokable(action)) return { kind: 'controller', controller: action, method: INVOKE_METHOD }
  if (typeof action === 'function') return { kind: 'closure', handler: action as ActionHandler }
  throw new BootError(
    'invalid_route_action',
    'A route action must be a function, a [Controller, "method"] pair or an invokable controller.',
    'Write Route.get(path, (ctx) => …), Route.get(path, [PostController, "show"]) or Route.post(path, ImportController).',
  )
}

/**
 * `true` for an invokable controller class: a class whose prototype has `__invoke`.
 *
 * @example
 * isInvokable(ImportController) // true
 */
export function isInvokable(action: unknown): action is ControllerClass {
  return (
    typeof action === 'function' &&
    typeof (action.prototype as { [INVOKE_METHOD]?: unknown } | undefined)?.[INVOKE_METHOD] ===
      'function'
  )
}

function compileOne(route: Omit<CompiledRoute, 'parameters' | 'pattern'>): CompiledRoute {
  return { ...route, parameters: parseParameters(route.uri), pattern: toPattern(route.uri) }
}

/**
 * Join path pieces with single slashes, no trailing slash (except the root).
 *
 * @example
 * joinPath('/api', 'admin/', '/posts') // '/api/admin/posts'
 */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/')
  return `/${joined}`
}

/**
 * Read the `{name}` / `{name:field}` placeholders of a path, refusing malformed ones.
 *
 * @example
 * parseParameters('/posts/{post:slug}') // [{ name: 'post', field: 'slug' }]
 */
export function parseParameters(uri: string): RouteParameter[] {
  const withoutPlaceholders = uri.replace(PLACEHOLDER, '')
  if (withoutPlaceholders.includes('{') || withoutPlaceholders.includes('}')) {
    throw new BootError(
      'invalid_route_path',
      `The route path "${uri}" has an unmatched brace.`,
      'Write parameters as {post} or {post:slug}.',
    )
  }
  const parameters: RouteParameter[] = []
  for (const match of uri.matchAll(PLACEHOLDER)) {
    const inner = match[1] ?? ''
    const [name = '', field, extra] = inner.split(':')
    if (
      !PARAM_NAME.test(name) ||
      (field !== undefined && !PARAM_NAME.test(field)) ||
      extra !== undefined
    ) {
      throw new BootError(
        'invalid_route_parameter',
        `"{${inner}}" in "${uri}" is not a valid route parameter.`,
        'Use letters, digits and underscores: {post} or {post:slug}.',
      )
    }
    if (parameters.some((parameter) => parameter.name === name)) {
      throw new BootError(
        'duplicate_route_parameter',
        `The route path "${uri}" uses {${name}} twice.`,
        'Give each parameter its own name, for example {author}/posts/{post}.',
      )
    }
    parameters.push({ name, field })
  }
  return parameters
}

function toPattern(uri: string): RegExp {
  const source = uri
    .split(PLACEHOLDER)
    // `split` with a capturing regex alternates literal text (even indexes) and placeholders (odd).
    .map((piece, index) => (index % 2 === 0 ? escapeRegExp(piece) : '([^/]+)'))
    .join('')
  return new RegExp(`^${source}/?$`)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The route for a method and a path, with its decoded parameters, or `undefined`.
 * `HEAD` matches `GET` routes. A parameter that isn't valid percent-encoding keeps its raw text.
 *
 * @example
 * matchRoute(routes, 'GET', '/api/posts/hello') // { route, params: { post: 'hello' } }
 */
export function matchRoute(
  routes: readonly CompiledRoute[],
  method: string,
  path: string,
):
  | { readonly route: CompiledRoute; readonly params: Readonly<Record<string, string>> }
  | undefined {
  const wanted = method === 'HEAD' ? 'GET' : method
  for (const route of routes) {
    if (!route.methods.includes(wanted as HttpMethod)) continue
    const match = route.pattern.exec(path)
    if (match === null) continue
    const params: Record<string, string> = {}
    route.parameters.forEach((parameter, index) => {
      params[parameter.name] = decodeParam(match[index + 1] ?? '')
    })
    return { route, params }
  }
  return undefined
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Methods registered for a concrete path (for 405 responses and the `Allow` header). `HEAD` is
 * listed whenever `GET` is.
 *
 * @example
 * allowedMethods(routes, '/api/posts') // ['GET', 'HEAD', 'POST']
 */
export function allowedMethods(routes: readonly CompiledRoute[], path: string): string[] {
  const methods = new Set<string>()
  for (const route of routes) {
    if (!route.pattern.test(path)) continue
    for (const method of route.methods) {
      methods.add(method)
      if (method === 'GET') methods.add('HEAD')
    }
  }
  return [...methods]
}

/**
 * The fallback for a path, if one serves it: the path is under its prefix and under none of its
 * excluded prefixes (so a web fallback never answers `/api/…` or `/_strutvane/…`).
 *
 * @example
 * fallbackFor(table.fallbacks, '/some/page')?.route
 */
export function fallbackFor(
  fallbacks: readonly CompiledFallback[],
  path: string,
): CompiledFallback | undefined {
  const under = (prefix: string): boolean =>
    prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)
  // The most specific prefix wins (an API fallback over the web one).
  return [...fallbacks]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((fallback) => under(fallback.prefix) && !fallback.excludes.some(under))
}

/**
 * `PostController@show`, `ImportController` (invokable) or `Closure`, for `route:list` and
 * error pages.
 *
 * @example
 * actionLabel({ kind: 'controller', controller: PostController, method: 'show' }) // 'PostController@show'
 */
export function actionLabel(action: CompiledAction): string {
  if (action.kind === 'closure') return 'Closure'
  return action.method === INVOKE_METHOD
    ? action.controller.name
    : `${action.controller.name}@${action.method}`
}

function assertUnique(table: readonly CompiledRoute[]): void {
  const names = new Map<string, CompiledRoute>()
  const endpoints = new Map<string, CompiledRoute>()
  for (const route of table) {
    if (route.name !== undefined) {
      const other = names.get(route.name)
      if (other !== undefined) {
        throw new BootError(
          'duplicate_route_name',
          `Two routes are named "${route.name}": ${other.uri} and ${route.uri}.`,
          'Route names must be unique, because route() would not know which URL to build. Rename one of them.',
        )
      }
      names.set(route.name, route)
    }
    for (const method of route.methods) {
      // Placeholders are normalised so /posts/{post} and /posts/{id} count as the same endpoint.
      const key = `${method} ${route.uri.replace(PLACEHOLDER, '{}')}`
      if (endpoints.has(key)) {
        throw new BootError(
          'duplicate_route',
          `${method} ${route.uri} is registered twice.`,
          'The second one could never run. Remove it, or change its path or method.',
        )
      }
      endpoints.set(key, route)
    }
  }
}

/**
 * The friendly error for an unknown route name, with a "did you mean".
 *
 * @example
 * throw unknownRouteName('posts.shwo', ['posts.show'])
 */
export function unknownRouteName(name: string, known: readonly string[]): BootError {
  const suggestion = closestMatch(name, known)
  return new BootError(
    'unknown_route_name',
    `No route is named "${name}".`,
    suggestion === undefined
      ? "Name the route with .name('…') in routes/web.ts or routes/api.ts, then run `node strut route:list` to check."
      : `Did you mean "${suggestion}"?`,
  )
}
