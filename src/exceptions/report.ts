/**
 * The exception handler's container token and Laravel's `report()` helper: log an error you
 * caught and handled, through the same reporters, `dontReport` list and throttle as an uncaught
 * one, without failing the request.
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'
import { currentApplication } from '../foundation/current.ts'
import { currentHttpContext } from '../http/app/context.ts'
import type { ExceptionRequestInfo } from '../http/app/errors.ts'
import type { ExceptionHandler } from './handler.ts'

/**
 * The container token for the app's {@link ExceptionHandler} (bound when the app boots).
 *
 * @example
 * app.make(ExceptionHandlerToken).report(error)
 */
export const ExceptionHandlerToken: Token<ExceptionHandler> =
  token<ExceptionHandler>('strutvane.exceptions')

/**
 * Report an error you handled yourself (Laravel's `report($e)`): custom reporters, then the
 * Logger, with the current request's reference id when there is one. Expected 4xx errors and
 * `dontReport` classes are skipped, like uncaught ones. Never throws for the error itself.
 *
 * @example
 * try {
 *   await gateway.charge(order)
 * } catch (error) {
 *   report(error)
 *   return ctx.json({ queued: true }, 202)
 * }
 */
export function report(error: unknown): void {
  const app = currentApplication('report()')
  if (!app.container.has(ExceptionHandlerToken))
    throw new BootError(
      'exception_handler_missing',
      'report() was called before the application booted its exception handler.',
      'Call it from a controller, middleware, listener or command (the app boots before they run).',
    )
  app.container.make(ExceptionHandlerToken).report(error, requestInfo())
}

/** What the current request looks like to the handler, if there is a current request. */
function requestInfo(): ExceptionRequestInfo | undefined {
  const ctx = currentHttpContext()
  if (ctx === undefined) return undefined
  return {
    request: ctx.request,
    nonce: ctx.nonce,
    requestId: ctx.state.requestId,
    locale: ctx.state.locale,
    wantsJson: ctx.wantsJson(),
    ...(ctx.route === undefined
      ? {}
      : {
          route: {
            ...(ctx.route.name === undefined ? {} : { name: ctx.route.name }),
            uri: ctx.route.uri,
            action: ctx.route.action,
          },
        }),
  }
}
