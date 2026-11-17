import { hasAdminRole } from '../../../../../../../src/auth/gate.ts'
import { ForbiddenError } from '../../../../../../../src/core/errors/errors.ts'
import type { HttpContext } from '../../../../../../../src/http/app/context.ts'
import type { Middleware, Next } from '../../../../../../../src/http/app/middleware.ts'

/** The `admin` middleware: only admins pass. */
export class EnsureAdmin implements Middleware {
  async handle(ctx: HttpContext, next: Next): Promise<Response> {
    if (hasAdminRole(ctx.requireUser())) return next()
    throw new ForbiddenError()
  }
}
