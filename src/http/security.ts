/**
 * Security defaults for every HTTP response (docs/12 security model):
 *
 * - `X-Content-Type-Options: nosniff`: browsers never guess a JSON body is HTML.
 * - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`: an API response can
 *   run nothing and be framed by nobody.
 * - `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
 *   same-origin`, `Cross-Origin-Opener-Policy: same-origin`.
 * - `Strict-Transport-Security` when the request arrived over HTTPS.
 * - `Cache-Control: no-store` unless a handler set its own: API data is per-user.
 *
 * @module
 */
import type { MiddlewareHandler } from 'hono'

/** Options for {@link securityHeaders}. */
export interface SecurityHeaderOptions {
  /** HSTS max-age in seconds (sent only over HTTPS). Default one year; 0 disables. */
  readonly hstsMaxAge?: number
}

/** Middleware adding the security headers above. */
export function securityHeaders(options: SecurityHeaderOptions = {}): MiddlewareHandler {
  const hsts = options.hstsMaxAge ?? 31_536_000
  return async (c, next) => {
    await next()
    const h = c.res.headers
    h.set('X-Content-Type-Options', 'nosniff')
    h.set('X-Frame-Options', 'DENY')
    h.set('Referrer-Policy', 'no-referrer')
    h.set('Cross-Origin-Resource-Policy', 'same-origin')
    h.set('Cross-Origin-Opener-Policy', 'same-origin')
    if (!h.has('Content-Security-Policy'))
      h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store')
    if (hsts > 0 && new URL(c.req.url).protocol === 'https:') {
      h.set('Strict-Transport-Security', `max-age=${hsts}; includeSubDomains`)
    }
  }
}

/** A request id from the client is accepted only if it is short and harmless; else a new one. */
export function acceptRequestId(header: string | undefined, generate: () => string): string {
  return header !== undefined && /^[A-Za-z0-9._-]{8,128}$/.test(header) ? header : generate()
}
