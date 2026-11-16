/**
 * The app's security settings, collected (in `bootstrap/app.ts`, through `withMiddleware`) and
 * checked once at boot (ported from spike 12). Every protection is on by default; these settings
 * only *adjust* them (exceptions, allowlists, limits), and a setting that would weaken security in
 * a way that is never right (CORS `*` with credentials, a CSP source that injects a directive,
 * `*` as a trusted host or proxy) stops boot.
 *
 * Why one collector with per-area resolvers: each area (CSRF, proxies, hosts, CORS, headers, body
 * limits) validates its own options in its own module, but the developer gets *every* problem in
 * one `BootError` instead of fixing them one restart at a time.
 *
 * The areas reuse the framework's single implementations: CSRF options are `http/csrf.ts`'s
 * `CsrfOptions` (exception patterns match the full path, CONSISTENCY #18), trusted hosts are
 * `http/trusted-hosts.ts` (an untrusted Host is a 400, CONSISTENCY #20), trusted proxies are
 * `http/proxy.ts`'s one model.
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'
import { type CsrfOptions, type ResolvedCsrf, resolveCsrf } from '../http/csrf.ts'
import {
  parsePublicUrl,
  type ResolvedProxies,
  resolveTrustProxy,
  type TrustProxiesOptions,
  type TrustProxy,
} from '../http/proxy.ts'
import { type SessionCookie, sessionCookieName } from '../http/session-cookie.ts'
import { resolveTrustedHosts, type TrustedHosts } from '../http/trusted-hosts.ts'
import { CORS_OFF, type CorsOptions, type ResolvedCors, resolveCors } from './cors.ts'
import type { Keyring } from './keyring.ts'
import { type BodyLimitOptions, type BodyLimits, resolveLimits } from './safe-json.ts'
import { type HeaderOptions, type ResolvedHeaders, resolveHeaders } from './secure-headers.ts'
import { SecuritySettingError } from './setting-error.ts'

export type { BodyLimitOptions, CorsOptions, CsrfOptions, HeaderOptions, TrustProxiesOptions }

/**
 * Extra hosts the app answers for, on top of `localhost`, `127.0.0.1`, `[::1]` and the
 * `APP_URL` host.
 *
 * @example
 * const options: TrustHostsOptions = { at: ['example.com'], subdomains: true }
 */
export interface TrustHostsOptions {
  /** Host names, or `*.example.com` for any subdomain. Never `*` alone. */
  readonly at: readonly string[]
  /** Also allow every subdomain of each listed host. */
  readonly subdomains?: boolean
}

/**
 * Where the app runs, and what the settings need from boot.
 *
 * @example
 * const where: SecurityEnvironment = { appUrl: 'https://blog.example.com', environment: 'production', keyring }
 */
export interface SecurityEnvironment {
  /** `APP_URL`: its origin is trusted for CSRF, its host for Host checks. */
  readonly appUrl: string
  /** `APP_ENV`: some defaults depend on it (HSTS and `upgrade-insecure-requests` in production). */
  readonly environment: string
  /** The app's keyring (CSRF tokens derive from it). Without one, a per-process random key. */
  readonly keyring?: Keyring
  /** The session cookie, from the one source (CONSISTENCY #105). Default: from `APP_URL`'s scheme. */
  readonly sessionCookie?: SessionCookie
}

/**
 * Every security setting after validation, with defaults filled in. Bound in the container as
 * {@link SecurityToken} so the HTTP kernel reads one checked value.
 *
 * @example
 * app.make(SecurityToken).csrf.except // ['webhooks/*']
 */
export interface ResolvedSecurity {
  readonly csrf: ResolvedCsrf
  readonly proxies: ResolvedProxies
  readonly hosts: TrustedHosts
  readonly cors: ResolvedCors
  readonly headers: ResolvedHeaders
  readonly limits: BodyLimits
}

/**
 * The collector behind `withMiddleware`'s security methods. List settings merge (a package
 * provider and the app can both add CSRF exceptions); the others replace.
 *
 * @example
 * settings.csrf({ except: ['webhooks/*'] }).trustProxies({ at: ['10.0.0.0/8'] })
 * const security = settings.resolve({ appUrl: env.APP_URL, environment: env.APP_ENV, keyring })
 */
export class SecuritySettings {
  #csrfExcept: string[] = []
  #csrfOrigins: string[] = []
  #proxyList: string[] = []
  #proxyHeaders: TrustProxiesOptions['headers']
  #proxyHops: boolean | number | undefined
  #hosts: string[] = []
  #cors: CorsOptions | undefined
  #headers: HeaderOptions = {}
  #limits: BodyLimitOptions = {}

  /**
   * Add CSRF exceptions (full-path patterns, `*` matches anything) and trusted origins.
   *
   * @example
   * settings.csrf({ except: ['api/webhooks/*'], origins: ['https://admin.example.com'] })
   */
  csrf(options: CsrfOptions): this {
    this.#csrfExcept.push(...(options.except ?? []))
    this.#csrfOrigins.push(...(options.origins ?? []))
    return this
  }

  /**
   * Trust `X-Forwarded-*` headers only from these proxies: a list of addresses or CIDR ranges
   * (merged across calls; recommended), or a hop count (`true`/a number) for platforms whose
   * proxy addresses aren't known. Mixing the two is refused at boot.
   *
   * @example
   * settings.trustProxies({ at: ['10.0.0.0/8'] })
   * settings.trustProxies(1)
   */
  trustProxies(options: TrustProxiesOptions | TrustProxy): this {
    if (typeof options === 'boolean' || typeof options === 'number') this.#proxyHops = options
    else if (isTrustProxiesOptions(options)) {
      this.#proxyList.push(...options.at)
      if (options.headers !== undefined) this.#proxyHeaders = options.headers
    } else this.#proxyList.push(...options)
    return this
  }

  /**
   * Answer for more hosts than loopback and the `APP_URL` host (merged across calls).
   *
   * @example
   * settings.trustHosts({ at: ['example.com'], subdomains: true })
   */
  trustHosts(options: TrustHostsOptions): this {
    for (const host of options.at) {
      this.#hosts.push(host)
      if (options.subdomains === true && typeof host === 'string' && !host.startsWith('*.'))
        this.#hosts.push(`*.${host}`)
    }
    return this
  }

  /**
   * Turn CORS on for an allowlist of origins. Off by default.
   *
   * @example
   * settings.cors({ origins: ['https://app.example.com'], credentials: true })
   */
  cors(options: CorsOptions): this {
    this.#cors = options
    return this
  }

  /**
   * Adjust the security headers (extra CSP sources, HSTS, Permissions-Policy…).
   *
   * @example
   * settings.headers({ csp: { 'img-src': ['https://images.example.com'] } })
   */
  headers(options: HeaderOptions): this {
    this.#headers = { ...this.#headers, ...options }
    return this
  }

  /**
   * Adjust the request body limits (bytes, JSON depth, JSON keys).
   *
   * @example
   * settings.limits({ maxBytes: 5 * 1024 * 1024 })
   */
  limits(options: BodyLimitOptions): this {
    this.#limits = { ...this.#limits, ...options }
    return this
  }

  /**
   * Validate everything and fill in defaults. Throws one `BootError` (`insecure_configuration`)
   * listing every problem, so a misconfigured app never starts half-protected. A bad `APP_KEY`
   * keeps its own `invalid_app_key` error.
   *
   * @example
   * const security = settings.resolve({ appUrl: 'http://localhost:3000', environment: 'local' })
   */
  resolve(where: SecurityEnvironment): ResolvedSecurity {
    const problems: string[] = []
    const collect = <TValue>(resolve: () => TValue, fallback: TValue): TValue => {
      try {
        return resolve()
      } catch (error) {
        if (error instanceof SecuritySettingError) problems.push(...error.problems)
        // The framework's older resolvers report every problem as one TypeError, one per line.
        else if (error instanceof TypeError) problems.push(...error.message.split('\n'))
        else throw error
        return fallback
      }
    }
    const publicUrl = collect(() => {
      const url = parsePublicUrl(where.appUrl)
      if (url === undefined)
        throw new TypeError('appUrl: APP_URL is required (e.g. https://app.example.com).')
      return url
    }, undefined)
    const cookie = collect(
      () => where.sessionCookie ?? sessionCookieName({ secure: publicUrl?.protocol === 'https:' }),
      sessionCookieName({ secure: false }),
    )
    const csrf = collect<ResolvedCsrf | undefined>(
      () =>
        resolveCsrf(
          { except: this.#csrfExcept, origins: this.#csrfOrigins },
          { appKey: undefined, keyring: where.keyring, publicUrl, cookie },
        ),
      undefined,
    )
    const proxies = collect<ResolvedProxies | undefined>(() => {
      if (this.#proxyHops !== undefined && this.#proxyList.length > 0)
        throw new SecuritySettingError([
          'trustProxies: a hop count and a list of proxy addresses were both given; use one or the other (the list is safer).',
        ])
      return resolveTrustProxy(
        this.#proxyHops ?? {
          at: this.#proxyList,
          ...(this.#proxyHeaders !== undefined ? { headers: this.#proxyHeaders } : {}),
        },
      )
    }, undefined)
    const hosts = collect<TrustedHosts | undefined>(
      () => resolveTrustedHosts({ publicUrl, hosts: this.#hosts }),
      undefined,
    )
    const cors = collect(() => resolveCors(this.#cors), CORS_OFF)
    const headers = collect<ResolvedHeaders | undefined>(
      () => resolveHeaders(this.#headers, where),
      undefined,
    )
    const limits = resolveLimits(this.#limits)
    problems.push(...limits.problems)
    if (
      problems.length > 0 ||
      csrf === undefined ||
      proxies === undefined ||
      hosts === undefined ||
      headers === undefined
    ) {
      throw new BootError(
        'insecure_configuration',
        `The app can't start: ${problems.length} security ${problems.length === 1 ? 'setting is' : 'settings are'} unsafe or invalid.\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
        'Fix them where the app configures security (bootstrap/app.ts, withMiddleware). Each line says what is wrong and what is allowed.',
      )
    }
    return Object.freeze({ csrf, proxies, hosts, cors, headers, limits: limits.limits })
  }
}

function isTrustProxiesOptions(
  value: TrustProxiesOptions | readonly string[],
): value is TrustProxiesOptions {
  return !Array.isArray(value)
}

/**
 * The container token for the checked security settings, bound at boot.
 *
 * @example
 * app.make(SecurityToken).cors.enabled // false
 */
export const SecurityToken: Token<ResolvedSecurity> = token<ResolvedSecurity>('strutvane.security')
