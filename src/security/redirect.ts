/**
 * The open-redirect guard and Laravel's `redirect()` shape (ported from spike 12). A redirect
 * target that came from the request (`?intended=…`, a "return to" field, a `--redirect` option)
 * may only be a **same-origin path**.
 *
 * Browsers are lenient in ways that turn innocent-looking strings into other sites: `//evil.com`
 * and `/\evil.com` are protocol-relative, `/%2F%2Fevil.com` decodes to one, `/.//evil.com`
 * normalises to one, and tabs or newlines are silently removed. So the guard refuses backslashes
 * and control characters at every decoding layer, and checks the *normalised* result again before
 * trusting it.
 *
 * The {@link Redirector}:
 * - `.to('/posts')` is for your own paths and refuses anything else loudly (it's a bug);
 * - `.intended(ctx, '/dashboard')` goes where the user wanted, **only** if that is a same-origin
 *   path, and silently falls back otherwise (the value came from a client);
 * - `.away('https://partner.example')` is the one explicit way off-site.
 *
 * @module
 */
import { BootError } from '../foundation/boot-error.ts'
import { hasControlCharacter } from './control-characters.ts'

/** The longest target accepted; real paths are far shorter. */
const MAX_LENGTH = 2048
/** How many percent-decoding layers are inspected (double-encoding is the usual trick). */
const DECODE_LAYERS = 3

/**
 * The normalised same-origin path for `candidate`, or `undefined` when it could lead anywhere
 * else (or is malformed).
 *
 * @example
 * safeRedirectTarget('/posts?page=2', 'https://blog.example.com')     // '/posts?page=2'
 * safeRedirectTarget('//evil.com', 'https://blog.example.com')        // undefined
 * safeRedirectTarget('/%2F%2Fevil.com', 'https://blog.example.com')   // undefined
 */
export function safeRedirectTarget(candidate: string, appUrl: string | URL): string | undefined {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_LENGTH)
    return undefined
  let layer = candidate
  for (let depth = 0; depth < DECODE_LAYERS; depth++) {
    if (!looksLikeLocalPath(layer)) return undefined
    const decoded = safeDecode(layer)
    if (decoded === undefined) return undefined
    if (decoded === layer) break
    layer = decoded
  }
  // Still encoded after every inspected layer: too deep to be an honest path.
  if (!looksLikeLocalPath(layer) || safeDecode(layer) !== layer) return undefined
  const base = new URL(appUrl)
  const url = new URL(candidate, base)
  if (url.origin !== base.origin) return undefined
  const path = `${url.pathname}${url.search}${url.hash}`
  // Normalisation can create a protocol-relative path ("/.//evil.com" → "//evil.com").
  return looksLikeLocalPath(path) ? path : undefined
}

/** A single leading slash, then no slash; no backslashes or control characters anywhere. */
function looksLikeLocalPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !hasControlCharacter(value)
  )
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * The statuses a redirect may use.
 *
 * @example
 * const status: RedirectStatus = 303
 */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308

/** The query parameter `intended()` reads (until the session layer stores the intended URL). */
export const INTENDED_PARAMETER = 'intended'

/**
 * Where `intended()` reads the wanted page from: anything with URL-style query access (a request
 * context's `query`), a `Request`, or a `URL`.
 *
 * @example
 * redirector.intended({ query: new URL(request.url).searchParams }, '/dashboard')
 */
export type IntendedSource =
  | { readonly query: { get(name: string): string | null } }
  | Request
  | URL

/**
 * Builds redirect responses for one app URL.
 *
 * @example
 * const redirect = new Redirector('https://blog.example.com')
 * return redirect.intended(ctx, '/dashboard')
 */
export class Redirector {
  readonly #appUrl: URL

  constructor(appUrl: string | URL) {
    if (!URL.canParse(appUrl))
      throw new BootError(
        'invalid_app_url',
        'The app URL given to the redirector is not an absolute URL.',
        'Set APP_URL to the address users reach the app at, e.g. https://app.example.com.',
      )
    this.#appUrl = new URL(appUrl)
  }

  /**
   * Redirect to one of your own paths. Throws a `BootError` (`unsafe_redirect`) for anything that
   * could leave the site: that is a bug in the code calling it.
   *
   * @example
   * return redirect.to('/posts', 303)
   */
  to(path: string, status: RedirectStatus = 302): Response {
    const safe = safeRedirectTarget(path, this.#appUrl)
    if (safe === undefined)
      throw new BootError(
        'unsafe_redirect',
        `redirect().to() was given "${path.slice(0, 200)}", which is not a same-origin path.`,
        'Use redirect().away(url) for a deliberate external redirect.',
      )
    return location(safe, status)
  }

  /**
   * Redirect to where the user was going (the `intended` value), or `fallback` when there is
   * none or it isn't a same-origin path. The fallback itself must be a same-origin path.
   *
   * @example
   * return redirect.intended(ctx, '/dashboard')
   */
  intended(source: IntendedSource, fallback = '/', status: RedirectStatus = 302): Response {
    const candidate = intendedValue(source)
    const safe = candidate === null ? undefined : safeRedirectTarget(candidate, this.#appUrl)
    return this.to(safe ?? fallback, status)
  }

  /**
   * A deliberate redirect to another site (absolute http or https URLs only; credentials in the
   * URL are refused).
   *
   * @example
   * return redirect.away('https://billing.example.com/portal')
   */
  away(url: string, status: RedirectStatus = 302): Response {
    const target = URL.canParse(url) ? new URL(url) : undefined
    if (
      target === undefined ||
      (target.protocol !== 'https:' && target.protocol !== 'http:') ||
      target.username !== '' ||
      target.password !== ''
    )
      throw new BootError(
        'unsafe_redirect',
        'redirect().away() needs an absolute http(s) URL without credentials.',
        'Pass a full URL such as https://example.com/page.',
      )
    return location(target.href, status)
  }
}

function intendedValue(source: IntendedSource): string | null {
  if (source instanceof Request) return new URL(source.url).searchParams.get(INTENDED_PARAMETER)
  if (source instanceof URL) return source.searchParams.get(INTENDED_PARAMETER)
  return source.query.get(INTENDED_PARAMETER)
}

function location(target: string, status: RedirectStatus): Response {
  return new Response(null, { status, headers: { location: target } })
}
