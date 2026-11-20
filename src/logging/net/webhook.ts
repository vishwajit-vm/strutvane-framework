/**
 * The `slack` channel's HTTPS POST (ADR-0022 §2), on top of the framework's SSRF-safe client
 * (`security/http-client.ts`, `safeFetch`): one guard for every outgoing request the framework
 * makes, so a fix there protects the log channel too.
 *
 * A webhook URL comes from configuration, so it can be wrong or hostile: `http://`, a credential
 * in the URL, `localhost`, a cloud metadata address (`169.254.169.254`), or a public name that
 * resolves to an internal address (DNS rebinding). Each would turn the logger into a way to reach
 * internal services. On top of `safeFetch` (resolve once, check every address, connect to the
 * checked one, refuse private, loopback, link-local, metadata and other special ranges), this:
 *
 * - accepts only `https:` URLs without user info (`safeFetch` alone would also take `http:`);
 * - never follows a redirect (a webhook that redirects is misconfigured, and a redirect is the
 *   classic way past an allow check);
 * - caps the time of the whole exchange **including DNS resolution**, so a resolver that never
 *   answers can't hold the channel's sink (audit 2026-11-15);
 * - reads at most 64 KiB of the answer, and needs a 2xx.
 *
 * It throws on refusal or failure; the caller (a log sink) turns that into its stderr fallback.
 *
 * @module
 */
import {
  HttpClientError,
  type Resolver,
  type SafeFetchOptions,
  type SafeResponse,
  safeFetch,
} from '../../security/http-client.ts'

/** Options for {@link postWebhook}. */
export interface WebhookPostOptions {
  /** Deadline for the whole exchange, DNS included. Default: 5,000 ms. */
  readonly timeoutMs?: number
  /** DNS resolution. Default: the OS resolver. */
  readonly resolver?: Resolver
  /**
   * Ranges or hosts deliberately allowed despite the SSRF guard (`safeFetch`'s `allow`). Empty by
   * default; only tests and a self-hosted, internal chat server need it.
   */
  readonly allow?: readonly string[]
  /** For tests only: the client. Default: `safeFetch`. */
  readonly fetch?: (url: string, options: SafeFetchOptions) => Promise<SafeResponse>
}

/** The largest webhook answer read: Slack answers `ok`. */
const MAX_ANSWER_BYTES = 64 * 1024

/**
 * Check a webhook URL before anything is sent: `https:` only, no credentials. The address checks
 * happen when sending (they need DNS).
 *
 * @throws HttpClientError (`invalid_url`) with a message that says what to fix
 *
 * @example
 * checkWebhookUrl('http://hooks.slack.com/x') // throws: only https:// webhook URLs are allowed
 */
export function checkWebhookUrl(value: string): URL {
  if (!URL.canParse(value))
    throw new HttpClientError('invalid_url', 'The webhook URL is not a valid URL.')
  const url = new URL(value)
  if (url.protocol !== 'https:')
    throw new HttpClientError('invalid_url', 'Only https:// webhook URLs are allowed.')
  if (url.username !== '' || url.password !== '')
    throw new HttpClientError('invalid_url', 'Credentials in the webhook URL are not allowed.')
  return url
}

/** Settle with `work`, or reject with `error()` once `ms` have passed (whichever comes first). */
function withDeadline<T>(work: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms)
    timer.unref()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason: unknown) => {
        clearTimeout(timer)
        reject(reason)
      },
    )
  })
}

/**
 * POST a JSON `body` to a webhook safely (see the module notes). Resolves when the server answered
 * 2xx.
 *
 * @throws HttpClientError for a refused URL or address (`invalid_url`, `ssrf_blocked`), a timeout
 *   or a network failure; `Error` for a non-2xx answer
 *
 * @example
 * await postWebhook(webhookUrl, JSON.stringify({ text: 'Payment failed' }))
 */
export async function postWebhook(
  url: string,
  body: string,
  options: WebhookPostOptions = {},
): Promise<void> {
  const target = checkWebhookUrl(url)
  const timeoutMs = options.timeoutMs ?? 5_000
  const send = options.fetch ?? safeFetch
  const answer = await withDeadline(
    send(target.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs,
      maxBytes: MAX_ANSWER_BYTES,
      maxRedirects: 0,
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.allow === undefined ? {} : { allow: options.allow }),
    }),
    timeoutMs,
    () => new HttpClientError('timeout', `The webhook timed out after ${timeoutMs} ms.`),
  )
  if (!answer.ok) throw new Error(`The webhook answered HTTP ${answer.status}.`)
}
