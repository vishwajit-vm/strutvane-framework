/**
 * The queue's error: a stable lowercase code (CONSISTENCY #68) plus a one-sentence fix-it hint,
 * like `BootError`. Queue errors are developer-facing (a bad payload at dispatch, a bad config,
 * a tampered row seen by the worker); they never render to an HTTP client as-is.
 *
 * @module
 */

/**
 * Every queue error code (RFC-0006).
 *
 * @example
 * const code: QueueErrorCode = 'queue_payload_not_plain'
 */
export type QueueErrorCode =
  | 'queue_payload_not_plain'
  | 'queue_payload_too_large'
  | 'queue_payload_sensitive'
  | 'queue_payload_tampered'
  | 'queue_payload_invalid'
  | 'queue_job_unknown'
  | 'queue_job_invalid'
  | 'queue_job_duplicate_name'
  | 'queue_job_timed_out'
  | 'queue_max_attempts_exceeded'
  | 'queue_job_failed'
  | 'queue_invalid_name'
  | 'queue_invalid_option'
  | 'queue_connection_unknown'
  | 'queue_driver_unknown'
  | 'queue_timeout_not_below_retry_after'
  | 'queue_no_application'
  | 'queue_not_configured'

/**
 * A queue error with a code and a hint.
 *
 * @example
 * throw new QueueError('queue_job_unknown', 'No job is called "x".', 'Register it in app/jobs.')
 */
export class QueueError extends Error {
  /** A stable, grep-able code such as `queue_payload_not_plain`. */
  readonly code: QueueErrorCode
  /** One sentence on how to fix it. */
  readonly hint: string

  constructor(code: QueueErrorCode, message: string, hint: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'QueueError'
    this.code = code
    this.hint = hint
  }

  /**
   * The message and the hint together, ready to print.
   *
   * @example
   * error.describe() // 'No job is called "x".\n  → Register it in app/jobs.'
   */
  describe(): string {
    return `${this.message}\n  → ${this.hint}`
  }
}

/**
 * Whether a value is a {@link QueueError} (also across module copies, by name and shape).
 *
 * @example
 * if (isQueueError(error) && error.code === 'queue_payload_tampered') …
 */
export function isQueueError(value: unknown): value is QueueError {
  return (
    value instanceof QueueError ||
    (value instanceof Error &&
      value.name === 'QueueError' &&
      typeof (value as { code?: unknown }).code === 'string' &&
      typeof (value as { hint?: unknown }).hint === 'string')
  )
}
