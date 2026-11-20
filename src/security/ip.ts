/**
 * IP addresses as numbers: parsing, CIDR ranges and the special-purpose ranges that must never be
 * reached by server-side requests (SSRF) or trusted as proxies by accident. Ported from spike 12.
 *
 * Why our own parser: the checks must agree exactly with what the socket will connect to. Parsing
 * is strict (dotted-quad decimal IPv4, standard IPv6, no zone ids); the lenient forms an attacker
 * uses in URLs (`2130706433`, `0177.0.0.1`, `0x7f.1`) are normalised by the WHATWG URL parser
 * *before* they get here, so they end up as `127.0.0.1` and are judged like it.
 *
 * @module
 */
import { isIP } from 'node:net'

/**
 * A parsed address: its family and its value as an unsigned integer.
 *
 * @example
 * parseIp('10.0.0.1') // { version: 4, value: 167772161n }
 */
export interface ParsedIp {
  readonly version: 4 | 6
  readonly value: bigint
}

/**
 * A CIDR range: the family, the network address and the prefix length.
 *
 * @example
 * parseCidr('10.0.0.0/8') // { version: 4, base: 167772160n, prefix: 8 }
 */
export interface Cidr {
  readonly version: 4 | 6
  readonly base: bigint
  readonly prefix: number
}

/**
 * Parse an IPv4 or IPv6 address (brackets allowed, zone ids refused). `undefined` if invalid.
 *
 * @example
 * parseIp('[::1]')      // { version: 6, value: 1n }
 * parseIp('2130706433') // undefined (not dotted-quad; URLs normalise it first)
 */
export function parseIp(text: string): ParsedIp | undefined {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  const family = isIP(bare)
  if (family === 4) return { version: 4, value: ipv4Value(bare) }
  // A zone id (`fe80::1%eth0`) names an interface, not an address: refused, never guessed.
  if (family === 6 && !bare.includes('%')) return { version: 6, value: ipv6Value(bare) }
  return undefined
}

function ipv4Value(text: string): bigint {
  return text.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n)
}

function ipv6Value(text: string): bigint {
  let head = text
  let tail32: bigint | undefined
  const lastColon = text.lastIndexOf(':')
  if (text.slice(lastColon + 1).includes('.')) {
    // An embedded IPv4 tail (::ffff:1.2.3.4) supplies the last two groups.
    tail32 = ipv4Value(text.slice(lastColon + 1))
    head = `${text.slice(0, lastColon + 1)}0:0`
  }
  const [left = '', right] = head.split('::')
  const leftGroups = left === '' ? [] : left.split(':')
  const rightGroups = right === undefined || right === '' ? [] : right.split(':')
  const groups =
    right === undefined
      ? leftGroups
      : [
          ...leftGroups,
          ...Array<string>(8 - leftGroups.length - rightGroups.length).fill('0'),
          ...rightGroups,
        ]
  const value = groups.reduce(
    (total, group) => (total << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  )
  return tail32 === undefined ? value : (value & ~0xffffffffn) | tail32
}

/**
 * Parse `addr/prefix`, or a single address (a /32 or /128). `undefined` if invalid.
 *
 * @example
 * parseCidr('2001:db8::/32')
 * parseCidr('10.0.0.0/33') // undefined
 */
export function parseCidr(text: string): Cidr | undefined {
  const [address = '', prefixText, extra] = text.trim().split('/')
  if (extra !== undefined) return undefined
  const ip = parseIp(address)
  if (ip === undefined) return undefined
  const bits = ip.version === 4 ? 32 : 128
  const prefix =
    prefixText === undefined ? bits : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return undefined
  return { version: ip.version, base: ip.value & mask(bits, prefix), prefix }
}

function mask(bits: number, prefix: number): bigint {
  const width = BigInt(bits)
  return prefix === 0 ? 0n : ((1n << width) - 1n) ^ ((1n << (width - BigInt(prefix))) - 1n)
}

/**
 * `true` when the address is inside the range (same family only).
 *
 * @example
 * const ip = parseIp('10.1.2.3'); const range = parseCidr('10.0.0.0/8')
 * if (ip && range) inCidr(ip, range) // true
 */
export function inCidr(ip: ParsedIp, range: Cidr): boolean {
  if (ip.version !== range.version) return false
  return (ip.value & mask(ip.version === 4 ? 32 : 128, range.prefix)) === range.base
}

/**
 * The IPv4 address hidden inside an IPv6 one, for the forms that make a v6 socket reach a v4
 * host: IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`), IPv4-compatible
 * (`::a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002:AABB:CCDD::/16`).
 *
 * @example
 * const ip = parseIp('::ffff:127.0.0.1')
 * if (ip) embeddedIpv4(ip) // { version: 4, value: 2130706433n }
 */
export function embeddedIpv4(ip: ParsedIp): ParsedIp | undefined {
  if (ip.version !== 6) return undefined
  const low32 = ip.value & 0xffffffffn
  const high96 = ip.value >> 32n
  if (
    high96 === 0xffffn ||
    high96 === 0xffff0000n ||
    (high96 === 0n && ip.value > 1n) ||
    high96 === 0x0064ff9b0000000000000000n
  )
    return { version: 4, value: low32 }
  if (ip.value >> 112n === 0x2002n) return { version: 4, value: (ip.value >> 80n) & 0xffffffffn }
  return undefined
}

/** Special-purpose ranges, named for error messages (IANA special-purpose registries). */
const SPECIAL_RANGES: readonly { readonly name: string; readonly range: string }[] = [
  { name: 'this network', range: '0.0.0.0/8' },
  { name: 'private (10/8)', range: '10.0.0.0/8' },
  { name: 'carrier-grade NAT (includes cloud metadata 100.100.100.200)', range: '100.64.0.0/10' },
  { name: 'loopback', range: '127.0.0.0/8' },
  { name: 'link-local (includes cloud metadata 169.254.169.254)', range: '169.254.0.0/16' },
  { name: 'private (172.16/12)', range: '172.16.0.0/12' },
  { name: 'IETF protocol assignments', range: '192.0.0.0/24' },
  { name: 'documentation', range: '192.0.2.0/24' },
  { name: '6to4 relay anycast (deprecated)', range: '192.88.99.0/24' },
  { name: 'private (192.168/16)', range: '192.168.0.0/16' },
  { name: 'benchmarking', range: '198.18.0.0/15' },
  { name: 'documentation', range: '198.51.100.0/24' },
  { name: 'documentation', range: '203.0.113.0/24' },
  { name: 'multicast', range: '224.0.0.0/4' },
  { name: 'reserved', range: '240.0.0.0/4' },
  { name: 'unspecified', range: '::/128' },
  { name: 'loopback', range: '::1/128' },
  { name: 'NAT64 local-use', range: '64:ff9b:1::/48' },
  { name: 'discard-only', range: '100::/64' },
  { name: 'Teredo tunnel', range: '2001::/32' },
  { name: 'documentation', range: '2001:db8::/32' },
  { name: 'unique local (includes AWS metadata fd00:ec2::254)', range: 'fc00::/7' },
  { name: 'link-local', range: 'fe80::/10' },
  { name: 'site-local (deprecated)', range: 'fec0::/10' },
  { name: 'multicast', range: 'ff00::/8' },
]

const PARSED_SPECIAL: readonly { readonly name: string; readonly cidr: Cidr }[] =
  SPECIAL_RANGES.flatMap(({ name, range }) => {
    const cidr = parseCidr(range)
    return cidr === undefined ? [] : [{ name, cidr }]
  })

/**
 * Why an address must not be reached from the server, or `undefined` for a public address.
 * IPv6 forms that embed an IPv4 address are judged by that address.
 *
 * @example
 * const metadata = parseIp('169.254.169.254')
 * if (metadata) blockedReason(metadata) // 'link-local (includes cloud metadata 169.254.169.254)'
 */
export function blockedReason(ip: ParsedIp): string | undefined {
  const inner = embeddedIpv4(ip)
  if (inner !== undefined) return blockedReason(inner)
  return PARSED_SPECIAL.find(({ cidr }) => inCidr(ip, cidr))?.name
}

/**
 * The address in its canonical text form (dotted quad, or eight lower-case IPv6 groups).
 *
 * @example
 * formatIp({ version: 4, value: 2130706433n }) // '127.0.0.1'
 */
export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4)
    return [24n, 16n, 8n, 0n].map((shift) => String((ip.value >> shift) & 0xffn)).join('.')
  const groups: string[] = []
  for (let shift = 112n; shift >= 0n; shift -= 16n)
    groups.push(((ip.value >> shift) & 0xffffn).toString(16))
  return groups.join(':')
}

/**
 * One spelling per client, for anything keyed by address (rate limits, logs, allowlists): an
 * IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, what a dual-stack socket reports) becomes the
 * IPv4 address, everything else its {@link formatIp} form. `undefined` for anything invalid.
 *
 * @example
 * canonicalIp('::ffff:10.0.0.1') // '10.0.0.1'
 * canonicalIp('2001:DB8::1')     // '2001:db8:0:0:0:0:0:1'
 */
export function canonicalIp(text: string): string | undefined {
  const ip = parseIp(text.trim())
  if (ip === undefined) return undefined
  if (ip.version === 6 && ip.value >> 32n === 0xffffn)
    return formatIp({ version: 4, value: ip.value & 0xffffffffn })
  return formatIp(ip)
}
