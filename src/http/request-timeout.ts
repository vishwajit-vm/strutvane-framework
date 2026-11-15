/**
 * The request timeout: an upper bound on how long the app may take to produce a response.
 *
 * Without it, one handler, hook or middleware that never settles (a dependency that stopped
 * answering, a lost promise) holds the client and its socket for as long as the process lives;
 * enough of them exhaust sockets and memory. After the limit the client gets a 503
 * `SERVICE_UNAVAILABLE` problem (it may retry), and the late outcome of the abandoned work is
 * swallowed, so it can never surface as an unhandled rejection.
 *
 * It bounds the time to the response *headers*: a streamed body (a download, server-sent events,
 * a log tail) is not cut once it has started.
 *
 * @module
 */
import type { MiddlewareHandler } from 'hono'
import { StrutvaneError } from '../core/index.ts'

/** Default request timeout (ms): long enough for slow reports, short enough to free stuck sockets. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Default for routes that raise `bodyLimit` (uploads): the multipart parser's own total deadline
 * (120 s) plus time for the handler, so a slow but progressing upload is never cut short here.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 130_000

/** Validate a timeout option (`0` disables the limit). */
export function assertRequestTimeout(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0)
    throw new RangeError('requestTimeoutMs must be a non-negative number (0 disables it)')
}

/** Middleware that answers 503 when the rest of the chain takes longer than `ms`. */
export function requestTimeout(ms: number): MiddlewareHandler {
  assertRequestTimeout(ms)
  return async (_c, next) => {
    if (ms === 0) return next()
    const work = next()
    // The abandoned chain may still fail later; that outcome has no one left to tell.
    work.catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new StrutvaneError('SERVICE_UNAVAILABLE', { status: 503 })),
            ms,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
