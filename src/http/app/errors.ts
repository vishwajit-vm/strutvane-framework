/**
 * How the HTTP kernel turns anything thrown into a response, behind one small interface
 * ({@link ExceptionRenderer}). The implementation is the exception handler
 * (`src/exceptions/handler.ts`: Laravel's `withExceptions` API, problem+json through the
 * framework's one problem pipeline, and the developer error page).
 *
 * @module
 */

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
  report(error: unknown, info?: ExceptionRequestInfo): void
  render(error: unknown, info: ExceptionRequestInfo): Promise<Response>
}
