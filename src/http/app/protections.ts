/**
 * The framework's protections, each usable in every style (see `protection.ts`): app-wide, per
 * route, per group, per controller, as a handler wrapper, and imperatively.
 *
 * ```ts
 * static readonly middleware = [auth({ except: ['index'] }), csrf({ except: ['callback'] })]
 * export default withCsrf(async (ctx) => ctx.json({ ok: true }))
 * await csrf.verify(ctx)
 * ```
 *
 * @module
 */
import type { ActionHandler } from '../../routing/types.ts'
import type { HttpContext } from './context.ts'
import { csrfTokenFor, VerifyCsrfToken } from './csrf.ts'
import { Authenticate, Authorize, EnsureIdempotency, ValidateSignature } from './guards.ts'
import type { MiddlewareClass } from './middleware.ts'
import { defineProtection, type ProtectedHandler, type Protection } from './protection.ts'
import { ThrottleRequests } from './throttle.ts'

/**
 * The CSRF protection, plus `csrf.token(ctx)` for forms, meta tags and SPA bootstraps.
 *
 * @example
 * static readonly middleware = [csrf({ except: ['callback'] })]
 * const token = csrf.token(ctx)
 */
export const csrf: Protection & { token(ctx: HttpContext): string } = Object.assign(
  defineProtection('csrf', VerifyCsrfToken),
  { token: csrfTokenFor },
)

/**
 * Wrap a handler so unsafe cookie requests must prove they come from the app's own pages.
 *
 * @example
 * export default withCsrf(async (ctx) => ctx.json({ imported: true }))
 */
export const withCsrf: (handler: ActionHandler, ...params: string[]) => ProtectedHandler = csrf.wrap

/**
 * The `auth` protection (`auth` or `auth:optional`).
 *
 * @example
 * static readonly middleware = [auth({ except: ['index', 'show'] })]
 */
export const auth: Protection = defineProtection('auth', Authenticate)

/**
 * Wrap a handler so it needs a signed-in user.
 *
 * @example
 * export default withAuth(async (ctx) => ctx.json({ me: ctx.requireUser() }))
 */
export const withAuth: (handler: ActionHandler, ...params: string[]) => ProtectedHandler = auth.wrap

/**
 * The `can` protection: a named ability from `defineAbility()`.
 *
 * @example
 * static readonly middleware = [can({ params: ['view-stats'] })]
 */
export const can: Protection = defineProtection('can', Authorize)

/**
 * Wrap a handler so it needs an ability: `withCan(handler, 'view-stats')`.
 *
 * @example
 * export default withCan(async (ctx) => ctx.json(stats), 'view-stats')
 */
export const withCan: (handler: ActionHandler, ...params: string[]) => ProtectedHandler = can.wrap

/**
 * The `throttle` protection: `throttle({ params: ['10', '1'] })` is `throttle:10,1`.
 *
 * @example
 * static readonly middleware = [throttle({ params: ['login'], only: ['store'] })]
 */
export const throttle: Protection = defineProtection('throttle', ThrottleRequests)

/**
 * Wrap a handler with a rate limit: `withThrottle(handler, '10', '1')`.
 *
 * @example
 * export default withThrottle(async (ctx) => ctx.json({ sent: true }), '5', '1')
 */
export const withThrottle: (handler: ActionHandler, ...params: string[]) => ProtectedHandler =
  throttle.wrap

/**
 * The `signed` protection: the URL must carry a valid (and unexpired) signature.
 *
 * @example
 * static readonly middleware = [signed({ only: ['download'] })]
 */
export const signed: Protection = defineProtection('signed', ValidateSignature)

/**
 * Wrap a handler so only signed links reach it.
 *
 * @example
 * export default withSigned(async (ctx) => ctx.json({ unsubscribed: true }))
 */
export const withSigned: (handler: ActionHandler, ...params: string[]) => ProtectedHandler =
  signed.wrap

/**
 * The `idempotent` protection: retries with the same `Idempotency-Key` replay the first response.
 *
 * @example
 * static readonly middleware = [idempotent({ only: ['store'] })]
 */
export const idempotent: Protection = defineProtection('idempotent', EnsureIdempotency)

/**
 * Wrap a handler so it runs at most once per idempotency key.
 *
 * @example
 * export default withIdempotency(async (ctx) => ctx.json(await charge(ctx), 201))
 */
export const withIdempotency: (handler: ActionHandler, ...params: string[]) => ProtectedHandler =
  idempotent.wrap

/**
 * The core aliases every app has, registered at boot (an app may not replace them).
 *
 * @example
 * m.alias(CORE_ALIASES)
 */
export const CORE_ALIASES: Readonly<Record<string, MiddlewareClass>> = Object.freeze({
  csrf: VerifyCsrfToken,
  auth: Authenticate,
  can: Authorize,
  throttle: ThrottleRequests,
  signed: ValidateSignature,
  idempotent: EnsureIdempotency,
})

/**
 * A hidden `_token` input for a plain HTML form (Laravel's `@csrf`).
 *
 * @example
 * ctx.html(`<form method="post" action="/posts">${csrf_field(ctx)}<button>Save</button></form>`)
 */
export function csrf_field(ctx: HttpContext): string {
  return `<input type="hidden" name="_token" value="${escapeAttribute(csrfTokenFor(ctx))}">`
}

/**
 * The `<meta name="csrf-token">` tag for a page's `<head>`, for scripts that send `X-CSRF-TOKEN`.
 *
 * @example
 * ctx.html(`<head>${csrf_meta(ctx)}</head>`)
 */
export function csrf_meta(ctx: HttpContext): string {
  return `<meta name="csrf-token" content="${escapeAttribute(csrfTokenFor(ctx))}">`
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;')
}
