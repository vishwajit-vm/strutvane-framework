/**
 * Security defaults for every HTTP response (docs/12 security model):
 *
 * - `X-Content-Type-Options: nosniff`: browsers never guess a JSON body is HTML.
 * - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`: an API response can
 *   run nothing and be framed by nobody.
 * - `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
 *   same-origin`, `Cross-Origin-Opener-Policy: same-origin`.
 * - `Permissions-Policy`: powerful browser features (camera, microphone, geolocation, payment,
 *   USB, …) are disabled, so a page served from the API origin can never prompt for them.
 * - `Strict-Transport-Security` when the request arrived over HTTPS: directly, through a public
 *   URL configured as `https://…`, or through a *trusted* proxy's `X-Forwarded-Proto`.
 * - `Cache-Control: no-store` unless a handler set its own: API data is per-user.
 *
 * @module
 */
import type { Context, MiddlewareHandler } from 'hono'

/** Options for {@link securityHeaders}. */
export interface SecurityHeaderOptions {
  /** HSTS max-age in seconds (sent only over HTTPS). Default one year; 0 disables. */
  readonly hstsMaxAge?: number
  /**
   * Decides whether the client connection is HTTPS. Default: the request URL's protocol.
   * `createHttpApp` passes one that also honours `publicUrl` and trusted proxies.
   */
  readonly isHttps?: (c: Context) => boolean
}

/** Features disabled for every response (docs/12 §headers). */
export const PERMISSIONS_POLICY: string =
  'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), ' +
  'magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(self), ' +
  'usb=(), xr-spatial-tracking=()'

/** Middleware adding the security headers above. */
export function securityHeaders(options: SecurityHeaderOptions = {}): MiddlewareHandler {
  const hsts = options.hstsMaxAge ?? 31_536_000
  const isHttps = options.isHttps ?? ((c: Context) => new URL(c.req.url).protocol === 'https:')
  return async (c, next) => {
    await next()
    const h = c.res.headers
    h.set('X-Content-Type-Options', 'nosniff')
    h.set('X-Frame-Options', 'DENY')
    h.set('Referrer-Policy', 'no-referrer')
    h.set('Cross-Origin-Resource-Policy', 'same-origin')
    h.set('Cross-Origin-Opener-Policy', 'same-origin')
    if (!h.has('Permissions-Policy')) h.set('Permissions-Policy', PERMISSIONS_POLICY)
    if (!h.has('Content-Security-Policy'))
      h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store')
    if (hsts > 0 && isHttps(c)) {
      h.set('Strict-Transport-Security', `max-age=${hsts}; includeSubDomains`)
    }
  }
}

/**
 * A request id from the client is accepted only if it is short and harmless; else a new one.
 * Callers pass `trusted: false` (the default in `createHttpApp`) unless a proxy they run sets the
 * header, because a client-chosen id would let anyone forge or collide log correlation ids.
 */
export function acceptRequestId(
  header: string | undefined,
  generate: () => string,
  trusted = true,
): string {
  return trusted && header !== undefined && /^[A-Za-z0-9._-]{8,128}$/.test(header)
    ? header
    : generate()
}
