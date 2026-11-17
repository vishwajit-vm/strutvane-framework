/**
 * Middleware: classes with a `handle(ctx, next, ...params)` method, referred to by alias strings
 * exactly like Laravel (`'auth'`, `'throttle:60,1'`, `'can:view-stats'`), grouped into `web` and
 * `api`, plus the app-wide security settings collected by `withMiddleware((m) => …)`.
 *
 * Every alias is resolved when the app boots, not when the first request arrives, so a typo like
 * `'auht'` fails `node strut route:list` and the test suite instead of production traffic.
 *
 * @module
 */

import type { Resolver } from '../../core/container.ts'
import { type Token, token } from '../../core/container.ts'
import { BootError } from '../../foundation/boot-error.ts'
import { buildUnchecked, type Injectable } from '../../foundation/inject.ts'
import type { AuthUser } from '../../foundation/registry.ts'
import {
  type BodyLimitOptions,
  type CorsOptions,
  type CsrfOptions,
  type HeaderOptions,
  SecuritySettings,
  type TrustHostsOptions,
  type TrustProxiesOptions,
} from '../../security/settings.ts'
import { closestMatch } from '../../support/str.ts'
import type { TrustProxy } from '../proxy.ts'
import { assertRequestTimeout, DEFAULT_REQUEST_TIMEOUT_MS } from '../request-timeout.ts'
import type { HttpContext } from './context.ts'

/**
 * Call the rest of the pipeline (the next middleware, and finally the controller).
 *
 * @example
 * const response = await next()
 */
export type Next = () => Promise<Response>

/**
 * A middleware instance. `params` are the strings after the colon: `'throttle:60,1'` → `['60', '1']`.
 * An optional `terminate()` runs after the response is sent (Laravel's terminable middleware);
 * its errors are logged, never sent.
 *
 * @example
 * class EnsureJson implements Middleware {
 *   async handle(ctx: HttpContext, next: Next): Promise<Response> {
 *     return ctx.wantsJson() ? next() : ctx.json({ error: 'JSON only' }, 406)
 *   }
 * }
 */
export interface Middleware {
  handle(ctx: HttpContext, next: Next, ...params: string[]): Promise<Response>
  terminate?(ctx: HttpContext, response: Response): void | Promise<void>
}

/**
 * A middleware class the container can build (a fresh instance per request).
 *
 * @example
 * const alias: MiddlewareClass = EnsureJson
 */
export type MiddlewareClass = Injectable<Middleware>

/**
 * Build a middleware instance through the container (so its `static inject` list is honoured)
 * and check it really has a `handle` method, instead of trusting a cast.
 *
 * @example
 * const middleware = buildMiddleware(app.container, VerifyCsrfToken)
 */
export function buildMiddleware(container: Resolver, middlewareClass: MiddlewareClass): Middleware {
  const instance = buildUnchecked(container, middlewareClass)
  if (isMiddleware(instance)) return instance
  throw new BootError(
    'not_middleware',
    `${middlewareClass.name} has no handle(ctx, next) method.`,
    'A middleware class needs: async handle(ctx: HttpContext, next: Next): Promise<Response>.',
  )
}

function isMiddleware(value: unknown): value is Middleware {
  return (
    typeof value === 'object' &&
    value !== null &&
    'handle' in value &&
    typeof value.handle === 'function'
  )
}

/**
 * A rate limiter definition, Laravel's `RateLimiter::for('api', …)`.
 *
 * @example
 * const api: LimiterDefinition = { maxAttempts: 60, decaySeconds: 60 }
 */
export interface LimiterDefinition {
  readonly maxAttempts: number
  readonly decaySeconds: number
  /** The bucket key. Defaults to the user id, then the client IP (IPv6 by /64). */
  readonly by?: (ctx: HttpContext) => string
}

/**
 * The named limiters every app has (CONSISTENCY #21). Apps redefine them with
 * `m.rateLimiter(name, …)`.
 *
 * - `api`: 60 requests a minute per user, else per IP (the `api` group uses it).
 * - `login`: 5 attempts a minute per IP, for sign-in forms.
 * - `password-reset`: 3 requests per 15 minutes per IP, for reset links.
 * - `aggregate`: 1,000 requests a minute shared by *every* client: a circuit breaker for routes a
 *   distributed attack would hammer from many addresses.
 *
 * @example
 * DEFAULT_LIMITERS.login.maxAttempts // 5
 */
export const DEFAULT_LIMITERS: Readonly<Record<string, LimiterDefinition>> = Object.freeze({
  api: { maxAttempts: 60, decaySeconds: 60 },
  login: { maxAttempts: 5, decaySeconds: 60, by: (ctx: HttpContext) => `ip:${ctx.ip}` },
  'password-reset': {
    maxAttempts: 3,
    decaySeconds: 15 * 60,
    by: (ctx: HttpContext) => `ip:${ctx.ip}`,
  },
  aggregate: { maxAttempts: 1000, decaySeconds: 60, by: () => 'all' },
})

/**
 * A named ability for the `can:<ability>` middleware, Laravel's `Gate::define()`. Only a literal
 * `true` allows; anything else denies (deny by default).
 *
 * @example
 * const viewStats: AbilityCheck = (user) => user !== null && hasAdminRole(user)
 */
export type AbilityCheck = (user: AuthUser | null, ctx: HttpContext) => boolean | Promise<boolean>

/**
 * A parsed middleware reference: `'throttle:60,1'` → `{ alias: 'throttle', params: ['60', '1'] }`.
 *
 * @example
 * parseMiddleware('throttle:60,1')
 */
export interface MiddlewareReference {
  readonly alias: string
  readonly params: readonly string[]
}

/**
 * Split an alias string into its name and parameters.
 *
 * @example
 * parseMiddleware('auth')          // { alias: 'auth', params: [] }
 * parseMiddleware('throttle:60,1') // { alias: 'throttle', params: ['60', '1'] }
 */
export function parseMiddleware(reference: string): MiddlewareReference {
  const colon = reference.indexOf(':')
  if (colon === -1) return { alias: reference, params: [] }
  return { alias: reference.slice(0, colon), params: reference.slice(colon + 1).split(',') }
}

/**
 * The reference string for an alias and parameters: `('throttle', ['10', '1'])` → `'throttle:10,1'`.
 *
 * @example
 * referenceFor('can', ['view-stats']) // 'can:view-stats'
 */
export function referenceFor(alias: string, params: readonly string[]): string {
  return params.length === 0 ? alias : `${alias}:${params.join(',')}`
}

/**
 * The object handed to `withMiddleware((m) => …)` in `bootstrap/app.ts`: aliases, groups,
 * limiters, abilities and the app-wide security settings.
 *
 * @example
 * .withMiddleware((m) => {
 *   m.alias({ admin: EnsureAdmin })
 *   m.validateCsrfTokens({ except: ['webhooks/*'] }).trustProxies({ at: ['10.0.0.0/8'] })
 *   m.rateLimiter('api', { maxAttempts: 120, decaySeconds: 60 })
 * })
 */
export class MiddlewareConfig {
  readonly #aliases = new Map<string, MiddlewareClass>()
  readonly #groups = new Map<string, string[]>([
    ['web', []],
    ['api', []],
  ])
  readonly #limiters = new Map<string, LimiterDefinition>(Object.entries(DEFAULT_LIMITERS))
  readonly #abilities = new Map<string, AbilityCheck>()
  #timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  /** CSRF exceptions, trusted proxies and hosts, CORS, headers and body limits. */
  readonly security: SecuritySettings = new SecuritySettings()

  /**
   * App-wide CSRF exceptions and extra trusted origins, Laravel 11's `validateCsrfTokens()`.
   * Patterns match the **full path** without the leading slash (`api/webhooks/*`); `*` matches
   * anything. A pattern that matches no route logs a warning at boot (CONSISTENCY #18).
   *
   * @example
   * m.validateCsrfTokens({ except: ['api/webhooks/*'] })
   */
  validateCsrfTokens(options: CsrfOptions): this {
    this.security.csrf(options)
    return this
  }

  /**
   * Believe `X-Forwarded-For/-Proto/-Host` only from these proxies, Laravel's `trustProxies()`.
   *
   * @example
   * m.trustProxies({ at: ['10.0.0.0/8'] })
   */
  trustProxies(options: TrustProxiesOptions | TrustProxy): this {
    this.security.trustProxies(options)
    return this
  }

  /**
   * Answer for more hosts than loopback and the `APP_URL` host, Laravel's `trustHosts()`.
   *
   * @example
   * m.trustHosts({ at: ['blog.example.com'], subdomains: true })
   */
  trustHosts(options: TrustHostsOptions): this {
    this.security.trustHosts(options)
    return this
  }

  /**
   * Turn CORS on for exact origins (off by default; `*` with credentials is refused at boot).
   *
   * @example
   * m.cors({ origins: ['https://app.example.com'], credentials: true })
   */
  cors(options: CorsOptions): this {
    this.security.cors(options)
    return this
  }

  /**
   * Adjust the security headers (CSP sources, HSTS, Permissions-Policy, Referrer-Policy).
   *
   * @example
   * m.securityHeaders({ csp: { 'img-src': ['https://images.example.com'] } })
   */
  securityHeaders(options: HeaderOptions): this {
    this.security.headers(options)
    return this
  }

  /**
   * Adjust request body limits (bytes, JSON depth, total JSON keys).
   *
   * @example
   * m.limits({ maxBytes: 5 * 1024 * 1024 })
   */
  limits(options: BodyLimitOptions): this {
    this.security.limits(options)
    return this
  }

  /**
   * The longest time (ms) a request may take before the client gets a 503 (`0` turns it off).
   * Default 30 s.
   *
   * @example
   * m.requestTimeout(10_000)
   */
  requestTimeout(ms: number): this {
    assertRequestTimeout(ms)
    this.#timeoutMs = ms
    return this
  }

  /**
   * The request timeout in milliseconds.
   *
   * @example
   * m.timeoutMs // 30000
   */
  get timeoutMs(): number {
    return this.#timeoutMs
  }

  /**
   * Define a named ability for `can:<name>`. Only a literal `true` from the check allows.
   *
   * @example
   * m.defineAbility('view-stats', (user) => hasAdminRole(user))
   */
  defineAbility(name: string, check: AbilityCheck): this {
    if (typeof check !== 'function')
      throw new BootError(
        'invalid_ability',
        `defineAbility('${name}') needs a check function.`,
        'Pass (user, ctx) => boolean.',
      )
    this.#abilities.set(name, check)
    return this
  }

  /**
   * A named ability, if defined.
   *
   * @example
   * m.ability('view-stats')
   */
  ability(name: string): AbilityCheck | undefined {
    return this.#abilities.get(name)
  }

  /**
   * Every ability name, for boot errors.
   *
   * @example
   * m.abilityNames // ['view-stats']
   */
  get abilityNames(): readonly string[] {
    return [...this.#abilities.keys()]
  }

  /**
   * Name middleware classes so routes can refer to them by string.
   *
   * @example
   * m.alias({ admin: EnsureAdmin })
   */
  alias(aliases: Readonly<Record<string, MiddlewareClass>>): this {
    for (const [name, middleware] of Object.entries(aliases)) {
      if (!/^[a-z][a-z0-9._-]*$/i.test(name) || typeof middleware !== 'function')
        throw new BootError(
          'invalid_middleware_alias',
          `"${name}" can't be a middleware alias for ${String(middleware)}.`,
          'Use a simple name (letters, digits, dots, dashes) and a middleware class.',
        )
      this.#aliases.set(name, middleware)
    }
    return this
  }

  /**
   * Add middleware to the end of a group (`web` or `api`, or a new one).
   *
   * @example
   * m.appendToGroup('api', 'throttle:aggregate')
   */
  appendToGroup(group: string, ...references: string[]): this {
    this.#groups.set(group, [...(this.#groups.get(group) ?? []), ...references])
    return this
  }

  /**
   * Add middleware to the start of a group.
   *
   * @example
   * m.prependToGroup('web', 'admin')
   */
  prependToGroup(group: string, ...references: string[]): this {
    this.#groups.set(group, [...references, ...(this.#groups.get(group) ?? [])])
    return this
  }

  /**
   * Define (or redefine) a named rate limiter for `throttle:<name>`.
   *
   * @example
   * m.rateLimiter('uploads', { maxAttempts: 10, decaySeconds: 60, by: (ctx) => ctx.ip })
   */
  rateLimiter(name: string, definition: LimiterDefinition): this {
    if (
      !Number.isSafeInteger(definition.maxAttempts) ||
      definition.maxAttempts < 1 ||
      !Number.isSafeInteger(definition.decaySeconds) ||
      definition.decaySeconds < 1
    )
      throw new BootError(
        'invalid_rate_limiter',
        `The rate limiter "${name}" needs whole numbers of at least 1 for maxAttempts and decaySeconds.`,
        "For example m.rateLimiter('api', { maxAttempts: 60, decaySeconds: 60 }).",
      )
    this.#limiters.set(name, definition)
    return this
  }

  /**
   * The class behind an alias, if any.
   *
   * @example
   * m.resolveAlias('csrf') // VerifyCsrfToken
   */
  resolveAlias(alias: string): MiddlewareClass | undefined {
    return this.#aliases.get(alias)
  }

  /**
   * The references in a group (empty for unknown groups).
   *
   * @example
   * m.group('api') // ['csrf', 'throttle:api']
   */
  group(name: string): readonly string[] {
    return this.#groups.get(name) ?? []
  }

  /**
   * `true` if `name` is a middleware group.
   *
   * @example
   * m.isGroup('web') // true
   */
  isGroup(name: string): boolean {
    return this.#groups.has(name)
  }

  /**
   * A named limiter.
   *
   * @example
   * m.limiter('api')?.maxAttempts // 60
   */
  limiter(name: string): LimiterDefinition | undefined {
    return this.#limiters.get(name)
  }

  /**
   * Every limiter name, for boot errors.
   *
   * @example
   * m.limiterNames // ['api', 'login', 'password-reset', 'aggregate']
   */
  get limiterNames(): readonly string[] {
    return [...this.#limiters.keys()]
  }

  /**
   * Every alias, for `about` and error hints.
   *
   * @example
   * m.aliasNames // ['auth', 'csrf', …]
   */
  get aliasNames(): readonly string[] {
    return [...this.#aliases.keys()]
  }

  /**
   * Expand groups and check aliases, keeping the listed order (no priority sort, no dedupe).
   * Throws a `BootError` with a "did you mean" for an unknown alias.
   *
   * @example
   * m.expandGroups(['web'], 'GET /') // [{ alias: 'csrf', params: [] }]
   */
  expandGroups(
    references: readonly string[],
    where: string,
    seen: readonly string[] = [],
  ): MiddlewareReference[] {
    const expanded: MiddlewareReference[] = []
    for (const reference of references) {
      if (this.isGroup(reference)) {
        if (seen.includes(reference))
          throw new BootError(
            'middleware_group_cycle',
            `The middleware group "${reference}" includes itself (${[...seen, reference].join(' → ')}).`,
            'Remove the group from its own members.',
          )
        expanded.push(
          ...this.expandGroups(this.group(reference), `the "${reference}" group`, [
            ...seen,
            reference,
          ]),
        )
        continue
      }
      const parsed = parseMiddleware(reference)
      if (this.#aliases.has(parsed.alias)) {
        expanded.push(parsed)
        continue
      }
      throw this.unknownAlias(parsed.alias, where)
    }
    return expanded
  }

  /**
   * The friendly error for an alias nobody registered, with a "did you mean".
   *
   * @example
   * throw m.unknownAlias('auht', 'GET /api/x')
   */
  unknownAlias(alias: string, where: string): BootError {
    const suggestion = closestMatch(alias, this.aliasNames)
    return new BootError(
      'unknown_middleware',
      `No middleware is called "${alias}" (used by ${where}).`,
      suggestion === undefined
        ? `Register it in bootstrap/app.ts: withMiddleware((m) => m.alias({ ${alias}: YourMiddleware })). Known: ${this.aliasNames.join(', ')}.`
        : `Did you mean "${suggestion}"?`,
    )
  }
}

/**
 * Laravel's `$middlewarePriority`: whatever order routes and groups list them in, these run in
 * this order. It matters because the `api` group lists `throttle` before a route's `auth`, yet
 * throttling must see the signed-in user to give them their own bucket. `signed` runs before
 * `auth` (a bad link is a 403 whoever you are), `can` needs the user, and `idempotent` runs last
 * so a replayed response is scoped to the user and never skips the checks before it.
 *
 * @example
 * MIDDLEWARE_PRIORITY[0] // 'csrf'
 */
export const MIDDLEWARE_PRIORITY: readonly string[] = Object.freeze([
  'csrf',
  'signed',
  'auth',
  'can',
  'throttle',
  'idempotent',
])

/**
 * Reorder only the priority middleware among themselves, leaving every other entry in place.
 *
 * @example
 * sortByPriority([throttle, custom, auth]) // [auth, custom, throttle]
 */
export function sortByPriority(references: readonly MiddlewareReference[]): MiddlewareReference[] {
  const slots = references.flatMap((reference, index) =>
    MIDDLEWARE_PRIORITY.includes(reference.alias) ? [index] : [],
  )
  const ordered = slots
    .map((index) => references[index])
    .filter((reference): reference is MiddlewareReference => reference !== undefined)
    .sort((a, b) => MIDDLEWARE_PRIORITY.indexOf(a.alias) - MIDDLEWARE_PRIORITY.indexOf(b.alias))
  const result = [...references]
  slots.forEach((slot, position) => {
    const reference = ordered[position]
    if (reference !== undefined) result[slot] = reference
  })
  return result
}

/**
 * The app's middleware configuration, bound at boot so middleware like `throttle` and `can` can
 * read named limiters and abilities.
 *
 * @example
 * app.make(MiddlewareConfigToken).limiter('api')
 */
export const MiddlewareConfigToken: Token<MiddlewareConfig> = token<MiddlewareConfig>(
  'strutvane.http.middleware',
)
