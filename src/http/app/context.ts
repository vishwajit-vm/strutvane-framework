/**
 * `HttpContext`: everything a controller action, middleware or policy check needs about the
 * current request, in one typed object. Laravel spreads this over `$request`, `$request->user()`,
 * route parameters and injected models; here it is one explicit argument.
 *
 * `ctx.user` is the actor the `http.onRequest` hook resolved (the auth package resolves users;
 * the framework never reads a session itself), typed as the app's `UserRegistry['user']`.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TenantContext } from '../../contracts/tenancy.ts'
import { StrutvaneError, UnauthenticatedError } from '../../core/errors/errors.ts'
import { BootError } from '../../foundation/boot-error.ts'
import type { AuthUser } from '../../foundation/registry.ts'
import { JsonLimitError, parseJsonSafely } from '../../security/safe-json.ts'
import { cookieValues, type SessionCookie, sessionCookieValue } from '../session-cookie.ts'
import { plainRequestState, type RequestState } from './request-state.ts'

/**
 * What the router knows about the matched route, for logging, `route:list` and error pages.
 *
 * @example
 * ctx.route?.name // 'posts.show'
 */
export interface MatchedRoute {
  readonly name: string | undefined
  readonly method: string
  readonly uri: string
  /** `PostController@show`, or `Closure`. */
  readonly action: string
}

/**
 * A model class as far as the context cares: something whose instances can be looked up by class.
 * Kept structural so the HTTP layer doesn't import the ORM.
 *
 * @example
 * const model: ModelConstructor<Post> = Post
 */
export type ModelConstructor<TInstance> = abstract new (...args: never[]) => TInstance

/**
 * Work to run after the response is sent (`defer()`), and terminable middleware.
 *
 * @example
 * const task: DeferredTask = async () => { await sendWelcomeMail(user) }
 */
export type DeferredTask = () => void | Promise<void>

/** State every context of one request shares (the kernel's and the routed one). */
interface RequestScope {
  user: AuthUser | null
  tenant: TenantContext | undefined
  readonly applied: Set<string>
  readonly models: Map<string, object>
  readonly deferred: DeferredTask[]
  body: Promise<unknown> | undefined
  sessionCookie: SessionCookie | undefined
}

/**
 * How to build a context. The kernel passes everything; a hand-built context (tests, scripts)
 * needs only the request.
 *
 * @example
 * new HttpContext({ request: new Request('http://localhost/') })
 */
export interface HttpContextInit {
  readonly request: Request
  readonly params?: Readonly<Record<string, string>>
  readonly route?: MatchedRoute
  readonly state?: RequestState
  /** The resolved actor (what the auth hook found). */
  readonly user?: AuthUser | null
  readonly tenant?: TenantContext
  /** The app's session cookie (CONSISTENCY #105), for `sessionId()` and `csrf.token()`. */
  readonly sessionCookie?: SessionCookie
}

/**
 * The per-request context.
 *
 * @example
 * async show(ctx: HttpContext): Promise<Response> {
 *   return ctx.json({ data: ctx.model(Post) })
 * }
 */
export class HttpContext {
  /** The raw Web-standard request. */
  readonly request: Request
  /** The parsed URL. */
  readonly url: URL
  /** Path parameters as strings, before model binding: `{ post: 'hello-world' }`. */
  readonly params: Readonly<Record<string, string>>
  /** The matched route, or `undefined` before routing and for a 404/405. */
  readonly route: MatchedRoute | undefined
  /** What the kernel worked out before routing: real IP and scheme, host, nonce, limits. */
  readonly state: RequestState
  #scope: RequestScope

  constructor(init: HttpContextInit) {
    this.request = init.request
    this.url = new URL(init.request.url)
    this.params = Object.freeze({ ...init.params })
    this.route = init.route
    this.state = init.state ?? plainRequestState(init.request)
    this.#scope = {
      user: init.user ?? null,
      tenant: init.tenant,
      applied: new Set(),
      models: new Map(),
      deferred: [],
      body: undefined,
      sessionCookie: init.sessionCookie,
    }
  }

  /**
   * The same request, now routed: shares the user, the applied protections, the bound models,
   * the deferred work and the parsed body with this context.
   *
   * @example
   * const routed = ctx.forRoute(matched, { post: 'hello' })
   */
  forRoute(
    route: MatchedRoute,
    params: Readonly<Record<string, string>>,
    state: RequestState = this.state,
  ): HttpContext {
    const routed = new HttpContext({ request: this.request, route, params, state })
    // One scope object, shared by reference: both contexts see the same request state.
    routed.#scope = this.#scope
    return routed
  }

  /**
   * The signed-in user (the actor the auth hook resolved), or `null` for guests.
   *
   * @example
   * if (ctx.user === null) return ctx.json({ guest: true })
   */
  get user(): AuthUser | null {
    return this.#scope.user
  }

  set user(user: AuthUser | null) {
    this.#scope.user = user
  }

  /**
   * The tenant the auth hook resolved, if the app is multi-tenant.
   *
   * @example
   * ctx.tenant?.id // 'acme'
   */
  get tenant(): TenantContext | undefined {
    return this.#scope.tenant
  }

  set tenant(tenant: TenantContext | undefined) {
    this.#scope.tenant = tenant
  }

  /**
   * The client address: the socket peer, or the forwarded client when the peer is a configured
   * trusted proxy. `X-Forwarded-For` from anyone else is ignored.
   *
   * @example
   * ctx.ip // '203.0.113.7'
   */
  get ip(): string {
    return this.state.ip
  }

  /**
   * The CSP nonce for this response. Put it on every inline `<script>` and `<style>`; scripts
   * without it are blocked by the default Content-Security-Policy.
   *
   * @example
   * ctx.html(`<script nonce="${ctx.nonce}">boot()</script>`)
   */
  get nonce(): string {
    return this.state.nonce
  }

  /**
   * The method routing used: the real one, or a form's spoofed `_method` (PUT, PATCH, DELETE).
   *
   * @example
   * ctx.method // 'DELETE' for <form method="post"><input name="_method" value="DELETE">
   */
  get method(): string {
    return this.state.method
  }

  /**
   * The query string.
   *
   * @example
   * ctx.query.get('page') // '2'
   */
  get query(): URLSearchParams {
    return this.url.searchParams
  }

  /**
   * One cookie from the request (the first one with that name, as sent), or `undefined`.
   *
   * @example
   * ctx.cookie('theme') // 'dark'
   */
  cookie(name: string): string | undefined {
    return cookieValues(this.request.headers.get('cookie'), name)[0]
  }

  /**
   * The session id from the configured session cookie (CONSISTENCY #105), or `undefined` when
   * there is none **or when the request carries a Bearer token**: a bearer request is never also
   * a cookie session, so a junk bearer header next to a stolen cookie can't ride on it. (The CSRF
   * check does *not* use this: it checks every request that carries the cookie, #124.)
   *
   * @example
   * const sessionId = ctx.sessionId()
   */
  sessionId(): string | undefined {
    if (hasBearer(this.request)) return undefined
    return this.sessionCookieValue()
  }

  /**
   * The session cookie's value whatever else the request carries (what the CSRF token is bound
   * to), or `undefined`.
   *
   * @example
   * ctx.sessionCookieValue() // 'abc…'
   */
  sessionCookieValue(): string | undefined {
    const cookie = this.#scope.sessionCookie
    if (cookie === undefined) return undefined
    return sessionCookieValue(this.request.headers.get('cookie'), cookie)
  }

  /**
   * The app's session cookie settings, when the kernel built this context.
   *
   * @example
   * ctx.sessionCookie?.name // '__Host-strutvane_session'
   */
  get sessionCookie(): SessionCookie | undefined {
    return this.#scope.sessionCookie
  }

  /**
   * Record that a protection ran for this request, so a `withCsrf()`-style wrapper doesn't run it
   * twice when the router already did.
   *
   * @example
   * ctx.markApplied('csrf')
   */
  markApplied(alias: string): void {
    this.#scope.applied.add(alias)
  }

  /**
   * `true` when the middleware with this alias already ran for this request.
   *
   * @example
   * if (!ctx.hasApplied('csrf')) await csrf.verify(ctx)
   */
  hasApplied(alias: string): boolean {
    return this.#scope.applied.has(alias)
  }

  /**
   * A path parameter as a string. Throws a `BootError` if the route has no such parameter: that
   * is a route/controller mismatch to fix, not a client error.
   *
   * @example
   * ctx.param('post') // 'hello-world'
   */
  param(name: string): string {
    const value = Object.hasOwn(this.params, name) ? this.params[name] : undefined
    if (value !== undefined) return value
    throw new BootError(
      'unknown_route_parameter',
      `The route "${this.route?.uri ?? this.url.pathname}" has no {${name}} parameter.`,
      `Parameters here: ${Object.keys(this.params).join(', ') || 'none'}.`,
    )
  }

  /**
   * The signed-in user, or a 401. Use it in actions that only make sense with a user.
   *
   * @example
   * const author = ctx.requireUser()
   */
  requireUser(): AuthUser {
    if (this.user !== null) return this.user
    throw unauthenticated()
  }

  /**
   * Record a model bound from a route parameter. Called by route model binding.
   *
   * @example
   * ctx.bindModel('post', post)
   */
  bindModel(parameter: string, model: object): void {
    this.#scope.models.set(parameter, model)
  }

  /**
   * The model bound from the route, looked up by its class: Laravel's `show(Post $post)`.
   * Typed by the class you pass, so `ctx.model(Post)` is a `Post`.
   *
   * @example
   * const post = ctx.model(Post) // the 404 already happened in binding if it didn't exist
   */
  model<TClass extends ModelConstructor<object>>(
    modelClass: TClass,
    parameter?: string,
  ): InstanceType<TClass> {
    for (const [name, instance] of this.#scope.models) {
      if ((parameter === undefined || parameter === name) && instance instanceof modelClass)
        return instance as InstanceType<TClass>
    }
    const bound = [...this.#scope.models.keys()].join(', ') || 'none'
    throw new BootError(
      'model_not_bound',
      `No ${modelClass.name} is bound on route "${this.route?.uri ?? this.url.pathname}" (bound parameters: ${bound}).`,
      `Add {${modelClass.name.toLowerCase()}} to the route path and register the model in withRouting({ bindings }).`,
    )
  }

  /**
   * The model bound to a parameter, whatever its class, or `undefined`.
   *
   * @example
   * ctx.bound('post')
   */
  bound(parameter: string): object | undefined {
    return this.#scope.models.get(parameter)
  }

  /**
   * The JSON body, parsed once and cached. 415 for other content types, 413 when too big, 400
   * for malformed JSON or prototype-pollution keys.
   *
   * @example
   * const body = await ctx.body()
   */
  body(): Promise<unknown> {
    this.#scope.body ??= readJsonBody(this.request, this.state)
    return this.#scope.body
  }

  /**
   * `true` when the client wants JSON: an API path, or an `Accept` header naming JSON. The
   * exception handler uses it to choose problem+json or an HTML page.
   *
   * @example
   * if (ctx.wantsJson()) { … }
   */
  wantsJson(): boolean {
    const accept = this.request.headers.get('accept') ?? ''
    const path = this.url.pathname
    const api = this.state.apiPrefix
    return path === api || path.startsWith(`${api}/`) || /json/i.test(accept)
  }

  /**
   * Run `task` after the response is sent (Laravel's `defer()`). Its errors are logged through
   * the Logger and never change the response.
   *
   * @example
   * ctx.defer(() => audit.record('post.viewed', post.id))
   */
  defer(task: DeferredTask): void {
    if (typeof task !== 'function')
      throw new BootError(
        'invalid_deferred_task',
        'defer() needs a function.',
        'Pass () => work().',
      )
    this.#scope.deferred.push(task)
  }

  /**
   * The deferred work of this request, in order (the kernel runs it).
   *
   * @example
   * ctx.deferredTasks().length // 1
   */
  deferredTasks(): readonly DeferredTask[] {
    return [...this.#scope.deferred]
  }

  /**
   * A JSON response.
   *
   * @example
   * return ctx.json({ data: post }, 201, { location: route('posts.show', { post }) })
   */
  json(data: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, 'content-type': 'application/json' },
    })
  }

  /**
   * An empty 204 response, for deletes.
   *
   * @example
   * return ctx.noContent()
   */
  noContent(): Response {
    return new Response(null, { status: 204 })
  }

  /**
   * An HTML response.
   *
   * @example
   * return ctx.html('<!doctype html><div id="root"></div>')
   */
  html(markup: string, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
    return new Response(markup, {
      status,
      headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
    })
  }
}

/**
 * The 401 every "you must sign in" path throws, with `WWW-Authenticate` (RFC 9110 requires it).
 *
 * @example
 * throw unauthenticated()
 */
export function unauthenticated(): UnauthenticatedError {
  return new UnauthenticatedError({ headers: { 'WWW-Authenticate': 'Bearer' } })
}

/**
 * Read and parse a JSON body with a size limit that holds even when `Content-Length` lies or is
 * missing (chunked uploads), by counting bytes while streaming. The JSON is parsed with depth,
 * key-count and prototype-pollution checks.
 */
async function readJsonBody(request: Request, state: RequestState): Promise<unknown> {
  if (!isJsonMediaType(request.headers.get('content-type')))
    throw new StrutvaneError('unsupported_media_type', { status: 415 })
  const text = await readLimitedText(request, state.limits.maxBytes)
  try {
    return parseJsonSafely(text, state.limits)
  } catch (error) {
    if (error instanceof JsonLimitError) throw error.toHttpError()
    throw error
  }
}

/**
 * `true` only when the media type *essence* is `application/json` or `application/*+json`.
 * A substring test would accept `text/plain; x=application/json`, which a cross-site form can
 * send without a CORS preflight.
 *
 * @example
 * isJsonMediaType('application/json; charset=utf-8') // true
 * isJsonMediaType('text/plain; a=application/json')  // false
 */
export function isJsonMediaType(header: string | null): boolean {
  const essence = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return essence === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(essence)
}

/**
 * `true` when the request carries `Authorization: Bearer …`.
 *
 * @example
 * hasBearer(new Request('http://x', { headers: { authorization: 'Bearer abc' } })) // true
 */
export function hasBearer(request: Request): boolean {
  return /^Bearer\s/i.test(request.headers.get('authorization') ?? '')
}

/**
 * Read a body as text, at most `limit` bytes, refusing early when `Content-Length` already says
 * it's too big (413 `payload_too_large`). The rest of an oversized body is never buffered.
 *
 * @example
 * const text = await readLimitedText(request.clone(), 64 * 1024)
 */
export async function readLimitedText(request: Request, limit: number): Promise<string> {
  const tooLarge = (): StrutvaneError => new StrutvaneError('payload_too_large', { status: 413 })
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > limit) throw tooLarge()
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      // Not awaited: cancelling one branch of a cloned (tee'd) body settles only once the other
      // branch is cancelled too, so awaiting it here would hang the request.
      void reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const current = new AsyncLocalStorage<HttpContext>()

/**
 * Run `work` with `ctx` as the current request (the kernel does this for every request), so
 * `defer()` and other request helpers find it.
 *
 * @example
 * await runWithHttpContext(ctx, () => handler(ctx))
 */
export function runWithHttpContext<TResult>(ctx: HttpContext, work: () => TResult): TResult {
  return current.run(ctx, work)
}

/**
 * The current request's context, or `undefined` outside a request.
 *
 * @example
 * currentHttpContext()?.ip
 */
export function currentHttpContext(): HttpContext | undefined {
  return current.getStore()
}

/**
 * Run `task` after the current response is sent, Laravel's `defer()`. Errors are logged through
 * the Logger and never change the response. Throws a `BootError` outside a request.
 *
 * @example
 * defer(async () => { await analytics.track('signup', user.id) })
 */
export function defer(task: DeferredTask): void {
  const ctx = current.getStore()
  if (ctx === undefined)
    throw new BootError(
      'defer_outside_request',
      'defer() was called outside an HTTP request.',
      'Call it from a controller or middleware, or use ctx.defer(task).',
    )
  ctx.defer(task)
}
