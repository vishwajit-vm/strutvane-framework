/**
 * CSRF protection for every unsafe request, on by default (blueprint §5.2; ported from spike 12).
 *
 * CSRF only matters when the browser attaches the credential by itself, which means the session
 * cookie. So the rule is: every POST, PUT, PATCH or DELETE that carries the session cookie must
 * prove it comes from the app's own pages, by one of:
 *
 * 1. `Sec-Fetch-Site: same-origin`;
 * 2. an `Origin` header exactly equal to the app's origin (`APP_URL`, or the request's own
 *    allowlisted host) or a configured trusted origin, with no `Sec-Fetch-Site` saying otherwise.
 *    `null` never passes, and neither does a sibling subdomain (`same-site`);
 * 3. a valid token in `X-XSRF-TOKEN` / `X-CSRF-TOKEN`, or in a urlencoded form's `_token` field.
 *
 * Otherwise the answer is 419 with problem code `csrf_token_mismatch` (CONSISTENCY #30).
 *
 * **The token** is an HMAC of the session cookie's value under a key derived from `APP_KEY`
 * (HKDF, purpose `csrf`). The framework hands it to front-end code in the `XSRF-TOKEN` cookie
 * (readable by scripts, `SameSite=Lax`; CONSISTENCY #17), refreshed whenever the session cookie
 * changes, so `@strutvane/ui` and the generated client can echo it in `X-XSRF-TOKEN`. A page on
 * another site can neither read that cookie nor compute the HMAC.
 *
 * **Bearer tokens** skip the check, because browsers never attach them by themselves: a request
 * without the session cookie is not checked. A request that carries the session cookie *is*
 * checked even when it also sends `Authorization`: the framework cannot know which credential the
 * auth layer will accept, and a junk bearer next to the cookie must not switch the check off.
 *
 * **The session cookie's name** comes from one source (`session-cookie.ts`, CONSISTENCY #105),
 * and both spellings (`strutvane_session`, `__Host-strutvane_session`) count, so a renamed or
 * prefixed cookie can never make the check skip.
 *
 * `Referer` is never used: it is often stripped, and a same-site page can shape it. The HTTP
 * method is the real one: no `X-HTTP-Method-Override` or `_method` field turns a POST into a GET.
 *
 * @module
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { StrutvaneError } from '../core/index.ts'
import { routerPath } from './router-path.ts'
import {
  cookieValues,
  type SessionCookie,
  sessionCookieValue,
  XSRF_COOKIE,
} from './session-cookie.ts'

/** The problem code of a refused request (CONSISTENCY #30). */
export const CSRF_ERROR_CODE = 'csrf_token_mismatch'

/** Methods that never change state, so they are never checked. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

/** Forms are small; a `_token` lookup never buffers more than this. */
const FORM_TOKEN_READ_LIMIT = 64 * 1024

/**
 * CSRF options (`config/session.ts` `csrf`, or `createHttpApp({ csrf })`).
 *
 * @example
 * const csrf: CsrfOptions = { except: ['webhooks/*', 'oauth/callback'], origins: ['https://admin.example.com'] }
 */
export interface CsrfOptions {
  /**
   * Paths that are never checked, for callbacks a third party posts to (OAuth, payment
   * providers). Laravel's format: no leading slash needed, `*` matches anything (slashes
   * included), matched against the whole path as the router decodes it (`api/v1/payments/webhook`).
   */
  readonly except?: readonly string[]
  /** Extra origins (`scheme://host[:port]`) trusted like the app's own. Never `null` or `*`. */
  readonly origins?: readonly string[]
}

/** The checked settings {@link csrfProtection} runs with. */
export interface ResolvedCsrf {
  /** Normalised `except` patterns (no leading slash). */
  readonly except: readonly string[]
  /** The app's origin (when `APP_URL` is set) and the extra trusted origins, normalised. */
  readonly origins: readonly string[]
  /** The 32-byte key the token HMAC uses (derived from `APP_KEY`). */
  readonly key: Buffer
  readonly cookie: SessionCookie
}

/**
 * Validate the options and derive the token key. Throws a `TypeError` listing every bad pattern
 * or origin, so a typo fails at boot instead of silently trusting (or excepting) too much.
 *
 * Without an `APP_KEY` a random key is used for the life of the process: tokens then stop
 * matching after a restart (a reload fixes it), which is acceptable in development and fails
 * closed everywhere else.
 *
 * @example
 * resolveCsrf({ except: ['webhooks/*'] }, { appKey: env.APP_KEY, publicUrl, cookie })
 */
export function resolveCsrf(
  options: CsrfOptions,
  where: {
    readonly appKey: string | undefined
    readonly publicUrl: URL | undefined
    readonly cookie: SessionCookie
  },
): ResolvedCsrf {
  const problems: string[] = []
  for (const pattern of options.except ?? []) {
    if (typeof pattern !== 'string' || pattern.trim() === '' || /\s/.test(pattern))
      problems.push(`csrf.except: "${String(pattern)}" is not a path pattern (e.g. "webhooks/*")`)
  }
  const origins = where.publicUrl ? [where.publicUrl.origin] : []
  for (const origin of options.origins ?? []) {
    const normalised = exactOrigin(origin)
    if (normalised === undefined)
      problems.push(
        `csrf.origins: "${origin}" must be an exact origin such as https://admin.example.com (no path, no "*", never "null")`,
      )
    else origins.push(normalised)
  }
  if (problems.length > 0) throw new TypeError(problems.join('\n'))
  const secret =
    where.appKey !== undefined && where.appKey !== '' ? where.appKey : randomBytes(32).toString()
  return Object.freeze({
    except: (options.except ?? []).map((p) => p.replace(/^\/+/, '')),
    origins: [...new Set(origins)],
    key: Buffer.from(hkdfSync('sha256', secret, 'strutvane', 'strutvane:csrf:v1', 32)),
    cookie: where.cookie,
  })
}

/**
 * The CSRF token for a session cookie value: base64url HMAC-SHA256 under the derived key. Bound
 * to the session, so a token taken from another session is useless.
 *
 * @example
 * csrfToken(settings.key, sessionValue) // 'k1Yq…'
 */
export function csrfToken(key: Buffer, sessionValue: string): string {
  return createHmac('sha256', key).update(sessionValue).digest('base64url')
}

/**
 * The normalised origin of `value`, or `undefined` unless it is exactly `scheme://host[:port]`
 * over http or https.
 *
 * @example
 * exactOrigin('https://Admin.Example.com') // 'https://admin.example.com'
 * exactOrigin('https://example.com/path')  // undefined
 */
export function exactOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  // A path, query or credentials mean the author meant something narrower than an origin;
  // refuse rather than silently widen it to the whole origin.
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/' ||
    url.hostname.includes('*') ||
    /[?#]$/.test(value) ||
    !/^https?:\/\/[^/]+\/?$/i.test(value)
  )
    return undefined
  return url.origin
}

/**
 * Does a request path match a Laravel-style pattern? Leading slashes are ignored and `*`
 * matches any run of characters (slashes included).
 *
 * @example
 * matchesPathPattern('webhooks/*', '/webhooks/stripe') // true
 * matchesPathPattern('webhooks', '/webhooks/stripe')   // false
 */
export function matchesPathPattern(pattern: string, path: string): boolean {
  const source = pattern
    .replace(/^\/+/, '')
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(path.replace(/^\/+/, ''))
}

/** Options for {@link csrfProtection} that depend on the request (scheme, own origin). */
export interface CsrfRequestInfo {
  /** The origin the client used to reach this app (`https://app.example.com`), when known. */
  readonly ownOrigin: (c: Context) => string | undefined
  /** `true` when the client connection is https (the `XSRF-TOKEN` cookie is then `Secure`). */
  readonly isHttps: (c: Context) => boolean
}

/**
 * The CSRF middleware: checks unsafe requests that carry the session cookie, and keeps the
 * `XSRF-TOKEN` cookie in step with the session cookie on every response.
 *
 * @example
 * http.use('*', csrfProtection(resolveCsrf({}, { appKey, publicUrl, cookie }), info))
 */
export function csrfProtection(settings: ResolvedCsrf, info: CsrfRequestInfo): MiddlewareHandler {
  return async (c, next) => {
    const cookieHeader = c.req.header('cookie')
    const session = sessionCookieValue(cookieHeader, settings.cookie)
    if (
      session !== undefined &&
      !SAFE_METHODS.has(c.req.method) &&
      !excepted(settings, routerPath(c.req.raw)) &&
      !sameOrigin(c, settings, info) &&
      !(await validToken(c, settings, session))
    ) {
      throw new StrutvaneError(CSRF_ERROR_CODE, { status: 419 })
    }
    await next()
    issueXsrfCookie(c, settings, session, cookieHeader, info.isHttps(c))
  }
}

/** Matched on the router's own path, so an exception covers exactly the routes it names. */
function excepted(settings: ResolvedCsrf, path: string): boolean {
  return settings.except.some((p) => matchesPathPattern(p, path))
}

function sameOrigin(c: Context, settings: ResolvedCsrf, info: CsrfRequestInfo): boolean {
  const fetchSite = c.req.header('sec-fetch-site')
  if (fetchSite === 'same-origin') return true
  // `same-site` (a sibling subdomain) and `cross-site` never pass on headers alone; `none` is a
  // user-typed navigation, which then still needs a matching Origin.
  if (fetchSite !== undefined && fetchSite !== 'none') return false
  const origin = c.req.header('origin')
  if (origin === undefined || origin === 'null') return false
  const normalised = exactOrigin(origin)
  if (normalised === undefined) return false
  return settings.origins.includes(normalised) || normalised === info.ownOrigin(c)
}

async function validToken(c: Context, settings: ResolvedCsrf, session: string): Promise<boolean> {
  const sent =
    c.req.header('x-xsrf-token') ?? c.req.header('x-csrf-token') ?? (await formToken(c.req.raw))
  if (sent === undefined || sent === '') return false
  return constantTimeEqual(sent, csrfToken(settings.key, session))
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // Constant-time comparison, so the token can't be guessed byte by byte from timings.
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The `_token` field of a urlencoded form body, read from a clone (the handler can still read
 * the body) and capped in size. Multipart and JSON bodies use the header instead.
 */
async function formToken(request: Request): Promise<string | undefined> {
  const essence = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (essence !== 'application/x-www-form-urlencoded' || request.body === null) return undefined
  try {
    const text = await readLimited(request.clone(), FORM_TOKEN_READ_LIMIT)
    return text === undefined ? undefined : (new URLSearchParams(text).get('_token') ?? undefined)
  } catch {
    // An aborted or unreadable body: treat as "no token" (the request is then refused).
    return undefined
  }
}

/** Read at most `limit` bytes of a body as text; `undefined` when it is bigger. */
async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One `Set-Cookie` header's name, value and whether it deletes the cookie. */
function parseSetCookie(header: string): { name: string; value: string; expired: boolean } {
  const [pair = '', ...attributes] = header.split(';')
  const eq = pair.indexOf('=')
  const name = (eq === -1 ? pair : pair.slice(0, eq)).trim()
  const value = eq === -1 ? '' : pair.slice(eq + 1).trim()
  const expired = attributes.some((a) => {
    const [key = '', raw = ''] = a.split('=')
    const k = key.trim().toLowerCase()
    if (k === 'max-age') return Number(raw.trim()) <= 0
    if (k === 'expires') return Date.parse(raw.trim()) <= Date.now()
    return false
  })
  return { name, value, expired: expired || value === '' }
}

/**
 * Keep `XSRF-TOKEN` in step with the session: the response's own new session cookie wins (a
 * sign-in rotates it), else the request's. When the session ends, the token cookie goes too.
 */
function issueXsrfCookie(
  c: Context,
  settings: ResolvedCsrf,
  requestSession: string | undefined,
  cookieHeader: string | undefined,
  secure: boolean,
): void {
  let session = requestSession
  for (const header of c.res.headers.getSetCookie()) {
    const set = parseSetCookie(header)
    if (
      set.name !== settings.cookie.name &&
      set.name !== settings.cookie.base &&
      set.name !== `__Host-${settings.cookie.base}`
    )
      continue
    session = set.expired ? undefined : set.value
  }
  const current = cookieValues(cookieHeader, XSRF_COOKIE)[0]
  const attributes = `Path=/; SameSite=Lax${secure ? '; Secure' : ''}`
  let cookie: string | undefined
  if (session === undefined) {
    if (current !== undefined) cookie = `${XSRF_COOKIE}=; Max-Age=0; ${attributes}`
  } else {
    const token = csrfToken(settings.key, session)
    if (current !== token) cookie = `${XSRF_COOKIE}=${token}; ${attributes}`
  }
  if (cookie === undefined) return
  try {
    c.res.headers.append('set-cookie', cookie)
  } catch {
    // Immutable headers (a Response passed through untouched): the token cookie is issued on
    // the next response instead. Until then same-origin requests still pass on their headers.
  }
}
