/**
 * The session cookie's name, from ONE source (CONSISTENCY #24, #105).
 *
 * The session layer (`@strutvane/auth`) sets the cookie and the framework's CSRF check looks for
 * it. When the two disagree about the name, the CSRF check sees "no session", skips, and every
 * cookie-authenticated write is open to cross-site requests. So neither side spells the name
 * itself: both call {@link sessionCookieName} with the app's configured base name (`config/
 * session.ts` `cookie`, default `strutvane_session`), and the framework publishes the resolved
 * value under {@link SessionCookieToken} for packages that only have the container.
 *
 * On https the name gets the `__Host-` prefix: browsers then refuse the cookie unless it is
 * `Secure`, has `Path=/` and no `Domain`, so a sibling subdomain can neither set nor shadow it
 * (cookie tossing).
 *
 * @module
 */
import { type Token, token } from '../core/index.ts'

/** The default base name of the session cookie. */
export const DEFAULT_SESSION_COOKIE = 'strutvane_session'

/** The cookie that hands the CSRF token to front-end code (CONSISTENCY #17). */
export const XSRF_COOKIE = 'XSRF-TOKEN'

/** The prefix browsers enforce as "Secure, Path=/, no Domain". */
const HOST_PREFIX = '__Host-'

/** A cookie name (RFC 6265 token characters only). */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/

/** The session cookie as the app resolved it. */
export interface SessionCookie {
  /** The name the session layer must set: `__Host-<base>` on https, else `<base>`. */
  readonly name: string
  /** The configured base name, without any prefix. */
  readonly base: string
  /** `true` when the app is served over https (the cookie must be `Secure`). */
  readonly secure: boolean
}

/**
 * The resolved session cookie, for packages that set or read it (connection 2: container token).
 *
 * @example
 * const cookie = app.make(SessionCookieToken) // { name: '__Host-strutvane_session', … }
 */
export const SessionCookieToken: Token<SessionCookie> = token<SessionCookie>(
  'strutvane.http.sessionCookie',
)

/**
 * Resolve the session cookie for the app's scheme. The base name must be a plain cookie name
 * without a `__Host-`/`__Secure-` prefix (the prefix is decided here, from the scheme).
 *
 * @example
 * sessionCookieName({ secure: true }).name                  // '__Host-strutvane_session'
 * sessionCookieName({ base: 'acme_session', secure: false }) // { name: 'acme_session', … }
 */
export function sessionCookieName(options: {
  readonly base?: string
  readonly secure: boolean
}): SessionCookie {
  const base = options.base ?? DEFAULT_SESSION_COOKIE
  if (!COOKIE_NAME.test(base) || /^__(?:host|secure)-/i.test(base)) {
    throw new TypeError(
      `session cookie: "${base}" is not a plain cookie name (letters, digits and _-.; the __Host- prefix is added on https)`,
    )
  }
  return Object.freeze({
    name: options.secure ? `${HOST_PREFIX}${base}` : base,
    base,
    secure: options.secure,
  })
}

/**
 * Every value of cookie `name` in a `Cookie` header, in header order. Values are returned as
 * sent (not URI-decoded): the CSRF token is bound to the exact bytes the browser holds.
 *
 * @example
 * cookieValues('a=1; b=2; a=3', 'a') // ['1', '3']
 */
export function cookieValues(header: string | null | undefined, name: string): string[] {
  if (!header) return []
  const out: string[] = []
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    let value = part.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1)
    out.push(value)
  }
  return out
}

/**
 * The session cookie's value in a request, under either spelling of the configured name. Both
 * spellings count, so a scheme mismatch (an https app reached over http, or a proxy that hides
 * the scheme) can only make the CSRF check run, never skip it. The first occurrence wins, as it
 * does for the session layer.
 *
 * @example
 * sessionCookieValue('__Host-strutvane_session=abc', cookie) // 'abc'
 */
export function sessionCookieValue(
  header: string | null | undefined,
  cookie: SessionCookie,
): string | undefined {
  for (const name of [cookie.name, cookie.base, `${HOST_PREFIX}${cookie.base}`]) {
    const value = cookieValues(header, name).find((v) => v !== '')
    if (value !== undefined) return value
  }
  return undefined
}
