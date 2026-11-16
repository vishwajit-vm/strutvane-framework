/**
 * CORS (ported from spike 12): off by default (same-origin apps don't need it), an exact
 * allowlist of origins when on, and never `*` with credentials, which is refused at boot.
 *
 * Why refuse instead of "fixing" it: the usual fix (reflect any `Origin` back) is exactly the
 * misconfiguration that lets every website read a signed-in user's API responses. An allowlist
 * must be written down.
 *
 * Two stages for the HTTP kernel:
 * 1. {@link corsPreflight} answers `OPTIONS` + `Access-Control-Request-Method` before routing. A
 *    refused preflight is a 204 *without* CORS headers: the browser then blocks the real request,
 *    and the response reveals nothing about the policy.
 * 2. {@link corsHeaders} decorates the real response (errors included) when the origin is allowed,
 *    and always adds `Vary: Origin` on CORS paths so a shared cache never serves one origin's
 *    answer to another. It never touches a preflight (the spike found that re-adding headers
 *    there undid a refusal).
 *
 * Paths match like CSRF exceptions: the full path as the router decodes it, `*` matching anything
 * (CONSISTENCY #18).
 *
 * @module
 */
import { exactOrigin, matchesPathPattern } from '../http/csrf.ts'
import { routerPath } from '../http/router-path.ts'
import { failIfAny } from './setting-error.ts'

/**
 * Options for `settings.cors({ … })`.
 *
 * @example
 * const options: CorsOptions = { origins: ['https://app.example.com'], credentials: true }
 */
export interface CorsOptions {
  /** Exact origins, or `['*']` for a public, credential-free API. */
  readonly origins: readonly string[]
  /** Path patterns CORS applies to (default `['api/*']`). */
  readonly paths?: readonly string[]
  /** Methods a cross-origin request may use (default GET, POST, PUT, PATCH, DELETE). */
  readonly methods?: readonly string[]
  /** Request headers the browser may send (default: the ones Strutvane clients use). */
  readonly headers?: readonly string[]
  /** Response headers scripts on the other origin may read. */
  readonly exposedHeaders?: readonly string[]
  /** Allow cookies and `Authorization` from the listed origins. */
  readonly credentials?: boolean
  /** How long a browser may cache a preflight, in seconds (default 600, at most 86400). */
  readonly maxAge?: number
}

/**
 * The checked CORS settings ({@link CORS_OFF} when CORS is not configured).
 *
 * @example
 * resolveCors({ origins: ['https://app.example.com'] }).enabled // true
 */
export interface ResolvedCors {
  readonly enabled: boolean
  readonly paths: readonly string[]
  readonly origins: readonly string[]
  readonly methods: readonly string[]
  readonly headers: readonly string[]
  readonly exposedHeaders: readonly string[]
  readonly credentials: boolean
  readonly maxAge: number
}

/**
 * CORS turned off: the default.
 *
 * @example
 * corsPreflight(request, CORS_OFF) // undefined
 */
export const CORS_OFF: ResolvedCors = Object.freeze({
  enabled: false,
  paths: [],
  origins: [],
  methods: [],
  headers: [],
  exposedHeaders: [],
  credentials: false,
  maxAge: 0,
})

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const DEFAULT_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'idempotency-key',
  'x-csrf-token',
  'x-xsrf-token',
  'x-requested-with',
]
/** An HTTP token (RFC 9110): what method and header names are made of. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i

/**
 * Validate CORS options. Off when `options` is `undefined`. Throws a `SecuritySettingError`
 * listing every problem (`*` with credentials, `*` mixed with origins, inexact origins, an empty
 * list, bad method or header names, an out-of-range `maxAge`).
 *
 * @example
 * resolveCors({ origins: ['*'], credentials: true }) // throws: never "*" with credentials
 */
export function resolveCors(options: CorsOptions | undefined): ResolvedCors {
  if (options === undefined) return CORS_OFF
  const problems: string[] = []
  const wildcard = options.origins.includes('*')
  const origins: string[] = []
  for (const origin of options.origins) {
    if (origin === '*') continue
    const exact = exactOrigin(origin)
    if (exact === undefined)
      problems.push(
        `cors origins: "${origin}" must be an exact origin such as https://app.example.com (never "null", no path).`,
      )
    else origins.push(exact)
  }
  if (wildcard && options.credentials === true)
    problems.push(
      'cors: origins "*" can\'t be combined with credentials: true. List the exact origins that may send cookies.',
    )
  if (wildcard && options.origins.length > 1)
    problems.push('cors: "*" and a list of origins together is ambiguous; use one or the other.')
  if (options.origins.length === 0)
    problems.push('cors: origins is empty; leave CORS off instead of enabling it for nobody.')
  const methods = (options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase())
  const headers = (options.headers ?? DEFAULT_HEADERS).map((header) => header.toLowerCase())
  const exposed = options.exposedHeaders ?? []
  for (const value of [...methods, ...headers, ...exposed])
    if (!TOKEN.test(value)) problems.push(`cors: "${value}" is not a valid method or header name.`)
  const paths = options.paths ?? ['api/*']
  for (const path of paths)
    if (path.trim() === '' || /\s/.test(path))
      problems.push(`cors paths: "${path}" is not a path pattern (use something like "api/*").`)
  const maxAge = options.maxAge ?? 600
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > 86_400)
    problems.push(`cors maxAge: must be 0 to 86400 seconds (got ${String(maxAge)}).`)
  failIfAny(problems)
  return Object.freeze({
    enabled: true,
    paths: paths.map((path) => path.replace(/^\/+/, '')),
    origins: wildcard ? ['*'] : [...new Set(origins)],
    methods,
    headers,
    exposedHeaders: [...exposed],
    credentials: options.credentials === true,
    maxAge,
  })
}

/** `true` when CORS is on for this request's path. */
function applies(cors: ResolvedCors, request: Request): boolean {
  if (!cors.enabled) return false
  const path = routerPath(request)
  return cors.paths.some((pattern) => matchesPathPattern(pattern, path))
}

function allowedOrigin(cors: ResolvedCors, origin: string | null): string | undefined {
  if (origin === null || origin === 'null') return undefined
  if (cors.origins.includes('*')) return '*'
  return cors.origins.includes(origin) ? origin : undefined
}

/**
 * Answer a CORS preflight (`OPTIONS` with `Access-Control-Request-Method`), or `undefined` when
 * the request isn't one for a CORS path (the kernel then routes it normally).
 *
 * @example
 * const preflight = corsPreflight(request, cors)
 * if (preflight) return preflight
 */
export function corsPreflight(request: Request, cors: ResolvedCors): Response | undefined {
  const requested = request.headers.get('access-control-request-method')
  if (request.method !== 'OPTIONS' || requested === null || !applies(cors, request))
    return undefined
  const headers = new Headers({
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  })
  const origin = allowedOrigin(cors, request.headers.get('origin'))
  const wanted = (request.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header !== '')
  if (
    origin !== undefined &&
    cors.methods.includes(requested.toUpperCase()) &&
    wanted.every((header) => cors.headers.includes(header))
  ) {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-methods', cors.methods.join(', '))
    headers.set('access-control-allow-headers', cors.headers.join(', '))
    headers.set('access-control-max-age', String(cors.maxAge))
    if (cors.credentials) headers.set('access-control-allow-credentials', 'true')
  }
  return new Response(null, { status: 204, headers })
}

/**
 * Add CORS headers to an actual response when the origin is allowed. `Vary: Origin` is added for
 * every CORS path, allowed or not.
 *
 * @example
 * corsHeaders(request, cors, response.headers)
 */
export function corsHeaders(request: Request, cors: ResolvedCors, headers: Headers): void {
  if (!applies(cors, request)) return
  // A preflight was answered (or refused) by corsPreflight(); adding headers here would undo a refusal.
  if (request.method === 'OPTIONS' && request.headers.has('access-control-request-method')) return
  headers.append('vary', 'Origin')
  const origin = allowedOrigin(cors, request.headers.get('origin'))
  if (origin === undefined) return
  headers.set('access-control-allow-origin', origin)
  if (cors.credentials) headers.set('access-control-allow-credentials', 'true')
  if (cors.exposedHeaders.length > 0)
    headers.set('access-control-expose-headers', cors.exposedHeaders.join(', '))
}
