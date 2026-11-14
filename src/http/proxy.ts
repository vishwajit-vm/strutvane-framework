/**
 * Reverse-proxy awareness: which client address and protocol a request really came from.
 *
 * `X-Forwarded-For` and `X-Forwarded-Proto` are ordinary request headers, so any client can send
 * them. They are only meaningful when a proxy *you run* sets them, which is why nothing here reads
 * them unless the app says how many proxy hops sit in front of it (`trustProxy`). Without that
 * setting the client address is the TCP peer and the protocol is whatever the socket spoke.
 *
 * How hops work (the same rule Express uses): every trusted proxy appends the address it received
 * the request from to `X-Forwarded-For`. With `trustProxy: 1` the last entry was written by your
 * proxy and is the client; with `2`, the second to last; and so on. Entries further left were
 * written by the client and are ignored. A malformed selected entry yields `undefined`, never a
 * guess, so callers keyed by address (rate limits, allow-lists) fail closed.
 *
 * @module
 */
import { isIP } from 'node:net'

/**
 * How many reverse-proxy hops to trust: `false`/`0` (default) trusts none, `true` means one
 * (a single load balancer or ingress), a number means that many chained proxies.
 */
export type TrustProxy = boolean | number

/** The number of trusted hops. Throws for a negative or non-integer value (a config mistake). */
export function trustedHops(trust: TrustProxy | undefined): number {
  if (trust === undefined || trust === false) return 0
  if (trust === true) return 1
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

/** Validate a configured public URL (an absolute http(s) origin, optionally with a path). */
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
