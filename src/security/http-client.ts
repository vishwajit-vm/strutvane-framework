/**
 * `safeFetch`: one HTTP request to a URL that users (or webhooks, or imported data) control, with
 * an SSRF guard (ported from spike 12). It refuses private, loopback, link-local, cloud-metadata
 * and other special ranges (`ip.ts`), enforces a deadline, a response size cap and a redirect
 * limit. The `HttpClient` (`http.ts`) is the friendly, fakeable API on top of it.
 *
 * **DNS rebinding** is the subtle part: a name can resolve to a public address when checked and
 * to `127.0.0.1` a millisecond later when the socket connects. So the client resolves **once**,
 * checks **every** address, and then connects to the checked address itself (a pinned `lookup`),
 * keeping the real host name for the `Host` header and TLS (SNI and certificate checks). One bad
 * address blocks the name: the OS could pick it on a retry or a second connection.
 *
 * **The URL parser is an ally**: WHATWG URL turns `2130706433`, `0x7f.1` and `0177.0.0.1` into
 * `127.0.0.1` and strips tabs and newlines, so every check runs on the normalised host.
 *
 * **No connection reuse**: every request gets a fresh socket (`agent: false`). A pooled socket
 * is keyed by host and port, not by the address we checked, so a keep-alive connection opened
 * for an *allowed* internal address could otherwise be reused by a later request whose own
 * resolution said "public".
 *
 * **Redirects** are followed by hand, and every hop is checked again. Credentials
 * (`Authorization`, `Cookie`, `Proxy-Authorization`) are dropped when a redirect leaves the
 * origin, as browsers do, so a redirect can't carry an API token to another site.
 *
 * @module
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { BootError } from '../foundation/boot-error.ts'
import { hasControlCharacter } from './control-characters.ts'
import {
  blockedReason,
  type Cidr,
  formatIp,
  inCidr,
  type ParsedIp,
  parseCidr,
  parseIp,
} from './ip.ts'
import { parseJsonSafely } from './safe-json.ts'

/**
 * Resolves a host name to addresses. Tests inject one; the default uses the OS resolver.
 *
 * @example
 * const resolver: Resolver = async () => ['93.184.216.34']
 */
export type Resolver = (hostname: string) => Promise<readonly string[]>

/**
 * What a request may reach despite the SSRF guard: CIDR ranges and host names (exact, or
 * `*.example.com` for subdomains). Empty by default.
 *
 * @example
 * const allow: AllowList = parseAllowList(['10.20.0.0/16', 'billing.internal'])
 */
export interface AllowList {
  readonly ranges: readonly Cidr[]
  readonly hosts: readonly string[]
}

/** Nothing allowed beyond public addresses. */
export const ALLOW_NOTHING: AllowList = Object.freeze({ ranges: [], hosts: [] })

const HOST =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Check an allow list: each entry is a CIDR range, an address, a host name or `*.domain`.
 * Throws a `BootError` (`invalid_http_allow`) naming every bad entry (`*` alone is refused: it
 * would switch the guard off).
 *
 * @example
 * parseAllowList(['10.0.0.0/8', 'internal.example.com'])
 */
export function parseAllowList(entries: readonly string[]): AllowList {
  const ranges: Cidr[] = []
  const hosts: string[] = []
  const bad: string[] = []
  for (const entry of entries) {
    const text = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
    const cidr = parseCidr(text)
    if (cidr !== undefined) ranges.push(cidr)
    else if (HOST.test(text)) hosts.push(text)
    else bad.push(`"${String(entry)}"`)
  }
  if (bad.length > 0)
    throw new BootError(
      'invalid_http_allow',
      `allow(): ${bad.join(', ')} ${bad.length === 1 ? 'is not' : 'are not'} a CIDR range or host name.`,
      'List internal services by address range (10.20.0.0/16) or exact host name; "*" alone is never allowed.',
    )
  return Object.freeze({ ranges, hosts })
}

/**
 * Options for {@link safeFetch}.
 *
 * @example
 * await safeFetch(url, { timeoutMs: 5000, maxBytes: 1024 * 1024 })
 */
export interface SafeFetchOptions {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  /** The whole exchange, every redirect included. Default 10 s. */
  readonly timeoutMs?: number
  /** The largest response body read. Default 5 MiB. */
  readonly maxBytes?: number
  /** Default 3; each hop is checked like the first. */
  readonly maxRedirects?: number
  readonly resolver?: Resolver
  /** Ranges and hosts you deliberately allow (an internal service). Empty by default. */
  readonly allow?: AllowList | readonly string[]
}

/**
 * A response, already read (bounded by `maxBytes`).
 *
 * @example
 * const response = await safeFetch('https://example.com/feed.json')
 * if (response.ok) use(response.json())
 */
export interface SafeResponse {
  readonly status: number
  /** `true` for a 2xx status. */
  readonly ok: boolean
  readonly headers: Headers
  /** The final URL after redirects. */
  readonly url: string
  readonly body: Buffer
  /** The body as UTF-8 text. */
  text(): string
  /** The body as JSON, parsed with the prototype-pollution guard and limits. `unknown`: validate it. */
  json(): unknown
}

/**
 * Why a request failed (lowercase snake_case, CONSISTENCY #68).
 *
 * @example
 * const code: HttpClientErrorCode = 'ssrf_blocked'
 */
export type HttpClientErrorCode =
  | 'ssrf_blocked'
  | 'invalid_url'
  | 'invalid_header'
  | 'timeout'
  | 'response_too_large'
  | 'too_many_redirects'
  | 'dns_failed'
  | 'connection_failed'
  | 'stray_request'

/**
 * Thrown by {@link safeFetch} and the `HttpClient`. `ssrf_blocked`, `invalid_url`,
 * `invalid_header` and `stray_request` mean nothing was sent at all. Not a client-facing error:
 * left uncaught it becomes a plain 500, so resolved addresses never reach a client.
 *
 * @example
 * try { await safeFetch(url) } catch (error) { if (error instanceof HttpClientError && error.code === 'ssrf_blocked') … }
 */
export class HttpClientError extends Error {
  readonly code: HttpClientErrorCode

  constructor(code: HttpClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HttpClientError'
    this.code = code
  }
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']
const BODY_HEADERS = ['content-type', 'content-length']
/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i

/**
 * Parse and check a target URL: http or https only, no credentials. Throws `invalid_url`.
 *
 * @example
 * parseFetchTarget('https://example.com/feed') // URL
 */
export function parseFetchTarget(target: string | URL): URL {
  const text = typeof target === 'string' ? target : target.href
  if (!URL.canParse(text)) throw new HttpClientError('invalid_url', 'The URL could not be parsed.')
  const url = new URL(text)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new HttpClientError(
      'invalid_url',
      `Only http and https URLs are fetched (got ${url.protocol}).`,
    )
  if (url.username !== '' || url.password !== '')
    throw new HttpClientError('invalid_url', 'URLs with credentials are not fetched.')
  return url
}

/**
 * The checks that need no DNS: a literal address in a blocked range, or a `localhost` name.
 * Returns the literal address (or `undefined` for a name). Used by the fakes too, so a test
 * still sees `ssrf_blocked` for `http://169.254.169.254/`.
 *
 * @example
 * checkLiteralTarget(new URL('http://127.0.0.1/'), ALLOW_NOTHING) // throws ssrf_blocked
 */
export function checkLiteralTarget(url: URL, allow: AllowList): ParsedIp | undefined {
  const host = url.hostname
  const literal = parseIp(host)
  if (literal === undefined) {
    if ((host === 'localhost' || host.endsWith('.localhost')) && !hostAllowed(host, allow))
      throw new HttpClientError('ssrf_blocked', `${host} is a loopback name.`)
    return undefined
  }
  checkAddress(host, literal, allow)
  return literal
}

/**
 * Fetch a URL with the SSRF guard, a deadline and a size cap. Throws {@link HttpClientError}.
 *
 * @example
 * const response = await safeFetch('https://example.com/webhook', { method: 'POST', body: JSON.stringify(event) })
 */
export async function safeFetch(
  target: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const allow = isAllowList(options.allow) ? options.allow : parseAllowList(options.allow ?? [])
  const headers = checkedHeaders(options.headers ?? {})
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  const maxRedirects = options.maxRedirects ?? 3
  let url = parseFetchTarget(target)
  let method = (options.method ?? 'GET').toUpperCase()
  let body = options.body
  for (let hop = 0; ; hop++) {
    const address = await checkedAddress(url, options.resolver ?? defaultResolver, allow)
    const response = await send(url, address, {
      method,
      headers,
      body,
      deadline,
      maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
    })
    const next = response.headers.get('location')
    if (!REDIRECTS.has(response.status) || next === null) return response
    if (hop >= maxRedirects)
      throw new HttpClientError('too_many_redirects', `More than ${maxRedirects} redirects.`)
    const nextUrl = parseFetchTarget(URL.canParse(next, url) ? new URL(next, url) : next)
    if (nextUrl.origin !== url.origin) for (const name of CREDENTIAL_HEADERS) delete headers[name]
    url = nextUrl
    // 303 (and, as browsers do, 301/302 after POST) continues as a GET without a body.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET'
      body = undefined
      for (const name of BODY_HEADERS) delete headers[name]
    }
  }
}

function isAllowList(value: SafeFetchOptions['allow']): value is AllowList {
  return value !== undefined && !Array.isArray(value)
}

/** Lower-cased copies of the headers, refusing names and values that could split a request. */
function checkedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || hasControlCharacter(value))
      throw new HttpClientError(
        'invalid_header',
        `The header "${name.slice(0, 64)}" has an invalid name or a control character (such as a line break) in its value.`,
      )
    out[name.toLowerCase()] = value
  }
  return out
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
}

function hostAllowed(host: string, allow: AllowList): boolean {
  return allow.hosts.some((pattern) =>
    pattern.startsWith('*.')
      ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
      : host === pattern,
  )
}

function checkAddress(host: string, ip: ParsedIp, allow: AllowList): void {
  if (allow.ranges.some((range) => inCidr(ip, range))) return
  const reason = blockedReason(ip)
  if (reason !== undefined)
    throw new HttpClientError(
      'ssrf_blocked',
      `${host} resolves to ${formatIp(ip)}, a ${reason} address, which this client never connects to.`,
    )
}

/**
 * Resolve once and check every address; the first one is what the socket will connect to.
 * Literal addresses arrive already normalised by the URL parser.
 */
async function checkedAddress(url: URL, resolver: Resolver, allow: AllowList): Promise<ParsedIp> {
  const literal = checkLiteralTarget(url, allow)
  if (literal !== undefined) return literal
  const host = url.hostname
  let resolved: readonly string[]
  try {
    resolved = await resolver(host)
  } catch (error) {
    throw new HttpClientError('dns_failed', `${host} could not be resolved.`, { cause: error })
  }
  const addresses: ParsedIp[] = []
  for (const entry of resolved) {
    const ip = typeof entry === 'string' ? parseIp(entry) : undefined
    if (ip === undefined)
      throw new HttpClientError('dns_failed', `${host} did not resolve to valid addresses.`)
    addresses.push(ip)
  }
  const [first] = addresses
  if (first === undefined) throw new HttpClientError('dns_failed', `${host} did not resolve.`)
  // An allowed host name is trusted for whatever it resolves to; everything else is checked.
  if (!hostAllowed(host, allow)) for (const ip of addresses) checkAddress(host, ip, allow)
  return first
}

interface SendOptions {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | Uint8Array | undefined
  readonly deadline: number
  readonly maxBytes: number
}

/** One request to the pinned address, with the deadline and the byte cap enforced. */
function send(url: URL, address: ParsedIp, options: SendOptions): Promise<SafeResponse> {
  const pinned = formatIp(address)
  const family = address.version
  // Whatever name the socket layer asks for, it gets the address we checked.
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all === true) callback(null, [{ address: pinned, family }])
    else callback(null, pinned, family)
  }
  const remaining = options.deadline - Date.now()
  if (remaining <= 0)
    return Promise.reject(new HttpClientError('timeout', 'The request timed out.'))
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
  const headers: Record<string, string> = { ...options.headers }
  if (options.body !== undefined)
    headers['content-length'] = String(Buffer.byteLength(options.body))
  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false
    let timedOut = false
    const fail = (error: HttpClientError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const failed = (error: Error): void =>
      fail(
        timedOut
          ? new HttpClientError('timeout', 'The request timed out.')
          : new HttpClientError('connection_failed', `The connection failed: ${error.message}`, {
              cause: error,
            }),
      )
    const tooLarge = (): HttpClientError =>
      new HttpClientError(
        'response_too_large',
        `The response is larger than ${options.maxBytes} bytes.`,
      )
    const request = requester(
      url,
      {
        method: options.method,
        headers,
        lookup,
        agent: false,
        ...(url.protocol === 'https:' && parseIp(url.hostname) === undefined
          ? { servername: url.hostname }
          : {}),
      },
      (response: IncomingMessage) => {
        if (Number(response.headers['content-length'] ?? '0') > options.maxBytes) {
          fail(tooLarge())
          request.destroy()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > options.maxBytes) {
            fail(tooLarge())
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('error', failed)
        response.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(responseOf(response, url, Buffer.concat(chunks)))
        })
        response.on('close', () =>
          failed(new Error('the connection closed before the response ended')),
        )
      },
    )
    const timer = setTimeout(() => {
      timedOut = true
      fail(new HttpClientError('timeout', 'The request timed out.'))
      request.destroy()
    }, remaining)
    request.on('error', failed)
    request.end(options.body)
  })
}

function responseOf(response: IncomingMessage, url: URL, body: Buffer): SafeResponse {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
  }
  return bufferedResponse(response.statusCode ?? 0, headers, url.href, body)
}

/**
 * Build a {@link SafeResponse} from parts (what the fakes return too).
 *
 * @example
 * bufferedResponse(200, new Headers(), 'https://example.com/', Buffer.from('{}')).json() // {}
 */
export function bufferedResponse(
  status: number,
  headers: Headers,
  url: string,
  body: Buffer,
): SafeResponse {
  return Object.freeze({
    status,
    ok: status >= 200 && status < 300,
    headers,
    url,
    body,
    text: () => body.toString('utf8'),
    json: () => parseJsonSafely(body.toString('utf8')),
  })
}
