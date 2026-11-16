import { config } from '../../../../../../../src/foundation/helpers.ts'
import type { HttpContext } from '../../../../../../../src/http/app/context.ts'
import { Controller } from '../../../../../../../src/http/app/resource-controller.ts'

/** The web side is a React app: every page is its HTML shell, with this response's CSP nonce. */
export class SpaController extends Controller {
  show(ctx: HttpContext): Response {
    const title = String(config('app.name')).replace(/[<>&"]/g, '')
    return ctx.html(
      `<!doctype html><html><head><title>${title}</title><script nonce="${ctx.nonce}" type="module" src="/build/app.js"></script></head><body><div id="root"></div></body></html>`,
    )
  }
}
