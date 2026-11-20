/**
 * The exception handler: Laravel's `withExceptions(...)`. It decides, for anything thrown while
 * handling a request, what to log and what to send.
 *
 * | Error | Logged | Sent |
 * |---|---|---|
 * | `StrutvaneError` 4xx (401, 403, 404, 422, 429…) | no (expected) | its problem+json |
 * | `StrutvaneError` 5xx (`ServiceUnavailableError`…) | yes | its problem+json |
 * | anything else, debug (APP_DEBUG + local/testing) | yes | the debug page, or problem+json with a `debug` member for JSON clients |
 * | anything else, otherwise (production) | yes | a plain 500 problem whose `traceId` is the reference |
 *
 * **One problem shape.** Every default response is an RFC 9457 problem built by the framework's
 * one pipeline (`http/errors.ts`: `normalizeError` → `toProblemBody` → `problemResponse`), with
 * catalog wording. The reference a user quotes is the request id: the problem's `traceId`, the
 * `X-Request-Id` header and the `traceId` field of the log line are the same value.
 *
 * **A `BootError`** (a developer mistake found while serving) is a plain 500 for clients; the
 * debug page shows its message and hint.
 *
 * @module
 */
import type { Logger } from '../contracts/logger.ts'
import type { Problem } from '../contracts/problem.ts'
import { StrutvaneError } from '../core/errors/errors.ts'
import type { ErrorRegistry } from '../core/errors/registry.ts'
import type { Messages } from '../core/messages/catalog.ts'
import { isBootError } from '../foundation/boot-error.ts'
import {
  type ExceptionRenderer,
  type ExceptionRequestInfo,
  ResponseError,
} from '../http/app/errors.ts'
import { normalizeError, problemResponse, toProblemBody } from '../http/errors.ts'
import { stackFrames } from './code-frame.ts'
import { debugMember, renderDebugPage } from './debug-page.ts'
import { buildReport } from './error-report.ts'

/** 5xx codes the app answers on purpose; never reported as errors. */
const EXPECTED_SERVER_STATES: ReadonlySet<string> = new Set(['maintenance_mode'])

/**
 * A class of errors, for `dontReport`, `report(Class, …)` and `render(Class, …)`.
 *
 * @example
 * const type: ErrorClass<PaymentDeclined> = PaymentDeclined
 */
export type ErrorClass<TError extends Error = Error> = abstract new (...args: never[]) => TError

/**
 * A custom reporter. Return `false` to stop the default logging (and later reporters).
 *
 * @example
 * const reporter: ExceptionReporter = (error) => tracker.capture(error)
 */
export type ExceptionReporter<TError = unknown> = (
  error: TError,
  info: ExceptionRequestInfo | undefined,
) => unknown

/**
 * A custom renderer. Return a `Response` to answer, or `undefined` to let the default answer.
 *
 * @example
 * const renderer: ExceptionRenderCallback = (error) => (error instanceof Gone ? new Response(null, { status: 410 }) : undefined)
 */
export type ExceptionRenderCallback<TError = unknown> = (
  error: TError,
  info: ExceptionRequestInfo,
) => Response | undefined | Promise<Response | undefined>

/**
 * How report throttling behaves.
 *
 * @example
 * e.throttle({ windowSeconds: 60 })
 */
export interface ThrottleOptions {
  /** Identical reports (same class, message and first app frame) within this window log once. Default 60. */
  readonly windowSeconds?: number
}

interface Entry<TCallback> {
  readonly type: ErrorClass | undefined
  readonly callback: TCallback
}

/**
 * The object handed to `withExceptions((exceptions) => …)` in `bootstrap/app.ts`.
 *
 * @example
 * .withExceptions((exceptions) => {
 *   exceptions.dontReport(PaymentDeclined)
 *   exceptions.report(PaymentFailed, (error) => tracker.capture(error))
 *   exceptions.render(PaymentDeclined, () => Response.json({ declined: true }, { status: 402 }))
 *   exceptions.throttle({ windowSeconds: 60 })
 * })
 */
export class ExceptionsConfig {
  readonly #dontReport: ErrorClass[] = []
  readonly #reporters: Entry<ExceptionReporter>[] = []
  readonly #renderers: Entry<ExceptionRenderCallback>[] = []
  #json: ((info: ExceptionRequestInfo) => boolean) | undefined
  #throttleMs: number | undefined

  /**
   * Never report errors of these classes (they are expected, like a declined payment).
   *
   * @example
   * e.dontReport(PaymentDeclined, CardExpired)
   */
  dontReport(...classes: ErrorClass[]): this {
    this.#dontReport.push(...classes)
    return this
  }

  /**
   * Report errors yourself (send them to a tracker): every reportable error, or only one class.
   * Return `false` to stop the default logging. A reporter that throws is logged and skipped.
   *
   * @example
   * e.report((error) => tracker.capture(error))
   * e.report(PaymentFailed, (error) => billing.alert(error.invoiceId))
   */
  report(reporter: ExceptionReporter): this
  report<TError extends Error>(type: ErrorClass<TError>, reporter: ExceptionReporter<TError>): this
  report(
    typeOrReporter: ErrorClass | ExceptionReporter,
    reporter?: ExceptionReporter<never>,
  ): this {
    this.#reporters.push(entry(typeOrReporter, reporter))
    return this
  }

  /**
   * Render errors yourself: any error, or only one class. Return `undefined` to let the default
   * renderer answer. A renderer that throws is logged and the default renderer answers.
   *
   * @example
   * e.render(PaymentDeclined, () => Response.json({ declined: true }, { status: 402 }))
   * e.render((error) => (error instanceof Gone ? new Response(null, { status: 410 }) : undefined))
   */
  render(renderer: ExceptionRenderCallback): this
  render<TError extends Error>(
    type: ErrorClass<TError>,
    renderer: ExceptionRenderCallback<TError>,
  ): this
  render(
    typeOrRenderer: ErrorClass | ExceptionRenderCallback,
    renderer?: ExceptionRenderCallback<never>,
  ): this {
    this.#renderers.push(entry(typeOrRenderer, renderer))
    return this
  }

  /**
   * Decide when errors render as JSON. Default: when the client wants JSON (`/api` paths or an
   * `Accept` naming JSON).
   *
   * @example
   * e.shouldRenderJsonWhen((info) => new URL(info.request.url).pathname.startsWith('/hooks/'))
   */
  shouldRenderJsonWhen(predicate: (info: ExceptionRequestInfo) => boolean): this {
    this.#json = predicate
    return this
  }

  /**
   * Log identical reports (same class, message and first app frame) at most once per window, so
   * one bug hit by every request doesn't flood the log. The next report after the window says how
   * many were suppressed. (The same error *object* is never reported twice for one request,
   * throttled or not.)
   *
   * @example
   * e.throttle({ windowSeconds: 60 })
   */
  throttle(options: ThrottleOptions = {}): this {
    const seconds = options.windowSeconds ?? 60
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new RangeError('throttle({ windowSeconds }) must be a positive number of seconds.')
    this.#throttleMs = seconds * 1000
    return this
  }

  /** @internal The collected settings, for the handler. */
  get collected(): CollectedExceptions {
    return {
      dontReport: this.#dontReport,
      reporters: this.#reporters,
      renderers: this.#renderers,
      json: this.#json,
      throttleMs: this.#throttleMs,
    }
  }
}

/** @internal What {@link ExceptionsConfig} collected. */
interface CollectedExceptions {
  readonly dontReport: readonly ErrorClass[]
  readonly reporters: readonly Entry<ExceptionReporter>[]
  readonly renderers: readonly Entry<ExceptionRenderCallback>[]
  readonly json: ((info: ExceptionRequestInfo) => boolean) | undefined
  readonly throttleMs: number | undefined
}

/**
 * What the handler needs from the application.
 *
 * @example
 * new ExceptionHandler(config, { showDetails, environment, basePath, logger, messages, errors, now: () => clock.now() })
 */
export interface ExceptionHandlerOptions {
  /** APP_DEBUG=true. The page also needs `environment` local or testing; production never shows it. */
  readonly showDetails: boolean
  readonly environment: string
  /** The app root: only files inside it are quoted on the debug page. */
  readonly basePath: string
  readonly logger: Logger
  readonly messages: Messages
  readonly errors: ErrorRegistry
  /** The clock for throttling, in ms. Default `Date.now`. */
  readonly now?: () => number
  /** The framework's source folder, for tests. Default: this package's `src/` or `dist/`. */
  readonly frameworkRoot?: string
}

/** Most distinct throttle keys remembered: one bug per key, bounded against key flooding. */
const MAX_THROTTLE_KEYS = 500
const DEBUG_ENVIRONMENTS: ReadonlySet<string> = new Set(['local', 'testing'])

/**
 * Reports and renders errors. The application builds one at boot from the app's
 * {@link ExceptionsConfig} and binds it to `ExceptionHandlerToken`.
 *
 * @example
 * const response = await handler.render(error, info)
 */
export class ExceptionHandler implements ExceptionRenderer {
  readonly #settings: CollectedExceptions
  readonly #options: ExceptionHandlerOptions
  /** Error objects already reported, with the request they were reported for. */
  readonly #reported = new WeakMap<object, string>()
  readonly #throttled = new Map<string, { until: number; suppressed: number }>()

  constructor(config: ExceptionsConfig, options: ExceptionHandlerOptions) {
    this.#settings = config.collected
    this.#options = options
  }

  /** Whether the debug page (or `debug` member) may be shown: APP_DEBUG *and* local or testing. */
  get showsDetails(): boolean {
    return this.#options.showDetails && DEBUG_ENVIRONMENTS.has(this.#options.environment)
  }

  /**
   * Whether an error would be reported: not an early response, not `dontReport`ed, and not an
   * expected client error (status below 500).
   *
   * @example
   * handler.shouldReport(new NotFoundError()) // false
   */
  shouldReport(error: unknown): boolean {
    if (error instanceof ResponseError) return false
    if (this.#settings.dontReport.some((type) => error instanceof type)) return false
    // A 503 the app answers on purpose (`node strut down`) is a state, not a fault: logging each
    // one as an error with a stack buried real errors during every deploy (acceptance FW-9).
    if (error instanceof StrutvaneError && EXPECTED_SERVER_STATES.has(error.code)) return false
    return this.#status(error) >= 500
  }

  /**
   * Report an error: the custom reporters, then the Logger (unless a reporter returned `false`).
   * `info` is the request it happened in, when there is one. Never throws.
   *
   * @example
   * handler.report(error, info)
   */
  report(error: unknown, info?: ExceptionRequestInfo): void {
    if (!this.shouldReport(error)) return
    if (typeof error === 'object' && error !== null) {
      // `report(error)` in a controller followed by `throw error` logs once for that request.
      const request = info?.requestId ?? ''
      if (this.#reported.get(error) === request) return
      this.#reported.set(error, request)
    }
    const suppressed = this.#throttle(error)
    if (suppressed === undefined) return
    for (const { type, callback } of this.#settings.reporters) {
      if (type !== undefined && !(error instanceof type)) continue
      try {
        if (callback(error, info) === false) return
      } catch (failure) {
        this.#options.logger.error('An exception reporter failed', { error: describe(failure) })
      }
    }
    const fields: Record<string, unknown> = {
      ...(info === undefined
        ? {}
        : {
            traceId: info.requestId,
            method: info.request.method,
            path: safePathname(info.request.url),
            ...(info.route === undefined
              ? {}
              : { route: info.route.uri, action: info.route.action }),
          }),
      ...(suppressed > 0 ? { suppressed } : {}),
      error: describe(error),
    }
    this.#options.logger.error(
      info === undefined ? 'Unhandled error' : 'Unhandled error while serving a request',
      fields,
    )
  }

  /**
   * Turn an error into a response: an early `ResponseError` as is, else report it, then the first
   * custom renderer that answers, else the default problem (or the debug page).
   *
   * @example
   * return await handler.render(new NotFoundError('post'), info)
   */
  async render(error: unknown, info: ExceptionRequestInfo): Promise<Response> {
    if (error instanceof ResponseError) return error.response
    this.report(error, info)
    for (const { type, callback } of this.#settings.renderers) {
      if (type !== undefined && !(error instanceof type)) continue
      try {
        const answer = await callback(error, info)
        if (answer instanceof Response) return answer
      } catch (failure) {
        this.#options.logger.error('An exception renderer failed', {
          traceId: info.requestId,
          error: describe(failure),
        })
      }
    }
    return this.#renderDefault(error, info)
  }

  #renderDefault(error: unknown, info: ExceptionRequestInfo): Response {
    const normalized = normalizeError(error)
    const problem = toProblemBody(normalized, {
      messages: this.#options.messages,
      registry: this.#options.errors,
      locale: info.locale,
      traceId: info.requestId,
      instance: safePathname(info.request.url),
    })
    if (!(normalized instanceof StrutvaneError) && this.showsDetails) {
      try {
        return this.#renderDebug(error, normalized, problem, info)
      } catch (failure) {
        // Fail closed: a bug in the debug page must never hide the error or leak more.
        this.#options.logger.error('The debug page failed; answering with the plain problem', {
          traceId: info.requestId,
          error: describe(failure),
        })
      }
    }
    const response = problemResponse(problem, normalized)
    response.headers.set('X-Request-Id', info.requestId)
    return response
  }

  #renderDebug(
    error: unknown,
    normalized: unknown,
    problem: Problem,
    info: ExceptionRequestInfo,
  ): Response {
    const report = buildReport(error, info, {
      basePath: this.#options.basePath,
      environment: this.#options.environment,
      ...(this.#options.frameworkRoot === undefined
        ? {}
        : { frameworkRoot: this.#options.frameworkRoot }),
    })
    if (!this.#wantsJson(info)) {
      const page = renderDebugPage(report, info.nonce)
      return new Response(page.html, {
        status: problem.status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': page.csp,
          'cache-control': 'no-store',
          'x-request-id': info.requestId,
        },
      })
    }
    const response = problemResponse({ ...problem, debug: debugMember(report) }, normalized)
    response.headers.set('cache-control', 'no-store')
    response.headers.set('X-Request-Id', info.requestId)
    return response
  }

  #wantsJson(info: ExceptionRequestInfo): boolean {
    const predicate = this.#settings.json
    if (predicate === undefined) return info.wantsJson
    try {
      return predicate(info)
    } catch (failure) {
      this.#options.logger.error('shouldRenderJsonWhen() failed; answering with JSON', {
        error: describe(failure),
      })
      return true
    }
  }

  #status(error: unknown): number {
    const normalized = normalizeError(error)
    if (normalized instanceof StrutvaneError)
      return normalized.status ?? this.#options.errors.get(normalized.code)?.status ?? 500
    return 500
  }

  /** `undefined` to drop this report, else how many identical reports were dropped before it. */
  #throttle(error: unknown): number | undefined {
    const windowMs = this.#settings.throttleMs
    if (windowMs === undefined) return 0
    const now = (this.#options.now ?? Date.now)()
    const key = throttleKey(error)
    const seen = this.#throttled.get(key)
    if (seen !== undefined && now < seen.until) {
      seen.suppressed += 1
      return undefined
    }
    this.#throttled.delete(key)
    if (this.#throttled.size >= MAX_THROTTLE_KEYS) {
      const oldest = this.#throttled.keys().next()
      if (oldest.done !== true) this.#throttled.delete(oldest.value)
    }
    this.#throttled.set(key, { until: now + windowMs, suppressed: 0 })
    return seen?.suppressed ?? 0
  }
}

function entry<TCallback>(
  typeOrCallback: ErrorClass | TCallback,
  callback: unknown,
): Entry<TCallback> {
  // Two arguments: `(Class, callback)`. One: a callback for every error. Both are functions at
  // runtime, so the argument count decides, never the shape.
  if (callback === undefined) return { type: undefined, callback: typeOrCallback as TCallback }
  if (typeof callback !== 'function')
    throw new TypeError('withExceptions(): the second argument must be a function.')
  return { type: typeOrCallback as ErrorClass, callback: callback as TCallback }
}

function throttleKey(error: unknown): string {
  if (!(error instanceof Error)) return `${typeof error}:${String(error).slice(0, 200)}`
  const first = stackFrames(error)[0]
  const at = first === undefined ? '' : `${first.file}:${first.line}`
  return `${error.name}:${error.message.slice(0, 200)}:${at}`
}

/** The request path without the query string (queries can carry tokens). */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return '/'
  }
}

/** An error as plain fields for the log (stack included: logs are for developers). */
function describe(error: unknown): Record<string, string> {
  if (error instanceof Error)
    return {
      name: error.name,
      message: error.message,
      ...(isBootError(error) ? { hint: error.hint, code: error.code } : {}),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  return { name: typeof error, message: String(error) }
}
