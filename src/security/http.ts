/**
 * The HTTP client, Laravel's `Http` facade engine (doc 20 row "HTTP client"): a fluent API for
 * outgoing requests, with the SSRF guard of {@link safeFetch} always on, and fakes for tests.
 *
 * ```ts
 * const response = await http.withToken(token).timeout(5_000).post('https://api.example.com/hooks', { event })
 * ```
 *
 * Why the SSRF guard is not optional: outgoing URLs come from users (webhooks, avatars by URL,
 * imports) far more often than developers expect, and the classic SSRF targets (cloud metadata
 * at `169.254.169.254`, `localhost` admin ports, the private network) are one request away. An
 * internal service is reached deliberately with `allow(['10.20.0.0/16'])` or `allow(['billing.internal'])`.
 *
 * **Tests** call `fake()` (every request, or a URL-pattern map, or a function) and then
 * `assertSent(…)`; `preventStrayRequests()` makes any request without a fake throw instead of
 * reaching the network. Faked requests still go through the URL and literal-address checks, so a
 * test of SSRF handling sees `ssrf_blocked` for `http://169.254.169.254/` (names are not resolved
 * while faking).
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'
import {
  ALLOW_NOTHING,
  type AllowList,
  bufferedResponse,
  checkLiteralTarget,
  HttpClientError,
  parseAllowList,
  parseFetchTarget,
  type Resolver,
  type SafeResponse,
  safeFetch,
} from './http-client.ts'
import { parseJsonSafely } from './safe-json.ts'

export { HttpClientError, type HttpClientErrorCode, type Resolver } from './http-client.ts'

/**
 * A response from the client (already read, size-capped).
 *
 * @example
 * const response: HttpResponse = await http.get('https://example.com/status')
 */
export type HttpResponse = SafeResponse

/**
 * A request as the fakes saw it, for assertions.
 *
 * @example
 * http.assertSent((request: RecordedRequest) => request.method === 'POST' && request.url.endsWith('/hooks'))
 */
export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  /** The body as text, `undefined` when there was none. */
  readonly body: string | undefined
  /** The body parsed as JSON (`unknown`: check it like any input). */
  json(): unknown
}

/**
 * What a fake answers with.
 *
 * @example
 * const stub: HttpFakeStub = { status: 201, body: { id: 7 }, headers: { location: '/items/7' } }
 */
export interface HttpFakeStub {
  /** Default 200. */
  readonly status?: number
  /** A string or bytes as is; anything else as JSON. Default empty. */
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A fake computed from the request.
 *
 * @example
 * const handler: HttpFakeHandler = (request) => ({ status: request.method === 'GET' ? 200 : 405 })
 */
export type HttpFakeHandler = (request: RecordedRequest) => HttpFakeStub | Promise<HttpFakeStub>

/**
 * What `fake()` takes: one handler for every request, or URL patterns (`'api.github.com/*'`,
 * `'https://example.com/x'`, `'*'`) mapped to a stub or a handler. Patterns without a scheme
 * match any scheme; `*` matches anything.
 *
 * @example
 * http.fake({ 'api.github.com/*': { body: { login: 'octocat' } }, '*': { status: 404 } })
 */
export type HttpFakes = HttpFakeHandler | Readonly<Record<string, HttpFakeStub | HttpFakeHandler>>

/**
 * App-wide defaults for the client.
 *
 * @example
 * const options: HttpClientOptions = { timeoutMs: 5_000, allow: ['billing.internal'] }
 */
export interface HttpClientOptions {
  /** DNS resolver (tests inject one). Default: the OS resolver. */
  readonly resolver?: Resolver
  /** Internal ranges and hosts every request may reach. Default none. */
  readonly allow?: readonly string[]
  /** Default 10 s for the whole exchange. */
  readonly timeoutMs?: number
  /** Default 5 MiB. */
  readonly maxBytes?: number
  /** Default 3. */
  readonly maxRedirects?: number
}

/** A query string's values. */
type QueryValues = Readonly<Record<string, string | number | boolean>>

/**
 * A pending request's settings (made by {@link HttpClient}; not built by hand).
 *
 * @example
 * // internal: new PendingRequest(state, settings)
 */
export interface PendingRequestSettings {
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly maxRedirects: number
  readonly allow: AllowList
  readonly form: boolean
}

/**
 * The state a client shares with the pending requests it creates (fakes, recorded requests).
 * Internal: made by {@link HttpClient}.
 *
 * @example
 * // internal: new PendingRequest(state, settings)
 */
export interface HttpClientState {
  readonly resolver: Resolver | undefined
  fakes: HttpFakes | undefined
  faking: boolean
  preventStray: boolean
  readonly recorded: RecordedRequest[]
}

const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MAX_BYTES = 1024 * 1024 * 1024

/**
 * One request being built: every method returns a new `PendingRequest`, so a configured base can
 * be shared safely.
 *
 * @example
 * const github = http.withHeaders({ accept: 'application/vnd.github+json' }).timeout(5_000)
 * await github.get('https://api.github.com/users/octocat')
 */
export class PendingRequest {
  readonly #state: HttpClientState
  readonly #settings: PendingRequestSettings

  /** Created by {@link HttpClient}; start requests from a client instead. */
  constructor(state: HttpClientState, settings: PendingRequestSettings) {
    this.#state = state
    this.#settings = settings
  }

  /**
   * Add request headers (names are case-insensitive; later calls win).
   *
   * @example
   * http.withHeaders({ 'x-api-version': '2' })
   */
  withHeaders(headers: Readonly<Record<string, string>>): PendingRequest {
    const merged: Record<string, string> = { ...this.#settings.headers }
    for (const [name, value] of Object.entries(headers)) merged[name.toLowerCase()] = value
    return this.#with({ headers: merged })
  }

  /**
   * Send `Authorization: <type> <token>`.
   *
   * @example
   * http.withToken(process.env.API_TOKEN ?? '')
   */
  withToken(value: string, type = 'Bearer'): PendingRequest {
    return this.withHeaders({ authorization: `${type} ${value}` })
  }

  /**
   * Ask for JSON (`Accept: application/json`).
   *
   * @example
   * http.acceptJson().get(url)
   */
  acceptJson(): PendingRequest {
    return this.withHeaders({ accept: 'application/json' })
  }

  /**
   * Send object bodies as `application/x-www-form-urlencoded` instead of JSON.
   *
   * @example
   * http.asForm().post(url, { grant_type: 'client_credentials' })
   */
  asForm(): PendingRequest {
    return this.#with({ form: true })
  }

  /**
   * The deadline for the whole exchange, redirects included (1 ms to 10 minutes).
   *
   * @example
   * http.timeout(3_000).get(url)
   */
  timeout(ms: number): PendingRequest {
    return this.#with({ timeoutMs: bounded('timeout', ms, 1, MAX_TIMEOUT_MS) })
  }

  /**
   * The largest response body read (1 byte to 1 GiB); larger ones fail with `response_too_large`.
   *
   * @example
   * http.maxBytes(64 * 1024).get(url)
   */
  maxBytes(bytes: number): PendingRequest {
    return this.#with({ maxBytes: bounded('maxBytes', bytes, 1, MAX_BYTES) })
  }

  /**
   * How many redirects to follow (0 to 20); each hop is checked like the first.
   *
   * @example
   * http.maxRedirects(0).get(url)
   */
  maxRedirects(count: number): PendingRequest {
    return this.#with({ maxRedirects: bounded('maxRedirects', count, 0, 20) })
  }

  /**
   * Let this request reach internal ranges or hosts the SSRF guard would block (CIDR ranges,
   * addresses, host names or `*.domain`). Adds to the client's own allow list.
   *
   * @example
   * http.allow(['10.20.0.0/16', 'billing.internal']).get('http://billing.internal/health')
   */
  allow(entries: readonly string[]): PendingRequest {
    const extra = parseAllowList(entries)
    return this.#with({
      allow: Object.freeze({
        ranges: [...this.#settings.allow.ranges, ...extra.ranges],
        hosts: [...this.#settings.allow.hosts, ...extra.hosts],
      }),
    })
  }

  /**
   * GET, with optional query values appended to the URL.
   *
   * @example
   * await http.get('https://api.example.com/search', { q: 'strut', page: 2 })
   */
  get(url: string, query?: QueryValues): Promise<HttpResponse> {
    return this.send('GET', withQuery(url, query))
  }

  /**
   * HEAD, with optional query values.
   *
   * @example
   * await http.head('https://example.com/file.zip')
   */
  head(url: string, query?: QueryValues): Promise<HttpResponse> {
    return this.send('HEAD', withQuery(url, query))
  }

  /**
   * POST. Objects are sent as JSON (or a form after `asForm()`), strings and bytes as they are.
   *
   * @example
   * await http.post('https://api.example.com/hooks', { event: 'paid' })
   */
  post(url: string, data?: unknown): Promise<HttpResponse> {
    return this.send('POST', url, data)
  }

  /**
   * PUT; bodies as for {@link PendingRequest.post}.
   *
   * @example
   * await http.put('https://api.example.com/items/7', { name: 'x' })
   */
  put(url: string, data?: unknown): Promise<HttpResponse> {
    return this.send('PUT', url, data)
  }

  /**
   * PATCH; bodies as for {@link PendingRequest.post}.
   *
   * @example
   * await http.patch('https://api.example.com/items/7', { name: 'x' })
   */
  patch(url: string, data?: unknown): Promise<HttpResponse> {
    return this.send('PATCH', url, data)
  }

  /**
   * DELETE, with an optional body.
   *
   * @example
   * await http.delete('https://api.example.com/items/7')
   */
  delete(url: string, data?: unknown): Promise<HttpResponse> {
    return this.send('DELETE', url, data)
  }

  /**
   * Send a request with any method. Throws {@link HttpClientError} for refused, failed or
   * stray requests; any HTTP status (404, 500) is a normal response.
   *
   * @example
   * await http.send('OPTIONS', 'https://api.example.com/')
   */
  async send(method: string, url: string, data?: unknown): Promise<HttpResponse> {
    const target = parseFetchTarget(url)
    const { headers, body } = encodeBody(this.#settings, data)
    const state = this.#state
    if (state.faking || state.preventStray) {
      checkLiteralTarget(target, this.#settings.allow)
      const recorded = record(method.toUpperCase(), target.href, headers, body)
      const fake = state.faking ? findFake(state.fakes, target) : undefined
      if (state.faking) state.recorded.push(recorded)
      if (fake !== undefined) return stubResponse(await fake(recorded), target.href)
      if (state.preventStray)
        throw new HttpClientError(
          'stray_request',
          `${method.toUpperCase()} ${target.href} has no fake, and stray requests are prevented.`,
        )
    }
    return safeFetch(target, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: this.#settings.timeoutMs,
      maxBytes: this.#settings.maxBytes,
      maxRedirects: this.#settings.maxRedirects,
      allow: this.#settings.allow,
      ...(state.resolver !== undefined ? { resolver: state.resolver } : {}),
    })
  }

  #with(changes: Partial<PendingRequestSettings>): PendingRequest {
    return new PendingRequest(this.#state, { ...this.#settings, ...changes })
  }
}

/**
 * The client: start requests from it, or fake it in tests. One instance per app, bound under
 * {@link HttpClientToken}; the `Http` facade resolves that token.
 *
 * @example
 * const http = new HttpClient()
 * const response = await http.acceptJson().get('https://api.example.com/status')
 */
export class HttpClient {
  readonly #state: HttpClientState
  readonly #defaults: PendingRequestSettings

  constructor(options: HttpClientOptions = {}) {
    this.#state = {
      resolver: options.resolver,
      fakes: undefined,
      faking: false,
      preventStray: false,
      recorded: [],
    }
    this.#defaults = Object.freeze({
      headers: {},
      timeoutMs: bounded('timeout', options.timeoutMs ?? 10_000, 1, MAX_TIMEOUT_MS),
      maxBytes: bounded('maxBytes', options.maxBytes ?? 5 * 1024 * 1024, 1, MAX_BYTES),
      maxRedirects: bounded('maxRedirects', options.maxRedirects ?? 3, 0, 20),
      allow: options.allow === undefined ? ALLOW_NOTHING : parseAllowList(options.allow),
      form: false,
    })
  }

  /**
   * A stub for `fake()`, Laravel's `Http::response()`.
   *
   * @example
   * http.fake({ '*': HttpClient.response({ ok: true }, 200) })
   */
  static response(
    body?: unknown,
    status = 200,
    headers: Readonly<Record<string, string>> = {},
  ): HttpFakeStub {
    return { body, status, headers }
  }

  /**
   * Fake responses (tests). With no argument every request gets an empty 200. Calling it again
   * replaces the fakes; recorded requests are kept.
   *
   * @example
   * http.fake({ 'api.example.com/*': { body: { ok: true } } })
   */
  fake(fakes?: HttpFakes): this {
    this.#state.faking = true
    this.#state.fakes = fakes ?? (() => ({}))
    return this
  }

  /**
   * Make every request without a matching fake throw `stray_request` instead of reaching the
   * network (tests).
   *
   * @example
   * http.fake({ 'api.example.com/*': { body: {} } }).preventStrayRequests()
   */
  preventStrayRequests(prevent = true): this {
    this.#state.preventStray = prevent
    return this
  }

  /**
   * The requests seen while faking, oldest first.
   *
   * @example
   * http.recorded()[0]?.url
   */
  recorded(): readonly RecordedRequest[] {
    return [...this.#state.recorded]
  }

  /**
   * Assert that at least one recorded request matches. Throws an `Error` naming what was sent.
   *
   * @example
   * http.assertSent((request) => request.url === 'https://api.example.com/hooks' && request.method === 'POST')
   */
  assertSent(predicate: (request: RecordedRequest) => boolean): void {
    if (!this.#state.recorded.some(predicate))
      throw new Error(
        `Expected a matching request to have been sent. Sent: ${this.#describeSent()}.`,
      )
  }

  /**
   * Assert that no recorded request matches.
   *
   * @example
   * http.assertNotSent((request) => request.url.includes('/charges'))
   */
  assertNotSent(predicate: (request: RecordedRequest) => boolean): void {
    if (this.#state.recorded.some(predicate))
      throw new Error(
        `Expected no matching request, but one was sent. Sent: ${this.#describeSent()}.`,
      )
  }

  /**
   * Assert that nothing was sent at all.
   *
   * @example
   * http.fake(); await job.run(); http.assertNothingSent()
   */
  assertNothingSent(): void {
    if (this.#state.recorded.length > 0)
      throw new Error(`Expected no requests, but ${this.#describeSent()} were sent.`)
  }

  /**
   * Assert exactly how many requests were sent.
   *
   * @example
   * http.assertSentCount(2)
   */
  assertSentCount(count: number): void {
    if (this.#state.recorded.length !== count)
      throw new Error(
        `Expected ${count} requests, but ${this.#state.recorded.length} were sent: ${this.#describeSent()}.`,
      )
  }

  /**
   * Start a request with headers. See {@link PendingRequest.withHeaders}.
   *
   * @example
   * http.withHeaders({ 'x-api-version': '2' }).get(url)
   */
  withHeaders(headers: Readonly<Record<string, string>>): PendingRequest {
    return this.#pending().withHeaders(headers)
  }

  /**
   * Start a request with a bearer token. See {@link PendingRequest.withToken}.
   *
   * @example
   * http.withToken(token).get(url)
   */
  withToken(value: string, type = 'Bearer'): PendingRequest {
    return this.#pending().withToken(value, type)
  }

  /**
   * Start a request asking for JSON. See {@link PendingRequest.acceptJson}.
   *
   * @example
   * http.acceptJson().get(url)
   */
  acceptJson(): PendingRequest {
    return this.#pending().acceptJson()
  }

  /**
   * Start a form request. See {@link PendingRequest.asForm}.
   *
   * @example
   * http.asForm().post(url, { a: '1' })
   */
  asForm(): PendingRequest {
    return this.#pending().asForm()
  }

  /**
   * Start a request with a deadline. See {@link PendingRequest.timeout}.
   *
   * @example
   * http.timeout(3_000).get(url)
   */
  timeout(ms: number): PendingRequest {
    return this.#pending().timeout(ms)
  }

  /**
   * Start a request with a response size cap. See {@link PendingRequest.maxBytes}.
   *
   * @example
   * http.maxBytes(65_536).get(url)
   */
  maxBytes(bytes: number): PendingRequest {
    return this.#pending().maxBytes(bytes)
  }

  /**
   * Start a request with a redirect limit. See {@link PendingRequest.maxRedirects}.
   *
   * @example
   * http.maxRedirects(0).get(url)
   */
  maxRedirects(count: number): PendingRequest {
    return this.#pending().maxRedirects(count)
  }

  /**
   * Start a request that may reach internal ranges or hosts. See {@link PendingRequest.allow}.
   *
   * @example
   * http.allow(['billing.internal']).get('http://billing.internal/health')
   */
  allow(entries: readonly string[]): PendingRequest {
    return this.#pending().allow(entries)
  }

  /**
   * GET. See {@link PendingRequest.get}.
   *
   * @example
   * await http.get('https://example.com/status')
   */
  get(url: string, query?: QueryValues): Promise<HttpResponse> {
    return this.#pending().get(url, query)
  }

  /**
   * HEAD. See {@link PendingRequest.head}.
   *
   * @example
   * await http.head('https://example.com/file.zip')
   */
  head(url: string, query?: QueryValues): Promise<HttpResponse> {
    return this.#pending().head(url, query)
  }

  /**
   * POST. See {@link PendingRequest.post}.
   *
   * @example
   * await http.post('https://example.com/hooks', { event: 'paid' })
   */
  post(url: string, data?: unknown): Promise<HttpResponse> {
    return this.#pending().post(url, data)
  }

  /**
   * PUT. See {@link PendingRequest.put}.
   *
   * @example
   * await http.put('https://example.com/items/7', { name: 'x' })
   */
  put(url: string, data?: unknown): Promise<HttpResponse> {
    return this.#pending().put(url, data)
  }

  /**
   * PATCH. See {@link PendingRequest.patch}.
   *
   * @example
   * await http.patch('https://example.com/items/7', { name: 'x' })
   */
  patch(url: string, data?: unknown): Promise<HttpResponse> {
    return this.#pending().patch(url, data)
  }

  /**
   * DELETE. See {@link PendingRequest.delete}.
   *
   * @example
   * await http.delete('https://example.com/items/7')
   */
  delete(url: string, data?: unknown): Promise<HttpResponse> {
    return this.#pending().delete(url, data)
  }

  #pending(): PendingRequest {
    return new PendingRequest(this.#state, this.#defaults)
  }

  #describeSent(): string {
    const sent = this.#state.recorded.map((request) => `${request.method} ${request.url}`)
    return sent.length === 0 ? 'nothing' : sent.join(', ')
  }
}

/**
 * The container token for the app's HTTP client; the `Http` facade resolves it.
 *
 * @example
 * app.make(HttpClientToken).fake()
 */
export const HttpClientToken: Token<HttpClient> = token<HttpClient>('strutvane.http-client')

function bounded(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new BootError(
      'invalid_http_option',
      `${name} must be a whole number from ${min} to ${max} (got ${String(value)}).`,
      `Pass a value in range to ${name}().`,
    )
  return value
}

function withQuery(url: string, query: QueryValues | undefined): string {
  if (query === undefined) return url
  const parsed = parseFetchTarget(url)
  for (const [name, value] of Object.entries(query)) parsed.searchParams.append(name, String(value))
  return parsed.href
}

/** The body bytes and the headers that describe them. */
function encodeBody(
  settings: PendingRequestSettings,
  data: unknown,
): { readonly headers: Record<string, string>; readonly body: string | Uint8Array | undefined } {
  const headers: Record<string, string> = { ...settings.headers }
  if (data === undefined) return { headers, body: undefined }
  const setDefault = (value: string): void => {
    if (headers['content-type'] === undefined) headers['content-type'] = value
  }
  if (typeof data === 'string') {
    setDefault('text/plain; charset=utf-8')
    return { headers, body: data }
  }
  if (data instanceof Uint8Array) {
    setDefault('application/octet-stream')
    return { headers, body: data }
  }
  if (settings.form && typeof data === 'object' && data !== null) {
    setDefault('application/x-www-form-urlencoded')
    const form = new URLSearchParams()
    for (const [name, value] of Object.entries(data)) form.append(name, String(value))
    return { headers, body: form.toString() }
  }
  setDefault('application/json')
  return { headers, body: JSON.stringify(data) }
}

function record(
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string | Uint8Array | undefined,
): RecordedRequest {
  const text = body === undefined ? undefined : Buffer.from(body).toString('utf8')
  return Object.freeze({
    method,
    url,
    headers: new Headers(headers),
    body: text,
    json: () => parseJsonSafely(text ?? ''),
  })
}

/** The fake for a URL: the handler, or the first matching pattern in insertion order. */
function findFake(fakes: HttpFakes | undefined, url: URL): HttpFakeHandler | undefined {
  if (fakes === undefined) return undefined
  if (typeof fakes === 'function') return fakes
  const withoutScheme = `${url.host}${url.pathname}${url.search}`
  for (const [pattern, fake] of Object.entries(fakes)) {
    const subject = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) ? url.href : withoutScheme
    if (wildcard(pattern).test(subject)) return typeof fake === 'function' ? fake : () => fake
  }
  return undefined
}

function wildcard(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'i')
}

function stubResponse(stub: HttpFakeStub, url: string): HttpResponse {
  const headers = new Headers(stub.headers)
  const body =
    stub.body === undefined || stub.body === null
      ? Buffer.alloc(0)
      : typeof stub.body === 'string'
        ? Buffer.from(stub.body, 'utf8')
        : stub.body instanceof Uint8Array
          ? Buffer.from(stub.body)
          : Buffer.from(JSON.stringify(stub.body), 'utf8')
  if (
    stub.body !== undefined &&
    stub.body !== null &&
    typeof stub.body !== 'string' &&
    !(stub.body instanceof Uint8Array) &&
    !headers.has('content-type')
  )
    headers.set('content-type', 'application/json')
  return bufferedResponse(stub.status ?? 200, headers, url, body)
}
