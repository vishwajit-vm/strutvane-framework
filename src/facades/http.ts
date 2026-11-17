/**
 * The `Http` facade: the current app's SSRF-safe HTTP client (`security/http.ts`), Laravel's
 * `Http::`. `Http.fake()` and `Http.preventStrayRequests()` change the client bound in *this*
 * app's container only, so a fake in one test never leaks into another app.
 *
 * @module
 */
import {
  type HttpClient,
  HttpClientToken,
  type HttpFakes,
  type HttpResponse,
  type PendingRequest,
  type RecordedRequest,
} from '../security/http.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<HttpClient> = {
  facade: 'Http',
  token: HttpClientToken,
  provides: 'the HTTP client',
  install:
    'The app binds an HTTP client when it boots; bind your own with app.container.value(HttpClientToken, new HttpClient({ … })).',
}

/** Query values for `get`/`head`. */
type Query = Parameters<HttpClient['get']>[1]

/**
 * What the `Http` facade offers: the client's request builders, verbs, fakes and assertions.
 *
 * @example
 * const http: HttpFacade = Http
 */
export interface HttpFacade {
  /** Answer every request from `fakes` instead of the network (tests). */
  fake(fakes?: HttpFakes): HttpClient
  /** Fail any request that no fake answers (tests). */
  preventStrayRequests(prevent?: boolean): HttpClient
  /** The requests sent so far (while faking). */
  recorded(): readonly RecordedRequest[]
  /** Throw unless a sent request matches. */
  assertSent(predicate: (request: RecordedRequest) => boolean): void
  /** Throw if a sent request matches. */
  assertNotSent(predicate: (request: RecordedRequest) => boolean): void
  /** Throw if anything was sent. */
  assertNothingSent(): void
  /** Throw unless exactly `count` requests were sent. */
  assertSentCount(count: number): void
  /** A request with these headers. */
  withHeaders(headers: Readonly<Record<string, string>>): PendingRequest
  /** A request with an `Authorization` token. */
  withToken(value: string, type?: string): PendingRequest
  /** A request that accepts JSON. */
  acceptJson(): PendingRequest
  /** A request that sends its data as a form. */
  asForm(): PendingRequest
  /** A request with this timeout (ms). */
  timeout(ms: number): PendingRequest
  /** A request whose response may be at most `bytes` long. */
  maxBytes(bytes: number): PendingRequest
  /** A request that follows at most `count` redirects. */
  maxRedirects(count: number): PendingRequest
  /** A request allowed to reach these private hosts or ranges. */
  allow(entries: readonly string[]): PendingRequest
  /** `GET` a URL. */
  get(url: string, query?: Query): Promise<HttpResponse>
  /** `HEAD` a URL. */
  head(url: string, query?: Query): Promise<HttpResponse>
  /** `POST` data (JSON by default). */
  post(url: string, data?: unknown): Promise<HttpResponse>
  /** `PUT` data. */
  put(url: string, data?: unknown): Promise<HttpResponse>
  /** `PATCH` data. */
  patch(url: string, data?: unknown): Promise<HttpResponse>
  /** `DELETE` a URL. */
  delete(url: string, data?: unknown): Promise<HttpResponse>
  /** The client itself, for code that takes an `HttpClient`. */
  client(): HttpClient
}

/**
 * Call other services from the current app, with the SSRF guard, timeouts and size caps on.
 *
 * @example
 * const response = await Http.acceptJson().withToken(apiKey).get('https://api.example.com/rates')
 * // In a test:
 * Http.fake({ 'api.example.com/*': { status: 200, body: { rate: 1.1 } } }).preventStrayRequests()
 */
export const Http: HttpFacade = Object.freeze({
  fake: (fakes?: HttpFakes): HttpClient => resolveFacade(binding, 'fake').fake(fakes),
  preventStrayRequests: (prevent?: boolean): HttpClient =>
    resolveFacade(binding, 'preventStrayRequests').preventStrayRequests(prevent),
  recorded: (): readonly RecordedRequest[] => resolveFacade(binding, 'recorded').recorded(),
  assertSent: (predicate: (request: RecordedRequest) => boolean): void =>
    resolveFacade(binding, 'assertSent').assertSent(predicate),
  assertNotSent: (predicate: (request: RecordedRequest) => boolean): void =>
    resolveFacade(binding, 'assertNotSent').assertNotSent(predicate),
  assertNothingSent: (): void => resolveFacade(binding, 'assertNothingSent').assertNothingSent(),
  assertSentCount: (count: number): void =>
    resolveFacade(binding, 'assertSentCount').assertSentCount(count),
  withHeaders: (headers: Readonly<Record<string, string>>): PendingRequest =>
    resolveFacade(binding, 'withHeaders').withHeaders(headers),
  withToken: (value: string, type?: string): PendingRequest =>
    resolveFacade(binding, 'withToken').withToken(value, type),
  acceptJson: (): PendingRequest => resolveFacade(binding, 'acceptJson').acceptJson(),
  asForm: (): PendingRequest => resolveFacade(binding, 'asForm').asForm(),
  timeout: (ms: number): PendingRequest => resolveFacade(binding, 'timeout').timeout(ms),
  maxBytes: (bytes: number): PendingRequest => resolveFacade(binding, 'maxBytes').maxBytes(bytes),
  maxRedirects: (count: number): PendingRequest =>
    resolveFacade(binding, 'maxRedirects').maxRedirects(count),
  allow: (entries: readonly string[]): PendingRequest =>
    resolveFacade(binding, 'allow').allow(entries),
  get: (url: string, query?: Query): Promise<HttpResponse> =>
    resolveFacade(binding, 'get').get(url, query),
  head: (url: string, query?: Query): Promise<HttpResponse> =>
    resolveFacade(binding, 'head').head(url, query),
  post: (url: string, data?: unknown): Promise<HttpResponse> =>
    resolveFacade(binding, 'post').post(url, data),
  put: (url: string, data?: unknown): Promise<HttpResponse> =>
    resolveFacade(binding, 'put').put(url, data),
  patch: (url: string, data?: unknown): Promise<HttpResponse> =>
    resolveFacade(binding, 'patch').patch(url, data),
  delete: (url: string, data?: unknown): Promise<HttpResponse> =>
    resolveFacade(binding, 'delete').delete(url, data),
  client: (): HttpClient => resolveFacade(binding, 'client'),
})
