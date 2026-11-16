import type { HttpContext } from '../../../../../../../src/http/app/context.ts'

/** An invokable (single-action) controller: Route.get('/ping', PingController) calls __invoke. */
export class PingController {
  __invoke(ctx: HttpContext): Response {
    return ctx.json({ pong: true, method: ctx.method })
  }
}
