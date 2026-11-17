/**
 * The `throttle` middleware: `throttle:60,1` (60 requests per minute) or `throttle:api` (a named
 * limiter: `api`, `login`, `password-reset`, `aggregate`, or one the app defines, CONSISTENCY #21).
 *
 * - **Keys:** the signed-in user's id, else the client IP, with IPv6 clients bucketed per /64
 *   (they usually control a whole /64, so keying on the full address lets them rotate past any
 *   limit). A limiter's own `by()` replaces that.
 * - **Store:** the app's cache (`CacheManagerToken`'s default store), so limits hold across
 *   processes when the cache is shared; a small in-memory store when no cache is bound.
 * - **Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `Retry-After` on the 429.
 *
 * Runs after `auth` (middleware priority), so a signed-in user gets their own bucket.
 *
 * @module
 */
import type { CacheStore } from '../../cache/contract.ts'
import { type Token, token } from '../../core/container.ts'
import { StrutvaneError } from '../../core/errors/errors.ts'
import { BootError } from '../../foundation/boot-error.ts'
import { parseIp } from '../../security/ip.ts'
import { closestMatch } from '../../support/str.ts'
import type { HttpContext } from './context.ts'
import {
  type LimiterDefinition,
  type Middleware,
  type MiddlewareConfig,
  MiddlewareConfigToken,
  type Next,
} from './middleware.ts'

/**
 * The container token for the store the rate limiter counts in, bound at boot.
 *
 * @example
 * app.container.value(RateLimitStoreToken, new MemoryCacheStore({ clock }))
 */
export const RateLimitStoreToken: Token<CacheStore> = token<CacheStore>(
  'strutvane.http.rateLimitStore',
)

/**
 * Which limiter a `throttle` reference uses: numbers (`'60', '1'`) or a name. Throws a
 * `BootError` with a "did you mean" for an unknown name, so a typo fails at boot.
 *
 * @example
 * resolveLimiter(['api'], config) // { name: 'api', definition: { maxAttempts: 60, decaySeconds: 60 } }
 */
export function resolveLimiter(
  params: readonly string[],
  config: MiddlewareConfig,
): { readonly name: string; readonly definition: LimiterDefinition } {
  const [first, second] = params
  if (first !== undefined && /^\d+$/.test(first)) {
    const minutes = second === undefined ? 1 : Number(second)
    const maxAttempts = Number(first)
    if (
      !Number.isSafeInteger(minutes) ||
      minutes < 1 ||
      maxAttempts < 1 ||
      !/^\d*$/.test(second ?? '')
    )
      throw new BootError(
        'invalid_throttle',
        `throttle:${params.join(',')} is not a valid limit.`,
        'Write throttle:<attempts>,<minutes> with whole numbers of at least 1 (throttle:60,1), or a limiter name (throttle:api).',
      )
    return { name: `${first},${minutes}`, definition: { maxAttempts, decaySeconds: minutes * 60 } }
  }
  const name = first ?? 'api'
  const definition = config.limiter(name)
  if (definition !== undefined) return { name, definition }
  const suggestion = closestMatch(name, config.limiterNames)
  throw new BootError(
    'unknown_rate_limiter',
    `No rate limiter is called "${name}".`,
    suggestion === undefined
      ? `Define it in bootstrap/app.ts: withMiddleware((m) => m.rateLimiter('${name}', { maxAttempts: 60, decaySeconds: 60 })), or use numbers: throttle:60,1.`
      : `Did you mean "${suggestion}"?`,
  )
}

/**
 * The `throttle` middleware class.
 *
 * @example
 * Route.post('/login', [LoginController, 'store']).middleware('throttle:login')
 */
export class ThrottleRequests implements Middleware {
  static readonly inject: readonly [typeof MiddlewareConfigToken, typeof RateLimitStoreToken] = [
    MiddlewareConfigToken,
    RateLimitStoreToken,
  ] as const
  readonly #config: MiddlewareConfig
  readonly #store: CacheStore

  constructor(config: MiddlewareConfig, store: CacheStore) {
    this.#config = config
    this.#store = store
  }

  async handle(ctx: HttpContext, next: Next, ...params: string[]): Promise<Response> {
    const { name, definition } = resolveLimiter(params, this.#config)
    const bucket = `throttle:${name}:${definition.by?.(ctx) ?? defaultKey(ctx)}`
    const count = await this.#store.increment(bucket, 1, definition.decaySeconds)
    const remaining = Math.max(0, definition.maxAttempts - count)
    const headers = {
      'X-RateLimit-Limit': String(definition.maxAttempts),
      'X-RateLimit-Remaining': String(remaining),
    }
    if (count > definition.maxAttempts) {
      const retryAfter = Math.max(1, (await this.#store.ttl(bucket)) ?? definition.decaySeconds)
      throw new StrutvaneError('rate_limited', {
        status: 429,
        headers: { ...headers, 'Retry-After': String(retryAfter) },
      })
    }
    const response = await next()
    // Copy before setting headers: responses built by `Response.json()` etc. can be immutable.
    const withHeaders = new Response(response.body, response)
    for (const [key, value] of Object.entries(headers)) withHeaders.headers.set(key, value)
    return withHeaders
  }
}

/** Signed-in users get their own bucket; guests share one per IP (or IPv6 /64). */
function defaultKey(ctx: HttpContext): string {
  const user = ctx.user as { readonly id?: unknown } | null
  if (user !== null && (typeof user.id === 'string' || typeof user.id === 'number'))
    return `user:${String(user.id)}`
  return `ip:${ipBucket(ctx.ip)}`
}

/**
 * The rate-limit bucket for an address. IPv6 clients usually control a whole /64, so keying on
 * the full address would let them rotate past any limit.
 *
 * @example
 * ipBucket('2001:db8:1:2:3:4:5:6') // '2001:db8:1:2::/64'
 * ipBucket('203.0.113.7')          // '203.0.113.7'
 */
export function ipBucket(ip: string): string {
  const parsed = parseIp(ip)
  if (parsed === undefined || parsed.version === 4) return ip
  if (parsed.value >> 32n === 0xffffn) {
    // An IPv4-mapped address is the IPv4 client it maps.
    const v4 = parsed.value & 0xffffffffn
    return [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 0xffn)).join('.')
  }
  const groups: string[] = []
  for (let shift = 112n; shift >= 64n; shift -= 16n)
    groups.push(((parsed.value >> shift) & 0xffffn).toString(16))
  return `${groups.join(':')}::/64`
}
