/**
 * The `Route` builder used in `routes/web.ts` and `routes/api.ts`, in both of Laravel's styles:
 *
 * ```ts
 * // A callback (CONSISTENCY #46, #106): routes register as you call Route.*.
 * export default (router: Router) => {
 *   router.get('/', [HomeController, 'index']).name('home')
 *   router.middleware('auth').group(() => {
 *     router.apiResource('posts', PostController)
 *   })
 * }
 *
 * // A value: every name and parameter stays typed for route().
 * export default defineRoutes([
 *   Route.get('/', [HomeController, 'index']).name('home'),
 *   Route.group({ prefix: 'admin', name: 'admin.' }, [ … ]),
 * ])
 * ```
 *
 * **How both styles share one implementation: a collector.** Every builder call *returns* an
 * immutable entry. While a routes callback or a group callback runs, each new entry is also
 * registered with the active collector; `.name()`/`.middleware()` replace the entry they were
 * called on (so the collector holds the final version), and an entry placed inside an array group
 * or list is *adopted*: removed from the enclosing collector, so nothing registers twice.
 * Outside any callback nothing is registered anywhere, so routes files can be imported twice
 * (tests, `route:list`) with no global state. Callbacks must be synchronous: routes are a table,
 * not a process.
 *
 * @module
 */
import { BootError } from '../foundation/boot-error.ts'
import { singular } from '../support/str.ts'
import type {
  ApiResourceAction,
  CollectionPath,
  ControllerClass,
  ControllerWith,
  HasSignatures,
  MemberPath,
  PrefixSignatures,
  ResourceAction,
  ResourceParam,
  ResourceSignature,
  RouteAction,
  RouteSignature,
  SignaturesOf,
  SingletonAction,
  SingletonSignature,
  StoredAction,
  UntypedRoutes,
} from './types.ts'

/**
 * The HTTP methods a route can answer. `HEAD` is answered by every `GET` route automatically.
 *
 * @example
 * const method: HttpMethod = 'PATCH'
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** Every method `Route.any()` answers, in Laravel's order. */
const ANY_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const METHODS: ReadonlySet<string> = new Set(ANY_METHODS)

/**
 * Any route entry: a route, a group, a resource, a singleton or a fallback.
 *
 * Groups and resources use `unknown` for their signatures: every entry satisfies it, which gives
 * an "any entry" type without `any`.
 *
 * @example
 * const entries: RouteEntry[] = [Route.get('/', handler)]
 */
export type RouteEntry =
  | DefinedRoute<string, string>
  | RouteGroup<unknown>
  | ResourceRoutes<unknown>
  | SingletonRoutes<unknown>
  | FallbackRoute

/**
 * A routes callback: Laravel's `routes/web.php` body. It may register routes (`router.get(…)`) or
 * return an array of entries, or both.
 *
 * @example
 * const web: RoutesCallback = (router) => { router.get('/', handler).name('home') }
 */
export type RoutesCallback = (router: Router) => unknown

// ---------------------------------------------------------------------------------------------
// The collector.

interface Collector {
  readonly entries: RouteEntry[]
}

const collectors: Collector[] = []

function register<TEntry extends RouteEntry>(entry: TEntry): TEntry {
  collectors.at(-1)?.entries.push(entry)
  return entry
}

function replace<TEntry extends RouteEntry>(previous: RouteEntry, next: TEntry): TEntry {
  const collector = collectors.at(-1)
  if (collector !== undefined) {
    const index = collector.entries.indexOf(previous)
    if (index !== -1) collector.entries[index] = next
  }
  return next
}

function adopt(entries: readonly RouteEntry[]): void {
  const collector = collectors.at(-1)
  if (collector === undefined) return
  for (const entry of entries) {
    const index = collector.entries.indexOf(entry)
    if (index !== -1) collector.entries.splice(index, 1)
  }
}

/**
 * Run a routes callback and return every entry it registered (and any it returned), in order.
 * Throws a `BootError` for an asynchronous callback or a returned value that isn't a list of
 * route entries.
 *
 * @example
 * const entries = collectRoutes((router) => { router.get('/', handler) })
 */
export function collectRoutes(callback: RoutesCallback): RouteEntry[] {
  const collector: Collector = { entries: [] }
  collectors.push(collector)
  let returned: unknown
  try {
    returned = callback(Route)
  } finally {
    collectors.pop()
  }
  if (returned instanceof Promise) {
    returned.catch(() => undefined)
    throw new BootError(
      'async_routes',
      'A routes callback returned a Promise.',
      'Routes are declared synchronously: remove `async` from the routes callback (load data in a controller instead).',
    )
  }
  const entries = [...collector.entries]
  if (returned === undefined) return entries
  if (!Array.isArray(returned) || !returned.every(isRouteEntry)) {
    throw new BootError(
      'invalid_routes',
      'A routes callback returned something other than a list of routes.',
      'Either register routes inside the callback (router.get(…)) or return an array of them.',
    )
  }
  for (const entry of returned) if (!entries.includes(entry)) entries.push(entry)
  return entries
}

/**
 * `true` for anything the `Route` builder made.
 *
 * @example
 * isRouteEntry(Route.get('/', handler)) // true
 */
export function isRouteEntry(value: unknown): value is RouteEntry {
  return (
    value instanceof DefinedRoute ||
    value instanceof RouteGroup ||
    value instanceof ResourceRoutes ||
    value instanceof SingletonRoutes ||
    value instanceof FallbackRoute
  )
}

// ---------------------------------------------------------------------------------------------
// Entries.

interface RouteInit<TPath extends string> {
  readonly methods: readonly HttpMethod[]
  readonly path: TPath
  readonly action: StoredAction
  readonly routeName: string | undefined
  readonly middleware: readonly string[]
  readonly excluded: readonly string[]
  readonly withTrashed?: boolean
}

/**
 * One route. Immutable: `.name()` and `.middleware()` return a new definition (and, inside a
 * routes callback, replace this one in it).
 *
 * @example
 * Route.get('/posts/{post:slug}', [PostController, 'show']).name('posts.show').middleware('auth:optional')
 */
export class DefinedRoute<TName extends string, TPath extends string>
  implements HasSignatures<RouteSignature<TName, TPath>>
{
  declare readonly __routes: RouteSignature<TName, TPath>
  /** The entry kind, for the route compiler. */
  readonly kind = 'route' as const
  /** The methods this route answers. */
  readonly methods: readonly HttpMethod[]
  /** The path, relative to its groups. */
  readonly path: TPath
  /** The closure, controller pair or invokable controller. */
  readonly action: StoredAction
  /** The route name, if `.name()` was called. */
  readonly routeName: string | undefined
  /** Middleware references added on this route. */
  readonly middlewareList: readonly string[]
  /** Aliases this route opts out of (`.withoutMiddleware('csrf')`), flagged by `route:list --security`. */
  readonly excludedMiddleware: readonly string[]
  /** Route model binding also finds soft-deleted rows (`.withTrashed()`). */
  readonly bindsTrashed: boolean

  constructor(init: RouteInit<TPath>) {
    this.methods = init.methods
    this.path = init.path
    this.action = init.action
    this.routeName = init.routeName
    this.middlewareList = init.middleware
    this.excludedMiddleware = init.excluded
    this.bindsTrashed = init.withTrashed === true
  }

  /**
   * Name the route, so `route('posts.show', …)` can build its URL.
   *
   * @example
   * Route.get('/', [HomeController, 'index']).name('home')
   */
  name<const TNewName extends string>(name: TNewName): DefinedRoute<TNewName, TPath> {
    return replace(this, new DefinedRoute<TNewName, TPath>({ ...this.#init(), routeName: name }))
  }

  /**
   * Add middleware by alias (`'auth'`, `'throttle:60,1'`, `'can:view-stats'`).
   *
   * @example
   * Route.post('/posts', [PostController, 'store']).middleware('auth')
   */
  middleware(...references: string[]): DefinedRoute<TName, TPath> {
    return replace(
      this,
      new DefinedRoute<TName, TPath>({
        ...this.#init(),
        middleware: [...this.middlewareList, ...references],
      }),
    )
  }

  /**
   * Opt this route out of middleware its groups add, by alias (Laravel's `withoutMiddleware`).
   * Opting out is always explicit, and `node strut route:list --security` flags it.
   *
   * @example
   * Route.post('/webhooks/stripe', [StripeWebhookController, 'handle']).withoutMiddleware('csrf')
   */
  withoutMiddleware(...aliases: string[]): DefinedRoute<TName, TPath> {
    return replace(
      this,
      new DefinedRoute<TName, TPath>({
        ...this.#init(),
        excluded: [...this.excludedMiddleware, ...aliases],
      }),
    )
  }

  /**
   * Let route model binding find soft-deleted rows too (Laravel's `->withTrashed()`): what a
   * `restore` route needs, since every other route answers 404 for a deleted row.
   *
   * @example
   * Route.post('/posts/{post}/restore', [PostController, 'restore']).withTrashed()
   */
  withTrashed(): DefinedRoute<TName, TPath> {
    return replace(this, new DefinedRoute<TName, TPath>({ ...this.#init(), withTrashed: true }))
  }

  #init(): RouteInit<TPath> {
    return {
      methods: this.methods,
      path: this.path,
      action: this.action,
      routeName: this.routeName,
      middleware: this.middlewareList,
      excluded: this.excludedMiddleware,
      withTrashed: this.bindsTrashed,
    }
  }
}

/**
 * Options for {@link Router.group}, Laravel's `Route::prefix()->middleware()->name()->group()`.
 *
 * @example
 * const options: GroupOptions = { prefix: 'admin', middleware: ['auth'], name: 'admin.' }
 */
export interface GroupOptions<
  TPrefix extends string = string,
  TNamePrefix extends string = string,
> {
  /** Path prefix; slashes at either end are fine: `'admin'`. */
  readonly prefix?: TPrefix
  /** Prefix for every route name inside, usually ending in a dot: `'admin.'`. */
  readonly name?: TNamePrefix
  /** Middleware for every route inside. */
  readonly middleware?: readonly string[]
  /** Aliases every route inside opts out of (flagged by `route:list --security`). */
  readonly withoutMiddleware?: readonly string[]
}

/**
 * A group of routes sharing a prefix, a name prefix and middleware.
 *
 * @example
 * Route.group({ prefix: 'admin', name: 'admin.' }, [Route.get('/', [AdminController, 'index']).name('home')])
 */
export class RouteGroup<TSignatures> implements HasSignatures<TSignatures> {
  declare readonly __routes: TSignatures
  /** The entry kind, for the route compiler. */
  readonly kind = 'group' as const
  /** The path prefix. */
  readonly prefix: string
  /** The name prefix. */
  readonly namePrefix: string
  /** Middleware for every route inside. */
  readonly middlewareList: readonly string[]
  /** Aliases every route inside opts out of. */
  readonly excludedMiddleware: readonly string[]
  /** The routes inside, in order. */
  readonly entries: readonly RouteEntry[]

  constructor(options: GroupOptions, entries: readonly RouteEntry[]) {
    this.prefix = options.prefix ?? ''
    this.namePrefix = options.name ?? ''
    this.middlewareList = options.middleware ?? []
    this.excludedMiddleware = options.withoutMiddleware ?? []
    this.entries = entries
  }
}

/**
 * Options for {@link Router.resource} and {@link Router.apiResource}.
 *
 * @example
 * const options: ResourceOptions<'index' | 'show', never, 'post', false> = { only: ['index', 'show'], bindBy: 'slug' }
 */
export interface ResourceOptions<
  TOnly extends ResourceAction,
  TExcept extends ResourceAction,
  TParam extends string,
  TShallow extends boolean,
> {
  /** Register only these actions. */
  readonly only?: readonly TOnly[]
  /** Register every action except these. */
  readonly except?: readonly TExcept[]
  /** The URL parameter name, for words the simple singular rule gets wrong (`people` → `person`). */
  readonly parameter?: TParam
  /** Bind the parameter by this column instead of the model's route key: `{post:slug}`. */
  readonly bindBy?: string
  /**
   * For a nested resource (`posts.comments`): member routes drop the parent
   * (`/comments/{comment}` instead of `/posts/{post}/comments/{comment}`), Laravel's `shallow()`.
   */
  readonly shallow?: TShallow
}

/**
 * One resolved resource action, ready for the router.
 *
 * @example
 * const row: ResourceActionRoute = { action: 'show', methods: ['GET'], path: '/posts/{post}' }
 */
export interface ResourceActionRoute {
  readonly action: ResourceAction
  readonly methods: readonly HttpMethod[]
  readonly path: string
}

interface ResourceInit {
  readonly resourceName: string
  readonly controller: ControllerClass
  readonly routes: readonly ResourceActionRoute[]
  readonly middleware: readonly string[]
  readonly middlewareByAction: Readonly<Partial<Record<ResourceAction, readonly string[]>>>
  readonly excluded: readonly string[]
}

/**
 * The shared fluent half of resources and singletons: middleware for all or some actions, and
 * opt-outs.
 */
abstract class ActionRoutes {
  /** The resource name (`posts`, `posts.comments`, `profile`). */
  readonly resourceName: string
  /** The controller class. */
  readonly controller: ControllerClass
  /** The generated routes, in match order. */
  readonly routes: readonly ResourceActionRoute[]
  /** Middleware for every action. */
  readonly middlewareList: readonly string[]
  /** Middleware for some actions only. */
  readonly middlewareByAction: Readonly<Partial<Record<ResourceAction, readonly string[]>>>
  /** Aliases every action opts out of. */
  readonly excludedMiddleware: readonly string[]

  constructor(init: ResourceInit) {
    this.resourceName = init.resourceName
    this.controller = init.controller
    this.routes = init.routes
    this.middlewareList = init.middleware
    this.middlewareByAction = init.middlewareByAction
    this.excludedMiddleware = init.excluded
  }

  protected init(): ResourceInit {
    return {
      resourceName: this.resourceName,
      controller: this.controller,
      routes: this.routes,
      middleware: this.middlewareList,
      middlewareByAction: this.middlewareByAction,
      excluded: this.excludedMiddleware,
    }
  }

  protected withMiddleware(references: readonly string[]): ResourceInit {
    return { ...this.init(), middleware: [...this.middlewareList, ...references] }
  }

  protected withActionMiddleware(
    actions: readonly ResourceAction[],
    references: readonly string[],
  ): ResourceInit {
    const byAction: Partial<Record<ResourceAction, readonly string[]>> = {
      ...this.middlewareByAction,
    }
    for (const action of actions) byAction[action] = [...(byAction[action] ?? []), ...references]
    return { ...this.init(), middlewareByAction: byAction }
  }

  protected withExcluded(aliases: readonly string[]): ResourceInit {
    return { ...this.init(), excluded: [...this.excludedMiddleware, ...aliases] }
  }
}

/**
 * The routes `Route.resource` / `Route.apiResource` generate.
 *
 * @example
 * Route.apiResource('posts', PostController).middlewareFor(['store', 'update', 'destroy'], 'auth')
 */
export class ResourceRoutes<TSignatures>
  extends ActionRoutes
  implements HasSignatures<TSignatures>
{
  declare readonly __routes: TSignatures
  /** The entry kind, for the route compiler. */
  readonly kind = 'resource' as const

  /**
   * Middleware for every action of the resource.
   *
   * @example
   * Route.apiResource('posts', PostController).middleware('auth')
   */
  middleware(...references: string[]): ResourceRoutes<TSignatures> {
    return replace(this, new ResourceRoutes<TSignatures>(this.withMiddleware(references)))
  }

  /**
   * Middleware for some actions only, Laravel 12's `->middlewareFor()`.
   *
   * @example
   * Route.apiResource('posts', PostController).middlewareFor(['store', 'update', 'destroy'], 'auth')
   */
  middlewareFor(
    actions: readonly ResourceAction[],
    ...references: string[]
  ): ResourceRoutes<TSignatures> {
    return replace(
      this,
      new ResourceRoutes<TSignatures>(this.withActionMiddleware(actions, references)),
    )
  }

  /**
   * Opt every action of the resource out of group middleware, by alias.
   *
   * @example
   * Route.apiResource('imports', ImportController).withoutMiddleware('throttle')
   */
  withoutMiddleware(...aliases: string[]): ResourceRoutes<TSignatures> {
    return replace(this, new ResourceRoutes<TSignatures>(this.withExcluded(aliases)))
  }
}

/**
 * The routes `Route.singleton` / `Route.apiSingleton` generate: one record with no id
 * (`/profile`, `/profile/edit`). `.creatable()` adds create, store and destroy.
 *
 * @example
 * Route.singleton('profile', ProfileController).creatable()
 */
export class SingletonRoutes<TSignatures>
  extends ActionRoutes
  implements HasSignatures<TSignatures>
{
  declare readonly __routes: TSignatures
  /** The entry kind, for the route compiler. */
  readonly kind = 'singleton' as const
  /** `true` for `apiSingleton` (no form pages). */
  readonly api: boolean

  constructor(init: ResourceInit, api: boolean) {
    super(init)
    this.api = api
  }

  /**
   * Make the singleton creatable and deletable, Laravel's `->creatable()`: adds `store` and
   * `destroy` (and `create` for the non-API form page).
   *
   * @example
   * Route.singleton('profile', ProfileController).creatable()
   */
  creatable(): SingletonRoutes<
    TSignatures | SingletonSignature<string, 'create' | 'store' | 'destroy'>
  > {
    const routes = singletonRoutes(
      this.resourceName,
      this.api
        ? ['show', 'store', 'update', 'destroy']
        : ['create', 'store', 'show', 'edit', 'update', 'destroy'],
    )
    return replace(this, new SingletonRoutes({ ...this.init(), routes }, this.api))
  }

  /**
   * Middleware for every action.
   *
   * @example
   * Route.singleton('profile', ProfileController).middleware('auth')
   */
  middleware(...references: string[]): SingletonRoutes<TSignatures> {
    return replace(
      this,
      new SingletonRoutes<TSignatures>(this.withMiddleware(references), this.api),
    )
  }

  /**
   * Middleware for some actions only.
   *
   * @example
   * Route.singleton('profile', ProfileController).middlewareFor(['update'], 'auth')
   */
  middlewareFor(
    actions: readonly SingletonAction[],
    ...references: string[]
  ): SingletonRoutes<TSignatures> {
    return replace(
      this,
      new SingletonRoutes<TSignatures>(this.withActionMiddleware(actions, references), this.api),
    )
  }

  /**
   * Opt every action out of group middleware, by alias.
   *
   * @example
   * Route.singleton('settings', SettingsController).withoutMiddleware('throttle')
   */
  withoutMiddleware(...aliases: string[]): SingletonRoutes<TSignatures> {
    return replace(this, new SingletonRoutes<TSignatures>(this.withExcluded(aliases), this.api))
  }
}

/**
 * The route answering every `GET`/`HEAD` nothing else matched, Laravel's `Route::fallback()`.
 * It never answers a path some route serves with another method (that stays a 405), and a
 * fallback in `routes/web.ts` never answers API paths (they stay problem+json 404s).
 *
 * @example
 * Route.fallback([SpaController, 'show'])
 */
export class FallbackRoute implements HasSignatures<never> {
  declare readonly __routes: never
  /** The entry kind, for the route compiler. */
  readonly kind = 'fallback' as const
  /** The closure, controller pair or invokable controller. */
  readonly action: StoredAction
  /** Middleware for the fallback. */
  readonly middlewareList: readonly string[]

  constructor(action: StoredAction, middleware: readonly string[]) {
    this.action = action
    this.middlewareList = middleware
  }

  /**
   * Add middleware to the fallback.
   *
   * @example
   * Route.fallback(handler).middleware('auth:optional')
   */
  middleware(...references: string[]): FallbackRoute {
    return replace(this, new FallbackRoute(this.action, [...this.middlewareList, ...references]))
  }
}

/**
 * A whole routes file: what `defineRoutes` returns.
 *
 * @example
 * export default defineRoutes([Route.get('/', [HomeController, 'index']).name('home')])
 */
export class RouteList<TSignatures> implements HasSignatures<TSignatures> {
  declare readonly __routes: TSignatures
  /** The entries, in registration order. */
  readonly entries: readonly RouteEntry[]

  constructor(entries: readonly RouteEntry[]) {
    this.entries = entries
  }
}

/**
 * What `withRouting({ web, api })` and `app.addRoutes()` accept: a list, or a callback.
 *
 * @example
 * const web: RoutesSource = (router) => { router.get('/', handler) }
 */
export type RoutesSource = RouteList<unknown> | RoutesCallback

/**
 * Declare a routes file from an array (every name and parameter typed) or a callback (names typed
 * only when the callback returns the array).
 *
 * @example
 * export default defineRoutes([Route.apiResource('posts', PostController)])
 * export default defineRoutes((router) => { router.get('/', handler).name('home') })
 */
export function defineRoutes<const TEntries extends readonly RouteEntry[]>(
  entries: TEntries | ((router: Router) => TEntries),
): RouteList<SignaturesOf<TEntries[number]>>
export function defineRoutes(callback: (router: Router) => void): RouteList<UntypedRoutes>
export function defineRoutes(source: readonly RouteEntry[] | RoutesCallback): RouteList<unknown> {
  if (typeof source === 'function') return new RouteList(collectRoutes(source))
  assertEntries(source)
  adopt(source)
  return new RouteList(source)
}

/**
 * The entries of a routes source, running a callback under a fresh collector.
 *
 * @example
 * routeEntries(web) // RouteEntry[]
 */
export function routeEntries(source: RoutesSource): readonly RouteEntry[] {
  if (source instanceof RouteList) return source.entries
  if (typeof source === 'function') return collectRoutes(source)
  throw new BootError(
    'invalid_routes',
    'withRouting() was given something that is neither a routes list nor a routes callback.',
    'Export defineRoutes([...]) or a (router) => { … } callback from the routes file.',
  )
}

function assertEntries(entries: readonly unknown[]): void {
  if (!Array.isArray(entries) || !entries.every(isRouteEntry))
    throw new BootError(
      'invalid_routes',
      'A route list contains something that is not a route.',
      'Build every entry with Route.get(), Route.group(), Route.resource() and friends.',
    )
}

// ---------------------------------------------------------------------------------------------
// Resource tables.

/** Laravel's resource table: action → methods and path. The order is the match order. */
const RESOURCE_TABLE: readonly {
  readonly action: ResourceAction
  readonly methods: readonly HttpMethod[]
  readonly member: boolean
  readonly suffix: string
}[] = [
  { action: 'index', methods: ['GET'], member: false, suffix: '' },
  { action: 'create', methods: ['GET'], member: false, suffix: '/create' },
  { action: 'store', methods: ['POST'], member: false, suffix: '' },
  { action: 'show', methods: ['GET'], member: true, suffix: '' },
  { action: 'edit', methods: ['GET'], member: true, suffix: '/edit' },
  { action: 'update', methods: ['PUT', 'PATCH'], member: true, suffix: '' },
  { action: 'destroy', methods: ['DELETE'], member: true, suffix: '' },
]

const API_ACTIONS: readonly ApiResourceAction[] = ['index', 'store', 'show', 'update', 'destroy']
const ALL_ACTIONS: readonly ResourceAction[] = RESOURCE_TABLE.map((row) => row.action)
const SEGMENT = '[a-z][a-z0-9_-]*'
const RESOURCE_NAME = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})?$`)
const SINGLETON_NAME = new RegExp(`^${SEGMENT}$`)

function invalidName(name: string, kind: 'resource' | 'singleton'): BootError {
  return new BootError(
    'invalid_resource_name',
    `"${name}" is not a valid ${kind} name.`,
    kind === 'resource'
      ? "Use the plural, lower-case table-style name (Route.resource('posts', PostController)), or one level of nesting ('posts.comments')."
      : "Use a lower-case name such as Route.singleton('profile', ProfileController).",
  )
}

function buildResource<TSignatures>(
  name: string,
  controller: ControllerClass,
  allowed: readonly ResourceAction[],
  options: ResourceOptions<ResourceAction, ResourceAction, string, boolean>,
): ResourceRoutes<TSignatures> {
  if (typeof name !== 'string' || !RESOURCE_NAME.test(name))
    throw invalidName(String(name), 'resource')
  const [parent, child] = name.includes('.') ? name.split('.') : [undefined, name]
  const last = child ?? name
  const collection = parent === undefined ? `/${last}` : `/${parent}/{${singular(parent)}}/${last}`
  const member = options.shallow === true ? `/${last}` : collection
  const only = options.only ?? allowed
  const except = new Set(options.except ?? [])
  const parameter = options.parameter ?? singular(last)
  const placeholder = options.bindBy === undefined ? parameter : `${parameter}:${options.bindBy}`
  const routes = RESOURCE_TABLE.filter(
    (row) => allowed.includes(row.action) && only.includes(row.action) && !except.has(row.action),
  ).map((row) => ({
    action: row.action,
    methods: row.methods,
    path: row.member ? `${member}/{${placeholder}}${row.suffix}` : `${collection}${row.suffix}`,
  }))
  return register(
    new ResourceRoutes<TSignatures>({
      resourceName: name,
      controller,
      routes,
      middleware: [],
      middlewareByAction: {},
      excluded: [],
    }),
  )
}

function singletonRoutes(name: string, actions: readonly SingletonAction[]): ResourceActionRoute[] {
  return RESOURCE_TABLE.filter((row) => (actions as readonly string[]).includes(row.action)).map(
    (row) => ({
      action: row.action,
      methods: row.methods,
      path: `/${name}${row.suffix}`,
    }),
  )
}

function buildSingleton<TSignatures>(
  name: string,
  controller: ControllerClass,
  api: boolean,
): SingletonRoutes<TSignatures> {
  if (typeof name !== 'string' || !SINGLETON_NAME.test(name))
    throw invalidName(String(name), 'singleton')
  const routes = singletonRoutes(name, api ? ['show', 'update'] : ['show', 'edit', 'update'])
  return register(
    new SingletonRoutes<TSignatures>(
      {
        resourceName: name,
        controller,
        routes,
        middleware: [],
        middlewareByAction: {},
        excluded: [],
      },
      api,
    ),
  )
}

function single<const TPath extends string>(
  methods: readonly HttpMethod[],
  path: TPath,
  action: StoredAction,
): DefinedRoute<never, TPath> {
  for (const method of methods)
    if (!METHODS.has(method))
      throw new BootError(
        'invalid_route_method',
        `"${String(method)}" is not an HTTP method a route can answer.`,
        `Use ${ANY_METHODS.join(', ')} (HEAD is answered by every GET route).`,
      )
  if (typeof path !== 'string')
    throw new BootError(
      'invalid_route_path',
      'A route path must be a string.',
      "Write it as '/posts/{post}'.",
    )
  return register(
    new DefinedRoute<never, TPath>({
      methods: [...new Set(methods)],
      path,
      action,
      routeName: undefined,
      middleware: [],
      excluded: [],
    }),
  )
}

// ---------------------------------------------------------------------------------------------
// Groups.

/**
 * A group being built fluently, Laravel's `Route::prefix('admin')->middleware([...])->group(...)`.
 * `.group()` takes a callback (routes register inside it) or an array.
 *
 * @example
 * Route.middleware('csrf', 'auth').group(() => { Route.post('/import', handler) })
 */
export class PendingGroup {
  readonly #options: GroupOptions

  constructor(options: GroupOptions) {
    this.#options = options
  }

  /**
   * Add middleware for every route in the group.
   *
   * @example
   * Route.prefix('admin').middleware('auth').group(() => { … })
   */
  middleware(...references: string[]): PendingGroup {
    return new PendingGroup({
      ...this.#options,
      middleware: [...(this.#options.middleware ?? []), ...references],
    })
  }

  /**
   * Opt every route in the group out of these aliases.
   *
   * @example
   * Route.middleware('auth').withoutMiddleware('csrf').group(() => { … })
   */
  withoutMiddleware(...aliases: string[]): PendingGroup {
    return new PendingGroup({
      ...this.#options,
      withoutMiddleware: [...(this.#options.withoutMiddleware ?? []), ...aliases],
    })
  }

  /**
   * Prefix every path in the group.
   *
   * @example
   * Route.middleware('auth').prefix('admin').group(() => { … })
   */
  prefix(prefix: string): PendingGroup {
    return new PendingGroup({ ...this.#options, prefix: joinPrefix(this.#options.prefix, prefix) })
  }

  /**
   * Prefix every route name in the group.
   *
   * @example
   * Route.prefix('admin').name('admin.').group(() => { … })
   */
  name(prefix: string): PendingGroup {
    return new PendingGroup({ ...this.#options, name: `${this.#options.name ?? ''}${prefix}` })
  }

  /**
   * Close the group over its routes: a callback (Laravel's style) or an array.
   *
   * @example
   * Route.middleware('csrf').group(() => { Route.post('/import', [ImportController, 'store']) })
   */
  group<const TEntries extends readonly RouteEntry[]>(
    entries: TEntries | ((router: Router) => TEntries),
  ): RouteGroup<PrefixSignatures<SignaturesOf<TEntries[number]>, string, string>>
  group(callback: (router: Router) => void): RouteGroup<UntypedRoutes>
  group(source: readonly RouteEntry[] | RoutesCallback): RouteGroup<unknown> {
    return makeGroup(this.#options, source)
  }
}

function joinPrefix(left: string | undefined, right: string): string {
  return [left ?? '', right].filter((part) => part !== '').join('/')
}

function makeGroup(
  options: GroupOptions,
  source: readonly RouteEntry[] | RoutesCallback,
): RouteGroup<unknown> {
  let entries: readonly RouteEntry[]
  if (typeof source === 'function') entries = collectRoutes(source)
  else {
    assertEntries(source)
    adopt(source)
    entries = source
  }
  return register(new RouteGroup(options, entries))
}

// ---------------------------------------------------------------------------------------------
// The builder.

/**
 * The route builder's shape (`Route`, and the `router` a routes callback receives).
 *
 * @example
 * export default (router: Router) => { router.get('/', handler) }
 */
export interface Router {
  /** A GET route (HEAD is answered too). */
  get<const TPath extends string, TController extends ControllerClass>(
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** A POST route. */
  post<const TPath extends string, TController extends ControllerClass>(
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** A PUT route. */
  put<const TPath extends string, TController extends ControllerClass>(
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** A PATCH route. */
  patch<const TPath extends string, TController extends ControllerClass>(
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** A DELETE route. */
  delete<const TPath extends string, TController extends ControllerClass>(
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** An OPTIONS route. */
  options<const TPath extends string, TController extends ControllerClass>(
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** One route answering several methods: `Route.match(['GET', 'POST'], '/search', …)`. */
  match<const TPath extends string, TController extends ControllerClass>(
    methods: readonly HttpMethod[],
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** One route answering every method. */
  any<const TPath extends string, TController extends ControllerClass>(
    path: TPath,
    action: RouteAction<TController>,
  ): DefinedRoute<never, TPath>
  /** The route for every unmatched `GET`/`HEAD` in this routes file, registered last. */
  fallback<TController extends ControllerClass>(action: RouteAction<TController>): FallbackRoute
  /** Start a fluent group with middleware. */
  middleware(...references: string[]): PendingGroup
  /** Start a fluent group that opts out of middleware. */
  withoutMiddleware(...aliases: string[]): PendingGroup
  /** Start a fluent group with a path prefix. */
  prefix(prefix: string): PendingGroup
  /** Start a fluent group with a name prefix. */
  name(prefix: string): PendingGroup
  /** Group routes under a shared prefix, name prefix and middleware (callback or array). */
  group<
    const TPrefix extends string = '',
    const TNamePrefix extends string = '',
    const TEntries extends readonly RouteEntry[] = readonly [],
  >(
    options: GroupOptions<TPrefix, TNamePrefix>,
    entries: TEntries | ((router: Router) => TEntries),
  ): RouteGroup<PrefixSignatures<SignaturesOf<TEntries[number]>, TNamePrefix, TPrefix>>
  group(options: GroupOptions, callback: (router: Router) => void): RouteGroup<UntypedRoutes>
  /** The seven resource routes (index, create, store, show, edit, update, destroy). */
  resource<
    const TName extends string,
    const TOnly extends ResourceAction = ResourceAction,
    const TExcept extends ResourceAction = never,
    const TParam extends string = ResourceParam<TName>,
    const TShallow extends boolean = false,
  >(
    name: TName,
    controller: ControllerWith<NoInfer<Exclude<TOnly, TExcept>>>,
    options?: ResourceOptions<TOnly, TExcept, TParam, TShallow>,
  ): ResourceRoutes<
    ResourceSignature<
      TName,
      CollectionPath<TName>,
      MemberPath<TName, TShallow>,
      TParam,
      Exclude<TOnly, TExcept>
    >
  >
  /** The five API resource routes (no `create`/`edit` form pages). */
  apiResource<
    const TName extends string,
    const TOnly extends ApiResourceAction = ApiResourceAction,
    const TExcept extends ApiResourceAction = never,
    const TParam extends string = ResourceParam<TName>,
    const TShallow extends boolean = false,
  >(
    name: TName,
    controller: ControllerWith<NoInfer<Exclude<TOnly, TExcept>>>,
    options?: ResourceOptions<TOnly, TExcept, TParam, TShallow>,
  ): ResourceRoutes<
    ResourceSignature<
      TName,
      CollectionPath<TName>,
      MemberPath<TName, TShallow>,
      TParam,
      Exclude<TOnly, TExcept>
    >
  >
  /** A singleton resource: show, edit and update one record with no id. */
  singleton<const TName extends string>(
    name: TName,
    controller: ControllerWith<'show' | 'edit' | 'update'>,
  ): SingletonRoutes<SingletonSignature<TName, 'show' | 'edit' | 'update'>>
  /** An API singleton: show and update (no form pages). */
  apiSingleton<const TName extends string>(
    name: TName,
    controller: ControllerWith<'show' | 'update'>,
  ): SingletonRoutes<SingletonSignature<TName, 'show' | 'update'>>
}

/**
 * The route builder. Every method returns a value; inside a routes or group callback the value is
 * also registered there.
 *
 * @example
 * Route.get('/posts', [PostController, 'index']).name('posts.index')
 * Route.middleware('auth').group(() => { Route.apiResource('posts', PostController) })
 */
export const Route: Router = {
  get: (path, action) => single(['GET'], path, action),
  post: (path, action) => single(['POST'], path, action),
  put: (path, action) => single(['PUT'], path, action),
  patch: (path, action) => single(['PATCH'], path, action),
  delete: (path, action) => single(['DELETE'], path, action),
  options: (path, action) => single(['OPTIONS'], path, action),
  match: (methods, path, action) => single(methods, path, action),
  any: (path, action) => single(ANY_METHODS, path, action),
  fallback: (action) => register(new FallbackRoute(action, [])),
  middleware: (...references) => new PendingGroup({ middleware: references }),
  withoutMiddleware: (...aliases) => new PendingGroup({ withoutMiddleware: aliases }),
  prefix: (prefix) => new PendingGroup({ prefix }),
  name: (prefix) => new PendingGroup({ name: prefix }),
  group: (options: GroupOptions, source: readonly RouteEntry[] | RoutesCallback) =>
    makeGroup(options, source),
  resource: (name, controller, options = {}) =>
    buildResource(name, controller, ALL_ACTIONS, options),
  apiResource: (name, controller, options = {}) =>
    buildResource(name, controller, API_ACTIONS, options),
  singleton: (name, controller) => buildSingleton(name, controller, false),
  apiSingleton: (name, controller) => buildSingleton(name, controller, true),
} as Router
