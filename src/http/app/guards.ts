/**
 * The `auth`, `can`, `signed` and `idempotent` middleware classes. Each is small because the work
 * lives elsewhere, once:
 *
 * - **auth**: the user is the actor the `http.onRequest` hook resolved (the auth package resolves
 *   users; the framework never reads a session itself). `auth` is a 401 without one;
 *   `auth:optional` lets guests through.
 * - **can**: a named ability from `m.defineAbility()`; only a literal `true` allows (a truthy
 *   object or string denies). Record abilities (update *this* post) stay in the controller with
 *   `authorize(policy, …)`, because route model binding runs after middleware: a guest must get
 *   its 401/403 before learning whether a record exists.
 * - **signed**: the framework's one URL signer (CONSISTENCY #64), purpose `route:<name>`; 403
 *   `invalid_signature` or `signature_expired` (#67), one-time links claimed on first use.
 * - **idempotent**: `http/idempotency.ts`'s store, codes and per-actor/tenant scoping
 *   (`idempotent` requires the header, `idempotent:optional` doesn't).
 *
 * @module
 */
import type { Clock } from '../../core/clock.ts'
import { ForbiddenError, StrutvaneError } from '../../core/errors/errors.ts'
import { ClockToken } from '../../core/tokens.ts'
import { BootError } from '../../foundation/boot-error.ts'
import { signingPurpose } from '../../routing/url.ts'
import { signatureError, type UrlSigner, UrlSignerToken } from '../../security/signer.ts'
import {
  callerScope,
  finishIdempotent,
  type IdempotencyStore,
  IdempotencyStoreToken,
  startIdempotent,
} from '../idempotency.ts'
import { routerPath } from '../router-path.ts'
import { type HttpContext, unauthenticated } from './context.ts'
import {
  type Middleware,
  type MiddlewareConfig,
  MiddlewareConfigToken,
  type Next,
} from './middleware.ts'

/**
 * The `auth` middleware class.
 *
 * @example
 * Route.get('/me', [ProfileController, 'show']).middleware('auth')
 */
export class Authenticate implements Middleware {
  async handle(ctx: HttpContext, next: Next, mode?: string): Promise<Response> {
    if (ctx.user !== null || mode === 'optional') return next()
    throw unauthenticated()
  }
}

/**
 * The `can` middleware class.
 *
 * @example
 * Route.get('/admin/stats', [StatsController, 'show']).middleware('auth', 'can:view-stats')
 */
export class Authorize implements Middleware {
  static readonly inject: readonly [typeof MiddlewareConfigToken] = [MiddlewareConfigToken] as const
  readonly #config: MiddlewareConfig

  constructor(config: MiddlewareConfig) {
    this.#config = config
  }

  async handle(ctx: HttpContext, next: Next, ability?: string): Promise<Response> {
    const check = ability === undefined ? undefined : this.#config.ability(ability)
    // Boot already refuses unknown abilities; this guards the imperative style (can.verify).
    if (ability === undefined || check === undefined)
      throw new BootError(
        'unknown_ability',
        `can:${ability ?? ''} names no ability.`,
        `Define it in bootstrap/app.ts: withMiddleware((m) => m.defineAbility('${ability ?? 'name'}', (user) => …)).`,
      )
    // Only a literal `true` allows: a check that returns a truthy object or a string denies.
    if ((await check(ctx.user, ctx)) !== true) throw new ForbiddenError()
    return next()
  }
}

/**
 * The `signed` middleware class. The route must be named (the signature is bound to the name).
 *
 * @example
 * Route.get('/unsubscribe/{user}', handler).name('unsubscribe').middleware('signed')
 */
export class ValidateSignature implements Middleware {
  static readonly inject: readonly [typeof UrlSignerToken, typeof ClockToken] = [
    UrlSignerToken,
    ClockToken,
  ] as const
  readonly #signer: UrlSigner
  readonly #clock: Clock

  constructor(signer: UrlSigner, clock: Clock) {
    this.#signer = signer
    this.#clock = clock
  }

  async handle(ctx: HttpContext, next: Next): Promise<Response> {
    const name = ctx.route?.name
    if (name === undefined)
      throw new BootError(
        'signed_route_without_name',
        `The signed middleware ran on ${ctx.route?.uri ?? ctx.url.pathname}, which has no name.`,
        "Name the route (.name('downloads.show')): signed links are bound to the route name.",
      )
    const verdict = await this.#signer.verify(`${ctx.url.pathname}${ctx.url.search}`, {
      purpose: signingPurpose(name),
      now: this.#clock.now(),
    })
    const error = signatureError(verdict)
    if (error !== undefined) throw error
    return next()
  }
}

/** Methods that never change state: never stored, never replayed. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The `idempotent` middleware class: a retry with the same `Idempotency-Key` replays the first
 * response instead of running the action twice.
 *
 * @example
 * Route.post('/payments', [PaymentController, 'store']).middleware('auth', 'idempotent')
 */
export class EnsureIdempotency implements Middleware {
  static readonly inject: readonly [typeof IdempotencyStoreToken, typeof ClockToken] = [
    IdempotencyStoreToken,
    ClockToken,
  ] as const
  readonly #store: IdempotencyStore
  readonly #clock: Clock

  constructor(store: IdempotencyStore, clock: Clock) {
    this.#store = store
    this.#clock = clock
  }

  async handle(ctx: HttpContext, next: Next, mode?: string): Promise<Response> {
    if (SAFE_METHODS.has(ctx.method)) return next()
    const key = ctx.request.headers.get('idempotency-key')
    if (key === null) {
      if (mode === 'optional') return next()
      throw new StrutvaneError('idempotency_key_required', { status: 400 })
    }
    const actor = ctx.user as { readonly type?: unknown; readonly id?: unknown } | null
    const now = this.#clock.now()
    const start = await startIdempotent(
      this.#store,
      {
        scope: callerScope(
          actor === null
            ? null
            : { type: String(actor.type ?? 'user'), id: String(actor.id ?? '') },
          ctx.tenant?.id,
          ctx.ip,
        ),
        key,
        method: ctx.method,
        path: routerPath(ctx.request),
        search: ctx.url.search,
        request: ctx.request,
      },
      now,
    )
    if (start.kind === 'replay') return start.response
    let response: Response
    try {
      response = await next()
    } catch (error) {
      await finishIdempotent(this.#store, start.storeKey, undefined, now)
      throw error
    }
    await finishIdempotent(this.#store, start.storeKey, response, now)
    return response
  }
}
