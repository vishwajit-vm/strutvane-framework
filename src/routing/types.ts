/**
 * The type-level half of routing: how `'/posts/{post:slug}'` becomes `{ post: RouteParam }`, how
 * groups prefix names, and how a routes file turns into the `RouteRegistry` that types
 * `route('posts.show', { post })`.
 *
 * None of this exists at runtime. Every runtime route object carries a phantom `__routes` field
 * (declared, never assigned) holding a union of {@link RouteSignature}s, and these helpers fold
 * those unions together.
 *
 * **The callback trade-off.** A routes file written as a `(router) => { … }` callback (Laravel's
 * style, CONSISTENCY #46) registers routes as side effects, so the compiler can't see their names:
 * such a file contributes `string` names (any name is accepted). A file written as a value
 * (`defineRoutes([...])`, or a callback that *returns* the array) keeps every name and parameter
 * typed. Both run the same at runtime.
 *
 * @module
 */
import type { Injectable } from '../foundation/inject.ts'
import type { HttpContext } from '../http/app/context.ts'

/**
 * A controller action or route closure: takes the context, returns a response.
 *
 * @example
 * const ping: ActionHandler = (ctx) => ctx.json({ pong: true })
 */
export type ActionHandler = (ctx: HttpContext) => Response | Promise<Response>

/**
 * A controller class the container can build (a fresh instance per request).
 *
 * @example
 * const controller: ControllerClass = PostController
 */
export type ControllerClass = Injectable<object>

/**
 * The method an invokable (single-action) controller answers with: Laravel's `__invoke`.
 *
 * @example
 * class ShowDashboard { __invoke(ctx: HttpContext): Response { return ctx.json({}) } }
 */
export const INVOKE_METHOD = '__invoke'

/**
 * A single-action controller: `Route.post('/import', ImportController)` calls its `__invoke`.
 *
 * @example
 * const action: InvokableController = ImportController
 */
export type InvokableController = Injectable<{ readonly __invoke: ActionHandler }>

/**
 * The instance type of a controller class.
 *
 * @example
 * type C = InstanceOf<typeof PostController> // PostController
 */
export type InstanceOf<TClass> = TClass extends abstract new (
  ...args: never[]
) => infer TInstance
  ? TInstance
  : never

/**
 * The names of a controller's methods that can handle a request. `[PostController, 'nope']`
 * fails to compile because `'nope'` isn't in this union.
 *
 * @example
 * type Methods = ActionMethods<PostController> // 'index' | 'show' | …
 */
export type ActionMethods<TInstance> = {
  [Key in keyof TInstance]: TInstance[Key] extends ActionHandler ? Key : never
}[keyof TInstance] &
  string

/**
 * What a route points at: a closure, a `[Controller, 'method']` pair (Laravel's
 * `[PostController::class, 'index']`), or an invokable controller class.
 *
 * @example
 * const action: RouteAction<typeof PostController> = [PostController, 'index']
 */
export type RouteAction<TController extends ControllerClass> =
  | ActionHandler
  | InvokableController
  | readonly [TController, ActionMethods<InstanceOf<TController>>]

/**
 * A route action as stored at runtime, after its method name was checked at the call site.
 *
 * @example
 * const stored: StoredAction = [PostController, 'show']
 */
export type StoredAction = ActionHandler | ControllerClass | readonly [ControllerClass, string]

/**
 * A value that can fill a URL parameter: a raw string or number, or a model (which supplies its
 * route key, or the field named in `{post:slug}`).
 *
 * @example
 * route('posts.show', { post: 'hello-world' })
 */
export type RouteParam = string | number | UrlRoutable

/**
 * Anything that can put itself in a URL. Models implement it.
 *
 * @example
 * const routable: UrlRoutable = { routeKey: (field) => (field === 'slug' ? 'hello' : 7) }
 */
export interface UrlRoutable {
  /** The value for the URL: the given field, or the model's default route key. */
  routeKey(field?: string): string | number
}

/** `'post:slug'` → `'post'`. */
type ParamName<TSegment extends string> = TSegment extends `${infer TName}:${string}`
  ? TName
  : TSegment

/**
 * The parameter names in a path.
 *
 * @example
 * type Names = ParamNames<'/authors/{author}/posts/{post:slug}'> // 'author' | 'post'
 */
export type ParamNames<TPath extends string> =
  TPath extends `${string}{${infer TParam}}${infer TRest}`
    ? ParamName<TParam> | ParamNames<TRest>
    : never

/**
 * The params object a path needs.
 *
 * @example
 * type P = ParamsOf<'/posts/{post:slug}'> // { readonly post: RouteParam }
 */
export type ParamsOf<TPath extends string> = { readonly [Name in ParamNames<TPath>]: RouteParam }

/**
 * One route at the type level: its name (`never` when unnamed) and its path.
 *
 * @example
 * type Show = RouteSignature<'posts.show', '/posts/{post}'>
 */
export interface RouteSignature<TName extends string, TPath extends string> {
  readonly name: TName
  readonly path: TPath
}

/**
 * The signature of routes the compiler can't see (a `(router) => { … }` callback): any name.
 *
 * @example
 * type S = UntypedRoutes // RouteSignature<string, string>
 */
export type UntypedRoutes = RouteSignature<string, string>

/**
 * Anything that carries route signatures: a route, a group, a resource, a routes file.
 *
 * @example
 * type S = SignaturesOf<typeof showRoute>
 */
export interface HasSignatures<TSignatures> {
  /** Phantom: declared for the type checker, never assigned. */
  readonly __routes: TSignatures
}

/**
 * The signatures carried by a route entry, a routes file or a routes callback.
 *
 * @example
 * type S = SignaturesOf<RouteList<RouteSignature<'home', '/'>>> // RouteSignature<'home', '/'>
 */
export type SignaturesOf<TEntry> =
  TEntry extends HasSignatures<infer TSignatures>
    ? TSignatures
    : TEntry extends (...args: never[]) => infer TResult
      ? TResult extends readonly unknown[]
        ? SignaturesOf<TResult[number]>
        : UntypedRoutes
      : never

/**
 * Apply a group's name and path prefix to every signature inside it.
 *
 * @example
 * type S = PrefixSignatures<RouteSignature<'dashboard', '/'>, 'admin.', 'admin'> // RouteSignature<'admin.dashboard', 'admin//'>
 */
export type PrefixSignatures<TSignatures, TNamePrefix extends string, TPathPrefix extends string> =
  TSignatures extends RouteSignature<infer TName, infer TPath>
    ? RouteSignature<
        [TName] extends [never] ? never : string extends TName ? string : `${TNamePrefix}${TName}`,
        `${TPathPrefix}/${TPath}`
      >
    : never

/**
 * The singular of a resource name, mirroring `singular()` in `support/str.ts` for the regular
 * rules (`-ies`, `-sses`, `-s`). Irregular words use the `parameter` option.
 *
 * @example
 * type P = Singular<'categories'> // 'category'
 */
export type Singular<TWord extends string> = TWord extends `${infer TStem}ies`
  ? `${TStem}y`
  : TWord extends `${infer TStem}sses`
    ? `${TStem}ss`
    : TWord extends `${string}ss`
      ? TWord
      : TWord extends `${infer TStem}s`
        ? TStem
        : TWord

/**
 * The seven resource actions, in Laravel's order (which is also the registration order, so
 * `/posts/create` is matched before `/posts/{post}`).
 *
 * @example
 * const action: ResourceAction = 'store'
 */
export type ResourceAction = 'index' | 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy'

/**
 * The five API resource actions (no HTML form pages).
 *
 * @example
 * const action: ApiResourceAction = 'destroy'
 */
export type ApiResourceAction = Exclude<ResourceAction, 'create' | 'edit'>

/**
 * The actions of a singleton resource (`Route.singleton('profile', …)`): one record, no id.
 *
 * @example
 * const action: SingletonAction = 'edit'
 */
export type SingletonAction = 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy'

/**
 * The path a resource's collection routes (index, create, store) live at: `posts`, or
 * `posts/{post}/comments` for the nested `posts.comments`.
 *
 * @example
 * type P = CollectionPath<'posts.comments'> // 'posts/{post}/comments'
 */
export type CollectionPath<TName extends string> = TName extends `${infer TParent}.${infer TChild}`
  ? `${TParent}/{${Singular<TParent>}}/${TChild}`
  : TName

/**
 * The path a resource's member routes (show, edit, update, destroy) live under: the collection
 * path, or only the child segment for a shallow nested resource.
 *
 * @example
 * type P = MemberPath<'posts.comments', true> // 'comments'
 */
export type MemberPath<TName extends string, TShallow extends boolean> = TShallow extends true
  ? TName extends `${string}.${infer TChild}`
    ? TChild
    : TName
  : CollectionPath<TName>

/**
 * The default `{param}` of a resource: the singular of its last segment.
 *
 * @example
 * type P = ResourceParam<'posts.comments'> // 'comment'
 */
export type ResourceParam<TName extends string> = TName extends `${string}.${infer TChild}`
  ? Singular<TChild>
  : Singular<TName>

/**
 * The signature of one resource action.
 *
 * @example
 * type S = ResourceSignature<'posts', 'posts', 'posts', 'post', 'show'> // RouteSignature<'posts.show', '/posts/{post}'>
 */
export type ResourceSignature<
  TName extends string,
  TCollection extends string,
  TMember extends string,
  TParam extends string,
  TAction extends ResourceAction,
> = TAction extends 'index' | 'store'
  ? RouteSignature<`${TName}.${TAction}`, `/${TCollection}`>
  : TAction extends 'create'
    ? RouteSignature<`${TName}.create`, `/${TCollection}/create`>
    : TAction extends 'edit'
      ? RouteSignature<`${TName}.edit`, `/${TMember}/{${TParam}}/edit`>
      : RouteSignature<`${TName}.${TAction}`, `/${TMember}/{${TParam}}`>

/**
 * The signature of one singleton action (no `{param}`: there is one record).
 *
 * @example
 * type S = SingletonSignature<'profile', 'edit'> // RouteSignature<'profile.edit', '/profile/edit'>
 */
export type SingletonSignature<
  TName extends string,
  TAction extends SingletonAction,
> = TAction extends 'create' | 'edit'
  ? RouteSignature<`${TName}.${TAction}`, `/${TName}/${TAction}`>
  : RouteSignature<`${TName}.${TAction}`, `/${TName}`>

/**
 * A controller class with (at least) the given action methods.
 *
 * @example
 * const ok: ControllerWith<'index' | 'show'> = PostController
 */
export type ControllerWith<TActions extends string> = Injectable<{
  readonly [Action in TActions]: ActionHandler
}>

/**
 * Fold route signatures into a `{ name: params }` map. Unnamed routes are left out; routes from
 * callbacks the compiler can't see become a `string` index (any name).
 *
 * @example
 * type R = RegistryOf<RouteSignature<'posts.show', '/posts/{post}'>> // { 'posts.show': { readonly post: RouteParam } }
 */
export type RegistryOf<TSignatures> = {
  readonly [TSignature in TSignatures as TSignature extends RouteSignature<infer TName, string>
    ? [TName] extends [never]
      ? never
      : TName
    : never]: TSignature extends RouteSignature<string, infer TPath> ? ParamsOf<TPath> : never
}

/**
 * The route registry for a list of routes files. This is what the app puts in its
 * `RouteRegistry` augmentation.
 *
 * @example
 * interface RouteRegistry extends RoutesOf<[typeof web, typeof api]> {}
 */
export type RoutesOf<TFiles extends readonly unknown[]> = RegistryOf<SignaturesOf<TFiles[number]>>
