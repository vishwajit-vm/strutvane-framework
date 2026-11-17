/**
 * A small "shop" app for the exception tests: its base path is `fixtures/shop`, so the throwing
 * functions in `fixtures/shop/app/services/checkout.ts` are the app's own code, while this test
 * folder and the framework are not.
 */
import { join } from 'node:path'
import { createTestClock, type TestClock } from '../../src/core/clock.ts'
import { ClockToken, LoggerToken } from '../../src/core/tokens.ts'
import type { ExceptionsConfig } from '../../src/exceptions/handler.ts'
import { Application } from '../../src/foundation/application.ts'
import type { HttpContext } from '../../src/http/app/context.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { blogConfig } from '../app/fixtures/blog/bootstrap/app.ts'
import { MemoryLogger, NOW, testEnv } from '../app/helpers.ts'

/** The shop fixture's root. */
export const SHOP_BASE: string = join(import.meta.dirname, 'fixtures', 'shop')

/** A route handler: `(ctx) => Response`. */
export type Handler = (ctx: HttpContext) => Response | Promise<Response>

/** What a shop test gets. */
export interface ShopApp {
  readonly app: Application
  readonly logger: MemoryLogger
  readonly clock: TestClock
  /** Send a request (path relative to http://localhost). */
  send(path: string, init?: RequestInit): Promise<Response>
}

/**
 * Build and boot the shop with these routes (all GET, under the web group) and exceptions.
 *
 * @example
 * const { send } = await shopApp({ '/boom': () => failWith('x') })
 */
export async function shopApp(
  routes: Readonly<Record<string, Handler>>,
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly exceptions?: (config: ExceptionsConfig) => void
    readonly forceDebug?: boolean
  } = {},
): Promise<ShopApp> {
  let builder = Application.configure({ basePath: SHOP_BASE, env: { ...testEnv, ...options.env } })
    .withConfig(blogConfig)
    .withRouting({
      web: defineRoutes(
        Object.entries(routes).map(([key, handler]) => {
          const [method, path] = key.startsWith('POST ') ? ['post', key.slice(5)] : ['get', key]
          const route = method === 'post' ? Route.post(path, handler) : Route.get(path, handler)
          return route.name(`shop.${method}${path.replace(/\W+/g, '_')}`)
        }),
      ),
    })
  if (options.exceptions !== undefined) builder = builder.withExceptions(options.exceptions)
  const app = builder.create()
  if (options.forceDebug === true) app.forceDebug()
  const logger = new MemoryLogger()
  const clock = createTestClock(NOW)
  app.container.value(LoggerToken, logger)
  app.container.value(ClockToken, clock)
  await app.boot()
  return {
    app,
    logger,
    clock,
    send: (path, init) =>
      app.handle(new Request(`http://localhost${path}`, init), { ip: '203.0.113.10' }),
  }
}

/** The text of the page's hidden Markdown, as the copy button would put on the clipboard. */
export function copiedMarkdown(html: string): string {
  const match = /<textarea id="markdown" hidden readonly>([\s\S]*?)<\/textarea>/.exec(html)
  if (match === null) throw new Error('No Markdown on the page')
  return (match[1] ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The nonce in a CSP header. */
export function cspNonce(response: Response): string | undefined {
  return /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1]
}
