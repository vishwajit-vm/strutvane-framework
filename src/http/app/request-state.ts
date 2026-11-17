/**
 * What the HTTP kernel works out about a request *before* routing: the real client address and
 * scheme (after the trusted-proxy rules), the host, the CSP nonce for this response, the body
 * limits, the request id and locale, the effective method (after `_method` spoofing), and whether
 * a test asked to skip CSRF. Every `HttpContext` of the request shares it.
 *
 * **Why a separate object:** the global stages (hosts, maintenance, CORS, headers) run before the
 * router builds the route's context, and the nonce they create must be the same one a view puts
 * in its `<script nonce>`.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { type BodyLimits, DEFAULT_BODY_LIMITS } from '../../security/safe-json.ts'
import { createCspNonce } from '../../security/secure-headers.ts'

/**
 * The per-request facts shared by the kernel, middleware and views.
 *
 * @example
 * ctx.state.nonce // 'r4nd0m…', for <script nonce="…">
 */
export interface RequestState {
  /**
   * The client address: the socket peer, or the forwarded client when the peer is a trusted
   * proxy. `'unknown'` when the server could not tell (rate limits then share one bucket).
   */
  readonly ip: string
  /** `true` over HTTPS (directly, or `X-Forwarded-Proto: https` from a trusted proxy). */
  readonly secure: boolean
  /** The requested host name, lower case, without the port. */
  readonly host: string
  /** A fresh CSP nonce for this response. */
  readonly nonce: string
  /** Body limits (bytes, JSON depth, JSON keys). */
  readonly limits: BodyLimits
  /** Set only by the test client's `withoutCsrf()`, and only honoured when APP_ENV=testing. */
  readonly skipCsrf: boolean
  /** The request id (also sent back as `X-Request-Id`). */
  readonly requestId: string
  /** The negotiated locale for messages. */
  readonly locale: string
  /** The method routing uses: the real one, or the `_method` a form spoofed (PUT/PATCH/DELETE). */
  readonly method: string
  /** The API prefix (`/api`), so `wantsJson()` knows API paths. */
  readonly apiPrefix: string
}

/**
 * A request state straight from the request, trusting no proxy headers. The kernel builds the real
 * one from the app's settings; tests and helpers that build a context by hand use this.
 *
 * @example
 * const state = plainRequestState(new Request('https://blog.test/'), '203.0.113.7')
 */
export function plainRequestState(request: Request, ip = 'unknown'): RequestState {
  const url = new URL(request.url)
  return {
    ip,
    secure: url.protocol === 'https:',
    host: url.hostname.toLowerCase(),
    nonce: createCspNonce(),
    limits: DEFAULT_BODY_LIMITS,
    skipCsrf: false,
    requestId: randomUUID(),
    locale: 'en',
    method: request.method.toUpperCase(),
    apiPrefix: '/api',
  }
}
