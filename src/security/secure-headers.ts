/**
 * Security headers on every response, errors included (ported from spike 12): a
 * Content-Security-Policy with a fresh nonce per response, HSTS in production over HTTPS,
 * `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, and `frame-ancestors 'none'`
 * (plus the legacy `X-Frame-Options`) against clickjacking.
 *
 * Two presets share one implementation:
 * - `page` (the default for apps that render HTML): `script-src`/`style-src` allow `'self'` and
 *   the per-response nonce, nothing inline without it; violations are reported to
 *   {@link CSP_REPORT_PATH}; `upgrade-insecure-requests` in production.
 * - `api` (what `createHttpApp`'s JSON API sends): `default-src 'none'` (a JSON body can run
 *   nothing), `Referrer-Policy: no-referrer` and `Cache-Control: no-store` (API data is per-user).
 *
 * A header the response already set wins: the debug page sends its own CSP, the docs page its
 * own, a route may need `frame-ancestors` for an embed. Settings are validated at boot so a
 * configured source can never smuggle in a second directive (`;`, `,`, spaces) or a new header
 * line (CR/LF): such a value is refused before the app starts, never sent.
 *
 * HSTS is sent only when the request really arrived over HTTPS (`secure`, which comes from the
 * socket or a *trusted* proxy, never from a client's own `X-Forwarded-Proto`) and only in
 * production: over plain HTTP browsers ignore it, and in development it would pin `localhost` to
 * HTTPS for a year.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { hasControlCharacter } from './control-characters.ts'
import { failIfAny } from './setting-error.ts'

/**
 * Which defaults to start from: `page` for HTML apps, `api` for JSON APIs.
 *
 * @example
 * const preset: HeaderPreset = 'api'
 */
export type HeaderPreset = 'page' | 'api'

/**
 * HSTS settings.
 *
 * @example
 * const hsts: HstsOptions = { maxAge: 63_072_000, preload: true }
 */
export interface HstsOptions {
  /** Seconds (default one year, at most two). `0` turns HSTS off. */
  readonly maxAge?: number
  /** Default `true`. */
  readonly includeSubDomains?: boolean
  /** Ask for the browsers' preload list (needs a year or more and `includeSubDomains`). */
  readonly preload?: boolean
}

/**
 * Options for the security headers (`settings.headers({ … })`).
 *
 * @example
 * const options: HeaderOptions = { csp: { 'img-src': ['https://images.example.com'] } }
 */
export interface HeaderOptions {
  /** The defaults to start from. Default `page`. */
  readonly preset?: HeaderPreset
  /** Extra sources per CSP directive, added to the defaults; `false` turns CSP off (flagged by `security:check`). */
  readonly csp?: Readonly<Record<string, readonly string[]>> | false
  /** Send `Content-Security-Policy-Report-Only` instead (to trial a policy). */
  readonly cspReportOnly?: boolean
  /** HSTS settings; `false` turns it off. Only ever sent in production over HTTPS. */
  readonly hsts?: HstsOptions | false
  readonly permissionsPolicy?: string
  readonly referrerPolicy?: string
  /** `Cache-Control` when the response has none. Default: `no-store` for `api`, none for `page`. */
  readonly cacheControl?: string | false
}

/**
 * What the defaults depend on.
 *
 * @example
 * const where: HeaderEnvironment = { environment: 'production' }
 */
export interface HeaderEnvironment {
  readonly environment: string
}

/**
 * The checked header settings. `csp` holds directives with `{nonce}` placeholders.
 *
 * @example
 * resolved.fixed // [['x-content-type-options', 'nosniff'], …]
 */
export interface ResolvedHeaders {
  readonly csp: ReadonlyMap<string, readonly string[]> | undefined
  readonly cspReportOnly: boolean
  /** The `Strict-Transport-Security` value, or `undefined` when off. */
  readonly hsts: string | undefined
  /** Headers set on every response that has none of its own. */
  readonly fixed: readonly (readonly [string, string])[]
}

/**
 * What one response needs: its nonce, whether the client connection is HTTPS (from the socket or
 * a trusted proxy), and the environment.
 *
 * @example
 * const request: HeaderRequest = { nonce: createCspNonce(), secure: true, environment: 'production' }
 */
export interface HeaderRequest {
  readonly nonce: string
  readonly secure: boolean
  readonly environment: string
}

/** The path the `page` CSP reports violations to (served by the framework). */
export const CSP_REPORT_PATH = '/_strutvane/csp-report'

/** Browser features disabled for every API response (docs/12 §headers). */
export const PERMISSIONS_POLICY: string =
  'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), ' +
  'magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(self), ' +
  'usb=(), xr-spatial-tracking=()'

const PAGE_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()'

const PAGE_CSP: readonly (readonly [string, readonly string[]])[] = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'", "'nonce-{nonce}'"]],
  ['style-src', ["'self'", "'nonce-{nonce}'"]],
  ['img-src', ["'self'", 'data:']],
  ['font-src', ["'self'"]],
  ['connect-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'self'"]],
  ['frame-ancestors', ["'none'"]],
  ['report-uri', [CSP_REPORT_PATH]],
]

const API_CSP: readonly (readonly [string, readonly string[]])[] = [
  ['default-src', ["'none'"]],
  ['frame-ancestors', ["'none'"]],
]

const REFERRER_POLICIES: ReadonlySet<string> = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
])
const DIRECTIVE = /^[a-z][a-z-]*$/
/**
 * A CSP source: a keyword in single quotes, or a scheme/host source. No `;`, `,`, spaces or
 * quotes elsewhere: any of those would end the source and start a new one (or a new directive).
 */
const SOURCE =
  /^'(?:self|none|unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic|report-sample|wasm-unsafe-eval|nonce-\{nonce\}|(?:nonce|sha256|sha384|sha512)-[A-Za-z0-9+/_=-]+)'$|^[A-Za-z0-9*][A-Za-z0-9+.\-*:/_%?=&@~[\]]*$/

/** A nonce as {@link createCspNonce} makes them: base64(url), 16+ characters. */
const NONCE = /^[A-Za-z0-9+/_-]{16,128}={0,2}$/
const MAX_HSTS_AGE = 63_072_000

/**
 * Validate header options and build the header values. Throws a `SecuritySettingError` listing
 * every bad setting (a CSP source that would inject a directive, a header value with a line
 * break, an unknown Referrer-Policy, an impossible HSTS setting).
 *
 * @example
 * resolveHeaders({ csp: { 'img-src': ['https://images.example.com'] } }, { environment: 'production' })
 */
export function resolveHeaders(options: HeaderOptions, where: HeaderEnvironment): ResolvedHeaders {
  const problems: string[] = []
  const preset = options.preset ?? 'page'
  if (preset !== 'page' && preset !== 'api')
    problems.push(`securityHeaders preset: "${String(preset)}" is not "page" or "api".`)
  const csp =
    options.csp === false ? undefined : buildCsp(preset, options.csp ?? {}, where, problems)
  const referrer =
    options.referrerPolicy ?? (preset === 'api' ? 'no-referrer' : 'strict-origin-when-cross-origin')
  if (!REFERRER_POLICIES.has(referrer))
    problems.push(
      `securityHeaders referrerPolicy: "${referrer}" is not a Referrer-Policy value (e.g. "strict-origin-when-cross-origin").`,
    )
  const permissions =
    options.permissionsPolicy ?? (preset === 'api' ? PERMISSIONS_POLICY : PAGE_PERMISSIONS_POLICY)
  if (hasControlCharacter(permissions))
    problems.push(
      'securityHeaders permissionsPolicy: control characters (such as a line break) are not allowed in a header value.',
    )
  const cacheControl =
    options.cacheControl === false
      ? undefined
      : (options.cacheControl ?? (preset === 'api' ? 'no-store' : undefined))
  if (cacheControl !== undefined && (cacheControl === '' || hasControlCharacter(cacheControl)))
    problems.push(
      'securityHeaders cacheControl: must be a non-empty value without control characters (such as a line break).',
    )
  const hsts = hstsValue(options.hsts, problems)
  failIfAny(problems)
  const fixed: (readonly [string, string])[] = [
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', referrer],
    ['permissions-policy', permissions],
    ['cross-origin-opener-policy', 'same-origin'],
    ['cross-origin-resource-policy', 'same-origin'],
    ['x-frame-options', 'DENY'],
  ]
  if (cacheControl !== undefined) fixed.push(['cache-control', cacheControl])
  return Object.freeze({
    csp,
    cspReportOnly: options.cspReportOnly === true,
    hsts,
    fixed: Object.freeze(fixed),
  })
}

function buildCsp(
  preset: HeaderPreset,
  extra: Readonly<Record<string, readonly string[]>>,
  where: HeaderEnvironment,
  problems: string[],
): Map<string, readonly string[]> {
  const directives = new Map<string, readonly string[]>(preset === 'api' ? API_CSP : PAGE_CSP)
  for (const [name, sources] of Object.entries(extra)) {
    if (!DIRECTIVE.test(name)) {
      problems.push(`securityHeaders csp: "${name}" is not a directive name.`)
      continue
    }
    if (!Array.isArray(sources)) {
      problems.push(`securityHeaders csp ${name}: the sources must be a list of strings.`)
      continue
    }
    for (const source of sources)
      if (typeof source !== 'string' || !SOURCE.test(source))
        problems.push(
          `securityHeaders csp ${name}: "${String(source)}" is not a CSP source (a ";", "," or space would inject another directive).`,
        )
    // Adding to 'none' replaces it: "'none' https://x" is invalid CSP.
    const current = (directives.get(name) ?? []).filter((source) => source !== "'none'")
    directives.set(name, [...current, ...sources])
  }
  if (preset === 'page' && where.environment === 'production')
    directives.set('upgrade-insecure-requests', [])
  return directives
}

function hstsValue(options: HeaderOptions['hsts'], problems: string[]): string | undefined {
  if (options === false) return undefined
  const maxAge = options?.maxAge ?? 31_536_000
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > MAX_HSTS_AGE) {
    problems.push(
      `securityHeaders hsts maxAge: must be a whole number of seconds from 0 to ${MAX_HSTS_AGE} (got ${String(maxAge)}).`,
    )
    return undefined
  }
  if (maxAge === 0) return undefined
  const subdomains = options?.includeSubDomains !== false
  const preload = options?.preload === true
  if (preload && (!subdomains || maxAge < 31_536_000))
    problems.push(
      'securityHeaders hsts preload: the preload list needs includeSubDomains and a maxAge of at least one year (31536000).',
    )
  return `max-age=${maxAge}${subdomains ? '; includeSubDomains' : ''}${preload ? '; preload' : ''}`
}

/**
 * A fresh, unguessable CSP nonce (128 random bits). One per response: a nonce that repeats is a
 * nonce an attacker can copy into injected markup.
 *
 * @example
 * const nonce = createCspNonce() // 'q3Zr…'
 */
export function createCspNonce(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * The CSP header value for one response.
 *
 * @example
 * cspValue(resolved.csp, 'abc…') // "default-src 'self'; script-src 'self' 'nonce-abc…'; …"
 */
export function cspValue(csp: ReadonlyMap<string, readonly string[]>, nonce: string): string {
  assertNonce(nonce)
  return [...csp]
    .map(([name, sources]) => [name, ...sources].join(' ').replaceAll('{nonce}', nonce))
    .join('; ')
}

/**
 * Add the security headers to a response's headers, keeping any the response set itself. HSTS
 * only when `secure` and in production. Throws a `TypeError` for a malformed nonce (a bug in the
 * caller: a nonce with `;` or `'` would inject into the policy).
 *
 * @example
 * applySecurityHeaders(response.headers, resolved, { nonce, secure: client.secure, environment: 'production' })
 */
export function applySecurityHeaders(
  headers: Headers,
  resolved: ResolvedHeaders,
  request: HeaderRequest,
): void {
  const setDefault = (name: string, value: string): void => {
    if (!headers.has(name)) headers.set(name, value)
  }
  for (const [name, value] of resolved.fixed) setDefault(name, value)
  if (
    resolved.csp !== undefined &&
    !headers.has('content-security-policy') &&
    !headers.has('content-security-policy-report-only')
  ) {
    headers.set(
      resolved.cspReportOnly ? 'content-security-policy-report-only' : 'content-security-policy',
      cspValue(resolved.csp, request.nonce),
    )
  }
  // HSTS over plain HTTP is ignored by browsers, and in development it would pin localhost to HTTPS.
  if (resolved.hsts !== undefined && request.secure && request.environment === 'production')
    setDefault('strict-transport-security', resolved.hsts)
}

/**
 * A short verdict on the CSP for `security:check`: `undefined` when strong, else why it's weak.
 *
 * @example
 * cspWeakness(resolved.csp) // "script-src allows 'unsafe-inline'"
 */
export function cspWeakness(
  csp: ReadonlyMap<string, readonly string[]> | undefined,
): string | undefined {
  if (csp === undefined) return 'CSP is turned off'
  const scripts = csp.get('script-src') ?? csp.get('default-src') ?? []
  for (const risky of ["'unsafe-inline'", "'unsafe-eval'", '*', 'http:', 'https:', 'data:'])
    if (scripts.includes(risky)) return `script-src allows ${risky}`
  return undefined
}

function assertNonce(nonce: string): void {
  if (!NONCE.test(nonce))
    throw new TypeError('A CSP nonce must be 16 to 128 base64 characters (use createCspNonce()).')
}
