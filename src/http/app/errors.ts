/**
 * How the HTTP kernel turns anything thrown into a response, behind one small interface
 * ({@link ExceptionRenderer}) so the full exception handler (`src/exceptions/handler.ts`, with
 * Laravel's `withExceptions` API and the developer error page) plugs in with one line.
 *
 * Until then {@link createProblemRenderer} renders every error as RFC 9457 problem+json through
 * the framework's one problem pipeline (`http/errors.ts`: `normalizeError`, `toProblemBody`,
 * `problemResponse`), reports 5xx errors through the Logger, and adds debug details only when
 * `APP_DEBUG=true` *and* `APP_ENV` is `local` or `testing`.
 *
 * @module
 */
import type { Logger } from '../../contracts/logger.ts'
import { StrutvaneError } from '../../core/errors/errors.ts'
import type { ErrorRegistry } from '../../core/errors/registry.ts'
import type { Messages } from '../../core/messages/catalog.ts'
import { isBootError } from '../../foundation/boot-error.ts'
import { normalizeError, problemResponse, toProblemBody } from '../errors.ts'

/**
 * Carries a ready response out of deep code, for imperative checks such as `csrf.verify(ctx)`
 * whose middleware answered with a response (a redirect, a replay) instead of throwing. The
 * renderer sends `response` unchanged.
 *
 * @example
 * throw new ResponseError(new Response(null, { status: 302, headers: { location: '/login' } }))
 */
export class ResponseError extends Error {
  /** The response to send. */
  readonly response: Response

  constructor(response: Response) {
    super(`Responded early with status ${response.status}.`)
    this.name = 'ResponseError'
    this.response = response
  }
}

/**
 * What the renderer knows about the failed request (the shape the exception handler takes).
 *
 * @example
 * const info: ExceptionRequestInfo = { request, nonce, requestId, locale: 'en', wantsJson: true }
 */
export interface ExceptionRequestInfo {
  readonly request: Request
  readonly nonce: string
  readonly requestId: string
  readonly locale: string
  readonly route?: { readonly name?: string; readonly uri: string; readonly action: string }
  readonly wantsJson: boolean
}

/**
 * Reports and renders errors. The full exception handler implements it.
 *
 * @example
 * const response = await renderer.render(error, info)
 */
export interface ExceptionRenderer {
  report(error: unknown, info: ExceptionRequestInfo): void
  render(error: unknown, info: ExceptionRequestInfo): Promise<Response>
}

/** A class of errors, for `dontReport`. */
type ErrorClass = abstract new (...args: never[]) => Error

/**
 * The `withExceptions((exceptions) => …)` settings the problem renderer understands: Laravel's
 * `dontReport`, `report`, `render` and `shouldRenderJsonWhen`.
 *
 * @example
 * .withExceptions((e) => e.dontReport(PaymentDeclined).render((error) => error instanceof Gone ? new Response(null, { status: 410 }) : undefined))
 */
export class ExceptionSettings {
  readonly #dontReport: ErrorClass[] = []
  readonly #reporters: ((error: unknown, info: ExceptionRequestInfo) => unknown)[] = []
  readonly #renderers: ((
    error: unknown,
    info: ExceptionRequestInfo,
  ) => Response | undefined | Promise<Response | undefined>)[] = []
  #json: ((info: ExceptionRequestInfo) => boolean) | undefined

  /**
   * Never report errors of these classes (they are expected, like a declined payment).
   *
   * @example
   * e.dontReport(PaymentDeclined)
   */
  dontReport(...classes: ErrorClass[]): this {
    this.#dontReport.push(...classes)
    return this
  }

  /**
   * Report errors yourself (send them to a tracker). Return `false` to stop the default logging.
   *
   * @example
   * e.report((error) => tracker.capture(error))
   */
  report(reporter: (error: unknown, info: ExceptionRequestInfo) => unknown): this {
    this.#reporters.push(reporter)
    return this
  }

  /**
   * Render some errors yourself; return `undefined` to let the default renderer answer.
   *
   * @example
   * e.render((error) => (error instanceof Gone ? new Response(null, { status: 410 }) : undefined))
   */
  render(
    renderer: (
      error: unknown,
      info: ExceptionRequestInfo,
    ) => Response | undefined | Promise<Response | undefined>,
  ): this {
    this.#renderers.push(renderer)
    return this
  }

  /**
   * Decide when errors render as JSON (the default: when the client wants JSON).
   *
   * @example
   * e.shouldRenderJsonWhen((info) => info.request.url.includes('/api/'))
   */
  shouldRenderJsonWhen(predicate: (info: ExceptionRequestInfo) => boolean): this {
    this.#json = predicate
    return this
  }

  /** @internal The collected settings, for the renderer. */
  get collected(): {
    readonly dontReport: readonly ErrorClass[]
    readonly reporters: readonly ((error: unknown, info: ExceptionRequestInfo) => unknown)[]
    readonly renderers: readonly ((
      error: unknown,
      info: ExceptionRequestInfo,
    ) => Response | undefined | Promise<Response | undefined>)[]
    readonly json: ((info: ExceptionRequestInfo) => boolean) | undefined
  } {
    return {
      dontReport: this.#dontReport,
      reporters: this.#reporters,
      renderers: this.#renderers,
      json: this.#json,
    }
  }
}

/**
 * What the problem renderer needs.
 *
 * @example
 * createProblemRenderer(settings, { showDetails: false, logger, messages, errors })
 */
export interface ProblemRendererOptions {
  /** Debug details in the body: `APP_DEBUG=true` and `APP_ENV` local or testing only. */
  readonly showDetails: boolean
  readonly logger: Logger
  readonly messages: Messages
  readonly errors: ErrorRegistry
}

/**
 * The default renderer: problem+json for everything, 5xx reported through the Logger.
 *
 * @example
 * const renderer = createProblemRenderer(new ExceptionSettings(), { showDetails, logger, messages, errors })
 */
export function createProblemRenderer(
  settings: ExceptionSettings,
  options: ProblemRendererOptions,
): ExceptionRenderer {
  const { dontReport, reporters, renderers } = settings.collected
  const renderer: ExceptionRenderer = {
    report(error, info) {
      if (error instanceof ResponseError) return
      if (dontReport.some((errorClass) => error instanceof errorClass)) return
      const status = statusOf(error, options.errors)
      if (status < 500) return
      for (const reporter of reporters) {
        try {
          if (reporter(error, info) === false) return
        } catch (failure) {
          options.logger.error('An exception reporter failed', { error: describe(failure) })
        }
      }
      options.logger.error('Unhandled error while serving a request', {
        traceId: info.requestId,
        method: info.request.method,
        path: new URL(info.request.url).pathname,
        ...(info.route === undefined ? {} : { route: info.route.uri, action: info.route.action }),
        error: describe(error),
      })
    },
    async render(error, info) {
      renderer.report(error, info)
      if (error instanceof ResponseError) return error.response
      for (const custom of renderers) {
        const answer = await custom(error, info)
        if (answer instanceof Response) return answer
      }
      const normalized = normalizeError(error)
      const problem = toProblemBody(normalized, {
        messages: options.messages,
        registry: options.errors,
        locale: info.locale,
        traceId: info.requestId,
        instance: new URL(info.request.url).pathname,
      })
      const body =
        options.showDetails && problem.status >= 500
          ? { ...problem, debug: describe(error) }
          : problem
      const response = problemResponse(body, normalized)
      response.headers.set('X-Request-Id', info.requestId)
      return response
    },
  }
  return renderer
}

function statusOf(error: unknown, errors: ErrorRegistry): number {
  const normalized = normalizeError(error)
  if (normalized instanceof StrutvaneError)
    return normalized.status ?? errors.get(normalized.code)?.status ?? 500
  return 500
}

/** An error as plain fields for the log and the debug member (never a value it carries). */
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
