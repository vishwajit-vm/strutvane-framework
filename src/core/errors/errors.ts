/**
 * Strutvane's error classes (RFC-0003 §3).
 *
 * **Why classes with stable codes?** Every error a client can see is turned into a `Problem` by
 * one central handler. Code throws `new NotFoundError('invoice')`; the handler looks up the
 * status, the title and the message by `code`. Wording and translations live in message catalogs,
 * not scattered through business logic. Any other error (a bug, a driver failure) becomes a
 * generic 500 with no internal details exposed.
 *
 * @module
 */
import type { IssueParam } from '@strutvane/contracts'

/** Parameters rendered into messages. Primitives only (no objects that could carry secrets). */
export type ErrorParams = Readonly<Record<string, IssueParam>>

/** Options shared by every Strutvane error. */
export interface StrutvaneErrorOptions {
  /** HTTP status. Defaults to the status registered for the code (see the error registry). */
  readonly status?: number
  readonly params?: ErrorParams
  /** The underlying error (kept for logs, never sent to clients). */
  readonly cause?: unknown
  /** HTTP headers to send with the response, e.g. `Retry-After`. */
  readonly headers?: Readonly<Record<string, string>>
}

/** Base class for every error that maps to a known problem code. */
export class StrutvaneError extends Error {
  /** Stable machine-readable code (`SCREAMING_SNAKE_CASE`). */
  readonly code: string
  /** Explicit status, or `undefined` to use the registered one. */
  readonly status: number | undefined
  readonly params: ErrorParams
  readonly headers: Readonly<Record<string, string>>

  constructor(code: string, options: StrutvaneErrorOptions = {}) {
    // The developer-facing message names the code and params; clients get catalog messages.
    const params = options.params ?? {}
    const detail = Object.keys(params).length > 0 ? ` ${JSON.stringify(params)}` : ''
    super(`${code}${detail}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.code = code
    this.status = options.status
    this.params = Object.freeze({ ...params })
    this.headers = Object.freeze({ ...options.headers })
  }
}

/** One validation problem as thrown by code. `message` is optional: the catalog renders it. */
export interface IssueInput {
  readonly path: readonly (string | number)[]
  readonly code: string
  readonly params?: ErrorParams
  /** An already-rendered message. Usually omitted so the message catalog is used. */
  readonly message?: string
}

/** Invalid input: one or more field (or form-level) issues. 422. */
export class ValidationError extends StrutvaneError {
  readonly issues: readonly IssueInput[]
  constructor(issues: readonly IssueInput[], options: Omit<StrutvaneErrorOptions, 'params'> = {}) {
    if (issues.length === 0) throw new TypeError('ValidationError needs at least one issue')
    super('VALIDATION_FAILED', { status: 422, ...options })
    this.issues = Object.freeze(
      issues.map((i) => Object.freeze({ ...i, path: Object.freeze([...i.path]) })),
    )
  }
}

/** A business rule was violated, e.g. `INVOICE_ALREADY_PAID`. Default 422. */
export class DomainError extends StrutvaneError {
  constructor(
    code: string,
    params?: ErrorParams,
    options: Omit<StrutvaneErrorOptions, 'params'> = {},
  ) {
    super(code, { status: 422, ...options, ...(params ? { params } : {}) })
  }
}

/** The resource doesn't exist, or the actor may not know it exists. 404. */
export class NotFoundError extends StrutvaneError {
  constructor(resource?: string, options: Omit<StrutvaneErrorOptions, 'params'> = {}) {
    super('NOT_FOUND', { status: 404, ...options, ...(resource ? { params: { resource } } : {}) })
  }
}

/** Authenticated, but not allowed. 403. */
export class ForbiddenError extends StrutvaneError {
  constructor(options: Omit<StrutvaneErrorOptions, 'params'> = {}) {
    super('FORBIDDEN', { status: 403, ...options })
  }
}

/** Not signed in, or the session expired. 401. */
export class UnauthenticatedError extends StrutvaneError {
  constructor(options: Omit<StrutvaneErrorOptions, 'params'> = {}) {
    super('UNAUTHENTICATED', { status: 401, ...options })
  }
}

/** A state conflict. Use code `STALE_RECORD` for optimistic-locking failures. 409. */
export class ConflictError extends StrutvaneError {
  constructor(
    code = 'CONFLICT',
    params?: ErrorParams,
    options: Omit<StrutvaneErrorOptions, 'params'> = {},
  ) {
    super(code, { status: 409, ...options, ...(params ? { params } : {}) })
  }
}

function retryHeaders(seconds: number | undefined): Readonly<Record<string, string>> | undefined {
  if (seconds === undefined) return undefined
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new RangeError('retryAfterSeconds must be >= 0')
  return { 'Retry-After': String(Math.ceil(seconds)) }
}

/** Too many requests. 429, with `Retry-After` when known. */
export class RateLimitedError extends StrutvaneError {
  constructor(
    retryAfterSeconds?: number,
    options: Omit<StrutvaneErrorOptions, 'params' | 'headers'> = {},
  ) {
    const headers = retryHeaders(retryAfterSeconds)
    super('RATE_LIMITED', { status: 429, ...options, ...(headers ? { headers } : {}) })
  }
}

/** A dependency is down (database, storage, email). 503, with `Retry-After` when known. */
export class ServiceUnavailableError extends StrutvaneError {
  constructor(
    retryAfterSeconds?: number,
    options: Omit<StrutvaneErrorOptions, 'params' | 'headers'> = {},
  ) {
    const headers = retryHeaders(retryAfterSeconds)
    super('SERVICE_UNAVAILABLE', { status: 503, ...options, ...(headers ? { headers } : {}) })
  }
}
