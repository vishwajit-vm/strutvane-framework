/**
 * Maintenance mode, Laravel's `php artisan down` / `up`: the per-request check the HTTP kernel
 * runs between the trusted-host check and CORS (`MaintenanceCheckToken`).
 *
 * While the app is down (`storage/framework/down` exists, see `state.ts`):
 * - the health route (`/up`) still answers, so the load balancer keeps the instance
 *   (CONSISTENCY #45);
 * - `/<secret>` (from `down --secret` or `--with-secret`) sets a bypass cookie and redirects home;
 * - a valid bypass cookie lets the request through;
 * - `--redirect=/path` sends every other request to that same-origin path;
 * - everything else gets a 503 `maintenance_mode` problem with `Retry-After`/`Refresh`, or the
 *   pre-rendered `--render` page for browsers.
 *
 * **Secrets:** unlike Laravel, the bypass secret is never stored. The state file holds an HMAC of
 * it under an `APP_KEY` subkey (`keyring.derive('maintenance')`), so a leaked file reveals nothing
 * and a guessable secret can't be brute-forced offline without the key. The bypass cookie is an
 * expiring HMAC that names the current secret's hash, so `down` with a new secret invalidates every
 * old cookie. Both are verified with every key of the keyring, so `key:rotate` during maintenance
 * doesn't lock the team out.
 *
 * @module
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { StrutvaneError } from '../core/errors/errors.ts'
import type { Keyring } from '../security/keyring.ts'
import { safeRedirectTarget } from '../security/redirect.ts'
import { type MaintenanceState, readMaintenance } from './state.ts'

/**
 * The bypass cookie's name.
 *
 * @example
 * request.headers.get('cookie')?.includes(BYPASS_COOKIE)
 */
export const BYPASS_COOKIE = 'strutvane_maintenance'

/**
 * How long a bypass cookie lasts: 12 hours, as in Laravel.
 *
 * @example
 * BYPASS_SECONDS // 43200
 */
export const BYPASS_SECONDS: number = 12 * 60 * 60

/**
 * What a bypass secret looks like: 8 to 128 URL-safe characters (one path segment).
 *
 * @example
 * MAINTENANCE_SECRET.test('team-preview-2026') // true
 */
export const MAINTENANCE_SECRET: RegExp = /^[A-Za-z0-9_-]{8,128}$/

/** The key purpose of every maintenance HMAC. */
const PURPOSE = 'maintenance'

/**
 * The CSP of the pre-rendered page: its own inline styles and images, never scripts. It replaces
 * the app's CSP for this response (a response's own headers win), because the page's stylesheet
 * would get a 503 too while the app is down.
 */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/**
 * The stored form of a bypass secret: an HMAC under the maintenance subkey of the current key.
 *
 * @example
 * secretHash(keyring, 'team-preview-2026') // '9f2c…' (64 hex characters)
 */
export function secretHash(keyring: Keyring, secret: string): string {
  return createHmac('sha256', keyring.derive(PURPOSE)).update(`secret|${secret}`).digest('hex')
}

/**
 * The value of a fresh bypass cookie: `<expires>.<mac>`, bound to the current secret's hash.
 *
 * @example
 * bypassCookieValue(keyring, state, 1763243200) // '1763243200.Qm9…'
 */
export function bypassCookieValue(
  keyring: Keyring,
  state: MaintenanceState,
  expires: number,
): string {
  return `${expires}.${bypassMac(keyring.derive(PURPOSE), state, expires)}`
}

/**
 * Validate a `--redirect` value: a same-origin path only (`//evil.com`, absolute URLs, encoded
 * and backslash tricks are refused, using the framework's open-redirect guard).
 *
 * @example
 * maintenanceRedirect('/status', 'https://blog.example.com')     // '/status'
 * maintenanceRedirect('//evil.com', 'https://blog.example.com')  // undefined
 */
export function maintenanceRedirect(value: string, appUrl: string): string | undefined {
  return safeRedirectTarget(value, appUrl)
}

/**
 * The kernel's maintenance check: a response while the app is down, or `undefined` to carry on.
 * Bound as the default `MaintenanceCheckToken`.
 *
 * @example
 * const response = await checkMaintenance(request, { basePath, keyring, healthPath: '/up', now: () => Date.now(), secureCookies: true })
 */
export async function checkMaintenance(
  request: Request,
  options: {
    basePath: string
    keyring: Keyring
    healthPath: string
    now: () => number
    secureCookies: boolean
  },
): Promise<Response | undefined> {
  const state = readMaintenance(options.basePath)
  if (state === undefined) return undefined
  const url = new URL(request.url)
  const path = url.pathname
  if (path === options.healthPath) return undefined
  const candidate = path.slice(1)
  if (
    state.secretHash !== undefined &&
    MAINTENANCE_SECRET.test(candidate) &&
    matchesSecret(options.keyring, state.secretHash, candidate)
  )
    return bypassResponse(options, state, url.protocol === 'https:')
  if (hasBypass(request, state, options.keyring, options.now())) return undefined
  if (state.redirect !== undefined && path !== new URL(state.redirect, url).pathname)
    return new Response(null, { status: 302, headers: { location: state.redirect } })
  const headers: Record<string, string> = {}
  if (state.retry !== undefined) headers['retry-after'] = String(state.retry)
  if (state.refresh !== undefined) headers['refresh'] = String(state.refresh)
  if (state.html !== undefined && prefersHtml(request))
    return new Response(state.html, {
      status: 503,
      headers: {
        ...headers,
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': PAGE_CSP,
      },
    })
  throw new StrutvaneError('maintenance_mode', { status: 503, headers })
}

/** `true` when the request carries a valid, unexpired bypass cookie for the current secret. */
function hasBypass(
  request: Request,
  state: MaintenanceState,
  keyring: Keyring,
  nowMs: number,
): boolean {
  if (state.secretHash === undefined) return false
  const cookie = cookieValue(request.headers.get('cookie'), BYPASS_COOKIE)
  const match = cookie === undefined ? null : /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cookie)
  if (match === null) return false
  const expires = Number(match[1])
  if (expires * 1000 <= nowMs) return false
  const mac = match[2] ?? ''
  return keyring
    .deriveAll(PURPOSE)
    .some((key) => constantTimeEqual(mac, bypassMac(key, state, expires)))
}

function matchesSecret(keyring: Keyring, stored: string, candidate: string): boolean {
  return keyring
    .deriveAll(PURPOSE)
    .some((key) =>
      constantTimeEqual(
        createHmac('sha256', key).update(`secret|${candidate}`).digest('hex'),
        stored,
      ),
    )
}

function bypassMac(key: Buffer, state: MaintenanceState, expires: number): string {
  return createHmac('sha256', key)
    .update(`bypass|${state.secretHash ?? ''}|${expires}`)
    .digest('base64url')
}

function bypassResponse(
  options: Parameters<typeof checkMaintenance>[1],
  state: MaintenanceState,
  secureRequest: boolean,
): Response {
  const expires = Math.floor(options.now() / 1000) + BYPASS_SECONDS
  const secure = options.secureCookies || secureRequest ? '; Secure' : ''
  const cookie = `${BYPASS_COOKIE}=${bypassCookieValue(options.keyring, state, expires)}; Path=/; Max-Age=${BYPASS_SECONDS}; HttpOnly; SameSite=Lax${secure}`
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': cookie } })
}

/** One cookie's value from a `Cookie` header (the first one with that name). */
function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

/** Browsers ask for HTML; API clients, `curl` and `fetch()` get the problem JSON. */
function prefersHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
