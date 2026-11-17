import type { HttpContext } from '../../../../../../../src/http/app/context.ts'
import { Controller } from '../../../../../../../src/http/app/resource-controller.ts'

/** Always throws, like a typical bug. */
export class DiagnosticsController extends Controller {
  boom(_ctx: HttpContext): Response {
    throw new TypeError('Cannot read properties of undefined (reading "title")')
  }
}
