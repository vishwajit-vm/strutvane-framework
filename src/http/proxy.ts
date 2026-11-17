/**
 * Reverse-proxy awareness: which client address, protocol and host a request really came from.
 *
 * `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are ordinary request headers, so
 * any client can send them (spoofing its IP past rate limits, or claiming HTTPS to get
 * secure-only behaviour). They are only meaningful when a proxy *you run* sets them, which is why
 * nothing here reads them unless the app says which proxies it trusts (`trustProxy`). Without
 * that setting the client address is the TCP peer and the protocol is whatever the socket spoke.
 *
 * One model, two ways to say who the proxies are (spike 12 merged into the framework's hops):
 *
 * - **A list of addresses or CIDR ranges** (`['10.0.0.0/8', '192.168.1.10']`, recommended): the
 *   headers are believed only when the socket peer is in the list, and the client address is
 *   found by walking `X-Forwarded-For` from the right, skipping trusted proxies. The left-most
 *   entries are written by the client and prove nothing. Any malformed entry makes the whole
 *   header untrustworthy (the peer is used): guessing around garbage is how spoofing gets in.
 * - **A hop count** (`true` = one, a number = that many; Express's rule): for platforms whose
 *   proxy addresses aren't known in advance. Every trusted proxy appends the address it received
 *   the request from, so with `trustProxy: 1` the last entry is the client, with `2` the second to
 *   last, and so on. This trusts the nearest hops *by position*, so it is only safe when the app
 *   can't be reached except through those proxies. A malformed selected entry yields `undefined`,
 *   never a guess, so callers keyed by address (rate limits, allowlists) fail closed.
 *
 * There is no "trust everyone" value on purpose (`'*'` is refused).
 *
 * @module
 */
import { isIP } from 'node:net'
import { type Cidr, canonicalIp, inCidr, parseCidr, parseIp } from '../security/ip.ts'
import { failIfAny } from '../security/setting-error.ts'

/**
 * Which reverse proxies to trust: `false`/`0` (default) trusts none; a list of proxy addresses or
 * CIDR ranges trusts exactly those peers (recommended); `true` means one hop (a single load
 * balancer or ingress), a number means that many chained proxies.
 *
 * @example
 * const trust: TrustProxy = ['10.0.0.0/8']
 */
export type TrustProxy = boolean | number | readonly string[]

/**
 * The forwarded headers a trusted proxy may set.
 *
 * @example
 * const header: ForwardedHeader = 'proto'
 */
export type ForwardedHeader = 'for' | 'proto' | 'host'

/**
 * The long form of a proxy list: the addresses plus which `X-Forwarded-*` headers to read.
 *
 * @example
 * const options: TrustProxiesOptions = { at: ['10.0.0.0/8', '192.168.1.10'], headers: ['for', 'proto'] }
 */
export interface TrustProxiesOptions {
  /** Proxy addresses or CIDR ranges. There is no "trust everyone" value on purpose. */
  readonly at: readonly string[]
  /** Which `X-Forwarded-*` headers to read. Default: all three. */
  readonly headers?: readonly ForwardedHeader[]
}

/**
 * The checked proxy settings {@link forwardedClient} works from. `hops > 0` is the hop-count
 * model; otherwise `ranges` lists the trusted peers (empty: trust nobody).
 *
 * @example
 * const none: ResolvedProxies = { hops: 0, ranges: [], headers: ['for', 'proto', 'host'] }
 */
export interface ResolvedProxies {
  readonly hops: number
  readonly ranges: readonly Cidr[]
  readonly headers: readonly ForwardedHeader[]
}

const ALL_FORWARDED: readonly ForwardedHeader[] = Object.freeze(['for', 'proto', 'host'])

/**
 * Validate a `trustProxy` setting (any form). Throws a `SecuritySettingError` listing every bad
 * entry: `'*'`, a malformed address or range, an impossible hop count, an unknown header.
 *
 * @example
 * resolveTrustProxy(['10.0.0.0/8']) // { hops: 0, ranges: [10.0.0.0/8], headers: ['for', 'proto', 'host'] }
 * resolveTrustProxy(true)           // { hops: 1, ranges: [], headers: ['for', 'proto', 'host'] }
 * resolveTrustProxy({ at: ['*'] })  // throws
 */
export function resolveTrustProxy(
  trust: TrustProxy | TrustProxiesOptions | undefined,
): ResolvedProxies {
  const problems: string[] = []
  const options: TrustProxiesOptions | undefined = isProxyList(trust)
    ? { at: trust }
    : trust !== undefined && typeof trust === 'object'
      ? trust
      : undefined
  const headers = options?.headers ?? ALL_FORWARDED
  for (const header of headers)
    if (!ALL_FORWARDED.includes(header))
      problems.push(
        `trustProxy headers: "${String(header)}" is not one of "for", "proto" or "host".`,
      )
  let hops = 0
  const ranges: Cidr[] = []
  if (options !== undefined) {
    for (const entry of options.at) {
      const cidr = typeof entry === 'string' ? parseCidr(entry) : undefined
      if (cidr === undefined)
        problems.push(
          `trustProxy: "${String(entry)}" is not an IP address or CIDR range (to trust a load balancer, list its address or subnet, never "*").`,
        )
      else ranges.push(cidr)
    }
  } else if (trust === true) hops = 1
  else if (typeof trust === 'number') {
    if (!Number.isInteger(trust) || trust < 0 || trust > 32)
      problems.push(
        `trustProxy: ${String(trust)} is not a hop count (a whole number from 0 to 32), a boolean or a list of proxy addresses.`,
      )
    else hops = trust
  }
  failIfAny(problems)
  return Object.freeze({
    hops,
    ranges: Object.freeze(ranges),
    headers: Object.freeze([...headers]),
  })
}

function isProxyList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
}

/**
 * Who the client is, as far as the trusted proxies say. `ip` is `undefined` when it can't be
 * determined safely (no usable socket peer, or a malformed selected entry in hop mode).
 *
 * @example
 * const client: ForwardedClient = { ip: '203.0.113.7', secure: true, host: 'blog.example.com' }
 */
export interface ForwardedClient {
  readonly ip: string | undefined
  readonly secure: boolean
  readonly host: string
}

/**
 * Work out the client's address, scheme and host. `X-Forwarded-*` headers are read only from a
 * trusted proxy; from anyone else this is just the socket address and the request URL. Addresses
 * come back in one spelling per client ({@link canonicalIp}: `::ffff:10.0.0.1` is `10.0.0.1`).
 *
 * @example
 * const proxies = resolveTrustProxy(['10.0.0.0/8'])
 * forwardedClient('10.0.0.5', request, proxies) // { ip: '203.0.113.7', secure: true, host: 'blog.example.com' }
 */
export function forwardedClient(
  peer: string | undefined,
  request: ForwardedRequest,
  proxies: ResolvedProxies,
): ForwardedClient {
  const url = new URL(request.url)
  const peerIp = peer === undefined ? undefined : canonicalIp(peer)
  const direct: ForwardedClient = {
    ip: peerIp,
    secure: url.protocol === 'https:',
    host: url.hostname.toLowerCase(),
  }
  if (!isTrustedProxy(peer, proxies)) return direct
  const headers = request.headers
  const reads = (name: ForwardedHeader): boolean => proxies.headers.includes(name)
  const proto = reads('proto')
    ? lastValue(headers.get('x-forwarded-proto'))?.toLowerCase()
    : undefined
  const host = reads('host') ? forwardedHost(lastValue(headers.get('x-forwarded-host'))) : undefined
  let ip = direct.ip
  if (reads('for')) {
    if (proxies.hops > 0) {
      const chosen = clientAddressOf(peer, headers.get('x-forwarded-for'), proxies.hops)
      ip = chosen === undefined ? undefined : canonicalIp(chosen)
    } else if (peerIp !== undefined)
      ip = rightmostUntrusted(peerIp, headers.get('x-forwarded-for'), proxies.ranges) ?? peerIp
  }
  return {
    ip,
    secure: proto === 'https' ? true : proto === 'http' ? false : direct.secure,
    host: host ?? direct.host,
  }
}

/**
 * What {@link forwardedClient} reads from a request: its URL and headers. A `Request` fits; the Node
 * adapter passes a view of the raw Node request instead of building one.
 *
 * @example
 * const view: ForwardedRequest = { url: 'http://127.0.0.1:3000/', headers: new Headers() }
 */
export interface ForwardedRequest {
  readonly url: string
  readonly headers: { get(name: string): string | null }
}

/**
 * `true` when the peer's `X-Forwarded-*` headers may be believed: always in the hop-count model
 * (`trustProxy: true` or a number), and for a peer inside one of the listed ranges otherwise.
 *
 * @example
 * isTrustedProxy('10.0.0.5', resolveTrustProxy(['10.0.0.0/8'])) // true
 * isTrustedProxy('203.0.113.7', resolveTrustProxy(['10.0.0.0/8'])) // false
 */
export function isTrustedProxy(peer: string | undefined, proxies: ResolvedProxies): boolean {
  if (proxies.hops > 0) return true
  const peerIp = peer === undefined ? undefined : canonicalIp(peer)
  return peerIp !== undefined && isTrustedPeer(peerIp, proxies.ranges)
}

function isTrustedPeer(address: string, ranges: readonly Cidr[]): boolean {
  const ip = parseIp(address)
  return ip !== undefined && ranges.some((range) => inCidr(ip, range))
}

/**
 * The right-most untrusted address of `X-Forwarded-For` + peer. Any malformed entry makes the
 * whole header untrustworthy (`undefined`): guessing around garbage is how spoofing gets in.
 */
function rightmostUntrusted(
  peer: string,
  header: string | null,
  ranges: readonly Cidr[],
): string | undefined {
  if (header === null) return undefined
  const parsed = [...header.split(','), peer].map((entry) => canonicalIp(entry))
  const chain: string[] = []
  for (const ip of parsed) {
    if (ip === undefined) return undefined
    chain.push(ip)
  }
  for (let index = chain.length - 1; index >= 0; index--) {
    const ip = chain[index]
    if (ip !== undefined && !isTrustedPeer(ip, ranges)) return ip
  }
  // Every hop is a trusted proxy: the left-most is the furthest anyone vouched for.
  return chain[0]
}

/** The nearest proxy appends last, so the last value is the one it vouches for. */
function lastValue(header: string | null): string | undefined {
  if (header === null) return undefined
  const value = header.split(',').at(-1)?.trim()
  return value === '' ? undefined : value
}

/** A forwarded host must be a plain host name (or address), optionally with a port. */
function forwardedHost(value: string | undefined): string | undefined {
  if (value === undefined || !/^[a-z0-9.\-[\]:]+$/i.test(value) || !URL.canParse(`http://${value}`))
    return undefined
  return new URL(`http://${value}`).hostname.toLowerCase()
}

/**
 * The number of trusted hops for the hop-count model. Throws a `RangeError` for a negative or
 * non-integer value (a config mistake), and for a list of proxy addresses, which only
 * {@link forwardedClient} (via {@link resolveTrustProxy}) understands.
 *
 * @example
 * trustedHops(true) // 1
 */
export function trustedHops(trust: TrustProxy | undefined): number {
  if (trust === undefined || trust === false) return 0
  if (trust === true) return 1
  if (typeof trust !== 'number')
    throw new RangeError(
      'trustProxy as a list of proxy addresses is resolved with resolveTrustProxy() and read with forwardedClient(), not as a hop count',
    )
  if (!Number.isInteger(trust) || trust < 0 || trust > 32) {
    throw new RangeError('trustProxy must be a boolean or an integer between 0 and 32')
  }
  return trust
}

/** Strip an IPv4-mapped IPv6 prefix (`::ffff:10.0.0.1` → `10.0.0.1`) so one client has one key. */
function normaliseAddress(address: string | undefined): string | undefined {
  if (address === undefined || address === '') return undefined
  const plain =
    address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address
  return isIP(plain) === 0 ? undefined : plain
}

/**
 * The client address: the socket peer, or (behind `hops` trusted proxies) the matching
 * `X-Forwarded-For` entry. Returns `undefined` when it cannot be determined safely.
 *
 * @example
 * clientAddressOf('10.0.0.1', '6.6.6.6, 198.51.100.7', 1) // '198.51.100.7'
 */
export function clientAddressOf(
  peer: string | undefined,
  forwardedFor: string | null | undefined,
  hops: number,
): string | undefined {
  if (hops === 0) return normaliseAddress(peer)
  const chain = (forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (chain.length === 0) return normaliseAddress(peer)
  // Fewer entries than trusted hops: the left-most one is the furthest anyone vouched for.
  const index = Math.max(chain.length - hops, 0)
  return normaliseAddress(chain[index])
}

/**
 * The protocol the client used: `X-Forwarded-Proto` (last entry, written by the nearest proxy)
 * when proxies are trusted, else `fallback`.
 *
 * @example
 * forwardedProtocol('http, https', 1, 'http') // 'https'
 */
export function forwardedProtocol(
  header: string | null | undefined,
  hops: number,
  fallback: 'http' | 'https',
): 'http' | 'https' {
  if (hops === 0 || !header) return fallback
  const last = header.split(',').pop()?.trim().toLowerCase()
  return last === 'https' ? 'https' : last === 'http' ? 'http' : fallback
}

/**
 * Validate a configured public URL (an absolute http(s) origin, optionally with a path).
 *
 * @example
 * parsePublicUrl('https://app.example.com')?.origin // 'https://app.example.com'
 */
export function parsePublicUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value === '') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`publicUrl "${value}" is not an absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new TypeError(`publicUrl "${value}" must use http or https`)
  return url
}
