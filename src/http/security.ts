/**
 * Security defaults for every HTTP response (docs/12 security model), as Hono middleware. The
 * headers themselves come from the security kit's one builder (`security/secure-headers.ts`), so
 * the JSON API and HTML pages can never drift apart. With the default `api` preset:
 *
 * - `X-Content-Type-Options: nosniff`: browsers never guess a JSON body is HTML.
 * - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`: an API response can
 *   run nothing and be framed by nobody.
 * - `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
 *   same-origin`, `Cross-Origin-Opener-Policy: same-origin`.
 * - `Permissions-Policy`: powerful browser features (camera, microphone, geolocation, payment,
 *   USB, …) are disabled, so a page served from the API origin can never prompt for them.
 * - `Strict-Transport-Security` when the request arrived over HTTPS: directly, through a public
 *   URL configured as `https://…`, or through a *trusted* proxy's `X-Forwarded-Proto`; and only
 *   in production (an unset `environment` counts as production: fail closed).
 * - `Cache-Control: no-store` unless a handler set its own: API data is per-user.
 *
 * Every header a handler set itself wins (the docs page and the built UI send their own CSP).
 * A fresh CSP nonce is made per request, before the handler runs; pass `nonce` to share it with
 * the code that renders pages (the `page` preset puts it in `script-src` and `style-src`).
 *
 * @module
 */
import type { Context, MiddlewareHandler } from 'hono'
import {
  applySecurityHeaders,
  createCspNonce,
  type HeaderOptions,
  PERMISSIONS_POLICY,
  resolveHeaders,
} from '../security/secure-headers.ts'

export { PERMISSIONS_POLICY }

/**
 * Options for {@link securityHeaders}.
 *
 * @example
 * const options: SecurityHeaderOptions = { hstsMaxAge: 63_072_000, environment: 'production' }
 */
export interface SecurityHeaderOptions {
  /** HSTS max-age in seconds (sent only over HTTPS in production). Default one year; 0 disables. */
  readonly hstsMaxAge?: number
  /**
   * Decides whether the client connection is HTTPS. Default: the request URL's protocol.
   * `createHttpApp` passes one that also honours `publicUrl` and trusted proxies.
   */
  readonly isHttps?: (c: Context) => boolean
  /** The app environment (`APP_ENV`). Default `production`: HSTS then follows HTTPS alone. */
  readonly environment?: string
  /** Header settings (preset, CSP sources, …). Default: the `api` preset. */
  readonly headers?: HeaderOptions
  /** The CSP nonce for this request. Default: a fresh {@link createCspNonce} per request. */
  readonly nonce?: (c: Context) => string
}

/**
 * Middleware adding the security headers above to every response. Invalid header settings throw
 * a `SecuritySettingError` when the middleware is created (at boot), never per request.
 *
 * @example
 * http.use('*', securityHeaders({ isHttps, environment: env }))
 */
export function securityHeaders(options: SecurityHeaderOptions = {}): MiddlewareHandler {
  const environment = options.environment ?? 'production'
  const headerOptions: HeaderOptions = { preset: 'api', ...options.headers }
  const resolved = resolveHeaders(
    options.hstsMaxAge === undefined
      ? headerOptions
      : {
          ...headerOptions,
          hsts:
            headerOptions.hsts === false
              ? false
              : { ...headerOptions.hsts, maxAge: options.hstsMaxAge },
        },
    { environment },
  )
  const isHttps = options.isHttps ?? ((c: Context) => new URL(c.req.url).protocol === 'https:')
  return async (c, next) => {
    const nonce = options.nonce?.(c) ?? createCspNonce()
    await next()
    applySecurityHeaders(c.res.headers, resolved, { nonce, secure: isHttps(c), environment })
  }
}

/**
 * A request id from the client is accepted only if it is short and harmless; else a new one.
 * Callers pass `trusted: false` (the default in `createHttpApp`) unless a proxy they run sets the
 * header, because a client-chosen id would let anyone forge or collide log correlation ids.
 *
 * @example
 * acceptRequestId(c.req.header('x-request-id'), () => crypto.randomUUID(), hops > 0)
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
