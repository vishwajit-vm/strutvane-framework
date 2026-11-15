/**
 * Trusted hosts: a request whose `Host` (or, behind a trusted proxy, `X-Forwarded-Host`) is not
 * on the allowlist gets a 400 `untrusted_host` problem before any app code runs (CONSISTENCY #20,
 * Laravel and Symfony behaviour). Ported from spike 12, and on in **every** environment.
 *
 * Why it is never off, not even in local development: DNS rebinding. A web page the developer
 * visits points its own host name at `127.0.0.1` and then talks to the dev API (and the Vite dev
 * server behind it) as a same-origin page, reading data and posting writes with no CSRF or CORS
 * check standing in the way, because to the browser it *is* that origin. The request still says
 * `Host: attacker.example`, so refusing unknown hosts closes the hole. In production the same
 * check stops host-header poisoning of anything built from the request's host (links, redirects,
 * cache keys).
 *
 * The allowlist is always: `localhost`, `127.0.0.1`, `[::1]` (health checks and local tools), the
 * `APP_URL` host, and the hosts the app configures (`config/app.ts` `trustedHosts`: exact names,
 * or `*.example.com` for any subdomain).
 *
 * @module
 */
import type { Context, MiddlewareHandler } from 'hono'
import { StrutvaneError } from '../core/index.ts'

/** The problem code of a refused host (CONSISTENCY #20: status 400). */
export const UNTRUSTED_HOST_CODE = 'untrusted_host'

/** Hosts every app answers for. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['localhost', '127.0.0.1', '[::1]'])

/** A host name, `*.domain`, or a bracketed IPv6 literal (lowercase, no port). */
const HOST_PATTERN =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\[[0-9a-f:.]+\]$/

/** The checked allowlist. */
export interface TrustedHosts {
  /** Exact names and `*.domain` patterns, lowercase. */
  readonly patterns: readonly string[]
}

/**
 * Build the allowlist: loopback names, the public URL's host, and the configured entries.
 * Throws a `TypeError` naming every entry that is not a host name or `*.domain` pattern (a lone
 * `*` would trust every host, so it is refused).
 *
 * @example
 * resolveTrustedHosts({ publicUrl: new URL('https://app.example.com'), hosts: ['*.example.com'] })
 */
export function resolveTrustedHosts(options: {
  readonly publicUrl?: URL | undefined
  readonly hosts?: readonly string[] | undefined
}): TrustedHosts {
  const problems: string[] = []
  const patterns = [...LOOPBACK_HOSTS]
  if (options.publicUrl) patterns.push(options.publicUrl.hostname.toLowerCase())
  for (const entry of options.hosts ?? []) {
    const host = typeof entry === 'string' ? entry.trim().toLowerCase().replace(/\.$/, '') : ''
    if (!HOST_PATTERN.test(host))
      problems.push(
        `trustedHosts: "${String(entry)}" is not a host name or "*.domain" pattern (no port, no scheme; "*" alone would trust every host)`,
      )
    else patterns.push(host)
  }
  if (problems.length > 0) throw new TypeError(problems.join('\n'))
  return Object.freeze({ patterns: [...new Set(patterns)] })
}

/**
 * The host name in a `Host`-style value (`Example.com:8080` → `example.com`, `[::1]:3000` →
 * `[::1]`), or `undefined` when it is not a valid authority (userinfo, a path, garbage).
 *
 * @example
 * hostName('API.example.com:443') // 'api.example.com'
 */
export function hostName(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || /[\s/\\?#@]/.test(trimmed)) return undefined
  if (!URL.canParse(`http://${trimmed}`)) return undefined
  return new URL(`http://${trimmed}`).hostname.toLowerCase().replace(/\.$/, '')
}

/**
 * `true` when `host` (a bare host name) is on the allowlist. `*.example.com` matches
 * `a.example.com` and `a.b.example.com`, never `example.com` itself or `evilexample.com`.
 *
 * @example
 * isTrustedHost('api.example.com', { patterns: ['*.example.com'] }) // true
 */
export function isTrustedHost(host: string, hosts: TrustedHosts): boolean {
  return hosts.patterns.some((pattern) =>
    pattern.startsWith('*.')
      ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
      : host === pattern,
  )
}

/**
 * The middleware. `forwarded` says whether `X-Forwarded-Host` comes from a trusted proxy; when it
 * does, that host is checked too (it is what links and redirects would be built from).
 *
 * @example
 * http.use('*', trustedHostsGuard(resolveTrustedHosts({ publicUrl }), () => hops > 0))
 */
export function trustedHostsGuard(
  hosts: TrustedHosts,
  forwarded: (c: Context) => boolean,
): MiddlewareHandler {
  return async (c, next) => {
    const candidates = [c.req.header('host') ?? new URL(c.req.url).host]
    const viaProxy = forwarded(c) ? c.req.header('x-forwarded-host') : undefined
    if (viaProxy !== undefined) candidates.push(viaProxy.split(',').pop() ?? '')
    for (const candidate of candidates) {
      const name = hostName(candidate)
      if (name === undefined || !isTrustedHost(name, hosts))
        throw new StrutvaneError(UNTRUSTED_HOST_CODE, { status: 400 })
    }
    await next()
  }
}
