/**
 * The `csrf` middleware for the application kernel. It is a thin adapter: the check itself is
 * the framework's one implementation, `verifyCsrf` in `http/csrf.ts` (419 `csrf_token_mismatch`;
 * keyed on the configured session cookie, CONSISTENCY #105; a request with no session cookie is
 * never checked and every other unsafe one is, bearer header or not, #124; tokens in
 * `X-XSRF-TOKEN`, `X-CSRF-TOKEN` or a form's `_token`, #17).
 *
 * The kernel also runs this check *before* the `http.onRequest` hook for requests whose route
 * keeps CSRF (or that match no route), so a route a hook answers itself (sign-in) is covered too
 * (#125); the route's own `csrf` middleware then sees it already passed.
 *
 * @module
 */
import { StrutvaneError } from '../../core/errors/errors.ts'
import { BootError } from '../../foundation/boot-error.ts'
import { currentApplication } from '../../foundation/current.ts'
import { type ResolvedSecurity, SecurityToken } from '../../security/settings.ts'
import { CSRF_ERROR_CODE, csrfToken, exactOrigin, verifyCsrf } from '../csrf.ts'
import { routerPath } from '../router-path.ts'
import type { HttpContext } from './context.ts'
import type { Middleware, Next } from './middleware.ts'

/** The `applied` marker the kernel's early check leaves, so the route's check doesn't repeat it. */
const VERIFIED = 'csrf:verified'

/**
 * The origin the client used to reach the app: the scheme it connected with (after the
 * trusted-proxy rules) and the `Host` it asked for (already checked against the allowlist).
 *
 * @example
 * ownOrigin(ctx) // 'https://blog.example.com'
 */
export function ownOrigin(ctx: HttpContext): string | undefined {
  const host = ctx.request.headers.get('host') ?? ctx.url.host
  return exactOrigin(`${ctx.state.secure ? 'https' : 'http'}://${host}`)
}

/**
 * Run the CSRF check for a request: resolves when it passes, throws 419 when it doesn't. Honours
 * the test client's `withoutCsrf()` (the kernel only allows it when APP_ENV=testing).
 *
 * @example
 * await checkCsrf(ctx, security)
 */
export async function checkCsrf(ctx: HttpContext, security: ResolvedSecurity): Promise<void> {
  if (ctx.state.skipCsrf || ctx.hasApplied(VERIFIED)) return
  const passes = await verifyCsrf(ctx.request, security.csrf, {
    ownOrigin: ownOrigin(ctx),
    path: routerPath(ctx.request),
  })
  if (!passes) throw new StrutvaneError(CSRF_ERROR_CODE, { status: 419 })
  ctx.markApplied(VERIFIED)
}

/**
 * The `csrf` middleware class.
 *
 * @example
 * m.prependToGroup('web', 'csrf')
 */
export class VerifyCsrfToken implements Middleware {
  static readonly inject: readonly [typeof SecurityToken] = [SecurityToken] as const
  readonly #security: ResolvedSecurity

  constructor(security: ResolvedSecurity) {
    this.#security = security
  }

  async handle(ctx: HttpContext, next: Next): Promise<Response> {
    await checkCsrf(ctx, this.#security)
    return next()
  }
}

/**
 * The CSRF token for the current request's session, for forms, meta tags and SPA bootstraps
 * (front ends normally read the `XSRF-TOKEN` cookie instead). Throws a `BootError` when there is
 * no session cookie yet: a token bound to nothing would protect nothing.
 *
 * @example
 * const token = csrfTokenFor(ctx)
 */
export function csrfTokenFor(ctx: HttpContext): string {
  const session = ctx.sessionCookieValue()
  if (session === undefined)
    throw new BootError(
      'no_session_for_csrf',
      'There is no session on this request, so there is no CSRF token to give out.',
      'Start the session first (the auth package does it at sign-in); front ends read the XSRF-TOKEN cookie.',
    )
  const security = currentApplication('csrf.token()').container.make(SecurityToken)
  return csrfToken(security.csrf.key, session)
}
