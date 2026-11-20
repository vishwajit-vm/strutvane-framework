/**
 * The HTTP kernel's global stages: what runs for *every* request before routing (Laravel's global
 * middleware), and what is added to *every* response afterwards, including 404s, 405s and errors.
 *
 * ```
 * request → [trusted hosts] → [maintenance] → [CORS preflight] → [timeout] → hooks → router
 *                      response ← [CORS] ← [security headers + nonce] ← [XSRF-TOKEN] ← [X-Request-Id]
 * ```
 *
 * The response decorators run outside the error handler on purpose: an error page needs its CSP
 * and `nosniff` as much as any other page (spike 12 finding 9).
 *
 * @module
 */
import type { Context } from 'hono'
import { type Token, token } from '../../core/container.ts'
import { StrutvaneError } from '../../core/errors/errors.ts'
import { corsHeaders, corsPreflight } from '../../security/cors.ts'
import type { Keyring } from '../../security/keyring.ts'
import { applySecurityHeaders } from '../../security/secure-headers.ts'
import type { ResolvedSecurity } from '../../security/settings.ts'
import { xsrfCookieFor } from '../csrf.ts'
import { requestTimeout } from '../request-timeout.ts'
import { hostName, isTrustedHost, UNTRUSTED_HOST_CODE } from '../trusted-hosts.ts'
import type { HttpContext } from './context.ts'

/**
 * One global stage: answer by itself, or call `next()`.
 *
 * @example
 * const stage: KernelStage = async (ctx, next) => next()
 */
export type KernelStage = (ctx: HttpContext, next: () => Promise<Response>) => Promise<Response>

/**
 * Run the stages in order, then `final` (the router).
 *
 * @example
 * await runStages([trustedHostStage(security)], ctx, () => router(ctx))
 */
export async function runStages(
  stages: readonly KernelStage[],
  ctx: HttpContext,
  final: () => Promise<Response>,
): Promise<Response> {
  const run = async (index: number): Promise<Response> => {
    const stage = stages[index]
    return stage === undefined ? final() : stage(ctx, () => run(index + 1))
  }
  return run(0)
}

/**
 * Refuse requests for hosts that aren't on the allowlist (400 `untrusted_host`, CONSISTENCY #20),
 * reusing `http/trusted-hosts.ts`. The `Host` header is checked, and so is the forwarded host
 * when a trusted proxy supplied one. The host is never echoed back: it is attacker-controlled.
 *
 * @example
 * trustedHostStage(security)
 */
export function trustedHostStage(security: ResolvedSecurity): KernelStage {
  return async (ctx, next) => {
    const candidates = [ctx.request.headers.get('host') ?? ctx.url.host, ctx.state.host]
    for (const candidate of candidates) {
      const name = hostName(candidate)
      if (name === undefined || !isTrustedHost(name, security.hosts))
        throw new StrutvaneError(UNTRUSTED_HOST_CODE, { status: 400 })
    }
    return next()
  }
}

/**
 * Answer CORS preflights (only when CORS is on; otherwise they fall through to routing).
 *
 * @example
 * corsPreflightStage(security)
 */
export function corsPreflightStage(security: ResolvedSecurity): KernelStage {
  return async (ctx, next) => corsPreflight(ctx.request, security.cors) ?? next()
}

/**
 * The maintenance-mode check (`src/maintenance/maintenance.ts`'s `checkMaintenance`): a response
 * while the app is down (`node strut down`), or `undefined` to carry on.
 *
 * @example
 * const check: MaintenanceCheck = async () => undefined
 */
export type MaintenanceCheck = (
  request: Request,
  options: {
    readonly basePath: string
    readonly keyring: Keyring
    readonly healthPath: string
    readonly now: () => number
    readonly secureCookies: boolean
  },
) => Promise<Response | undefined>

/**
 * The container token for the maintenance check. The application binds the framework's
 * `checkMaintenance` here; tests bind their own.
 *
 * @example
 * app.container.value(MaintenanceCheckToken, async () => undefined)
 */
export const MaintenanceCheckToken: Token<MaintenanceCheck> =
  token<MaintenanceCheck>('strutvane.maintenance')

/**
 * The maintenance stage, between the host check and CORS.
 *
 * @example
 * maintenanceStage(check, { basePath, keyring, healthPath: '/up', now, secureCookies })
 */
export function maintenanceStage(
  check: MaintenanceCheck,
  options: Parameters<MaintenanceCheck>[1],
): KernelStage {
  return async (ctx, next) => (await check(ctx.request, options)) ?? next()
}

/** The request-timeout middleware never reads its context; this stands in for one. */
const NO_CONTEXT = Object.freeze({}) as Context

/**
 * The request timeout (`http/request-timeout.ts`): after `ms` the client gets a 503 problem and
 * the late outcome of the abandoned work is swallowed. `0` turns it off.
 *
 * @example
 * timeoutStage(30_000)
 */
export function timeoutStage(ms: number): KernelStage {
  const middleware = requestTimeout(ms)
  return async (_ctx, next) => {
    let response: Response | undefined
    await middleware(NO_CONTEXT, async () => {
      response = await next()
    })
    // The middleware resolves only after `next` did (or throws the 503), so this is set.
    return response ?? new Response(null, { status: 500 })
  }
}

/**
 * What the response decorator adds besides the security and CORS headers.
 *
 * @example
 * decorateResponse(response, ctx, security, { environment: 'production', requestId, hookHeaders })
 */
export interface DecorateOptions {
  readonly environment: string
  /** Headers the `http.onRequest` hook asked for (a refreshed session cookie). */
  readonly hookHeaders?: Headers | undefined
}

/**
 * Add CORS and security headers (with this request's CSP nonce), the hook's headers, the request
 * id and the `XSRF-TOKEN` cookie to a response. The response is copied first, because responses
 * built by `Response.json()`, `Response.redirect()` or `fetch()` have immutable headers.
 *
 * @example
 * return decorateResponse(response, ctx, security, { environment: 'production' })
 */
export function decorateResponse(
  response: Response,
  ctx: HttpContext,
  security: ResolvedSecurity,
  options: DecorateOptions,
): Response {
  const copy = new Response(response.body, response)
  if (options.hookHeaders !== undefined) {
    for (const cookie of options.hookHeaders.getSetCookie())
      copy.headers.append('set-cookie', cookie)
    for (const [name, value] of options.hookHeaders)
      if (name !== 'set-cookie') copy.headers.set(name, value)
  }
  corsHeaders(ctx.request, security.cors, copy.headers)
  applySecurityHeaders(copy.headers, security.headers, {
    nonce: ctx.nonce,
    secure: ctx.state.secure,
    environment: options.environment,
  })
  copy.headers.set('X-Request-Id', ctx.state.requestId)
  // A response a shared cache may store (`Cache-Control: public`) must never carry a per-visitor
  // cookie: the cache would hand one visitor's XSRF token to everyone after them.
  const xsrf = isSharedCacheable(copy.headers)
    ? undefined
    : xsrfCookieFor(
        security.csrf,
        ctx.request.headers.get('cookie'),
        copy.headers.getSetCookie(),
        ctx.state.secure,
      )
  if (xsrf !== undefined) copy.headers.append('set-cookie', xsrf)
  return copy
}

/**
 * `true` when `Cache-Control` lets a shared cache store the response (`public`, or `s-maxage`
 * without `private`/`no-store`). Directive names are case-insensitive (RFC 9111 §5.2).
 *
 * @example
 * isSharedCacheable(new Headers({ 'cache-control': 'public, max-age=60' })) // true
 */
export function isSharedCacheable(headers: Headers): boolean {
  const directives = (headers.get('cache-control') ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim().split('=')[0] ?? '')
  if (directives.includes('private') || directives.includes('no-store')) return false
  return directives.includes('public') || directives.includes('s-maxage')
}
