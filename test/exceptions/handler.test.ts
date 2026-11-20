/**
 * `withExceptions()`: dontReport, report and render (global and per class), shouldRenderJsonWhen,
 * throttled reports with an injected clock, failing reporters/renderers, the `report()` helper,
 * and the handler's own fail-closed rules.
 */
import { describe, expect, it } from 'vitest'
import { ServiceUnavailableError, StrutvaneError } from '../../src/core/errors/errors.ts'
import { createErrorRegistry } from '../../src/core/errors/registry.ts'
import { createMessages } from '../../src/core/messages/catalog.ts'
import { ExceptionHandler, ExceptionsConfig } from '../../src/exceptions/handler.ts'
import { ExceptionHandlerToken, report } from '../../src/exceptions/report.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import { runInApplication } from '../../src/foundation/current.ts'
import { type ExceptionRequestInfo, ResponseError } from '../../src/http/app/errors.ts'
import { MemoryLogger } from '../app/helpers.ts'
import { failWith, failWithValue } from './fixtures/shop/app/services/checkout.ts'
import { SHOP_BASE, shopApp } from './helpers.ts'

class PaymentDeclined extends Error {
  override readonly name = 'PaymentDeclined'
}
class Gone extends Error {}

function info(overrides: Partial<ExceptionRequestInfo> = {}): ExceptionRequestInfo {
  return {
    request: new Request('http://localhost/x?token=abc'),
    nonce: 'bm9uY2U',
    requestId: 'req-1',
    locale: 'en',
    wantsJson: false,
    ...overrides,
  }
}

function handler(
  configure: (config: ExceptionsConfig) => void = () => {},
  options: { showDetails?: boolean; environment?: string; now?: () => number } = {},
): { handler: ExceptionHandler; logger: MemoryLogger } {
  const config = new ExceptionsConfig()
  configure(config)
  const logger = new MemoryLogger()
  return {
    logger,
    handler: new ExceptionHandler(config, {
      showDetails: options.showDetails ?? false,
      environment: options.environment ?? 'testing',
      basePath: SHOP_BASE,
      logger,
      messages: createMessages(),
      errors: createErrorRegistry(),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  }
}

describe('withExceptions()', () => {
  it('renders one class its own way and reports another to a class-specific reporter', async () => {
    const tracked: string[] = []
    const { send, logger } = await shopApp(
      {
        '/declined': () => {
          throw new PaymentDeclined('card declined')
        },
        '/gone': () => {
          throw new Gone('moved away')
        },
      },
      {
        exceptions: (e) =>
          e
            .render(PaymentDeclined, (error) =>
              Response.json({ declined: error.message }, { status: 402 }),
            )
            .report(Gone, (error) => {
              tracked.push(error.message)
              return false
            }),
      },
    )
    const declined = await send('/declined')
    expect(declined.status).toBe(402)
    expect(await declined.json()).toEqual({ declined: 'card declined' })
    const gone = await send('/gone')
    expect(gone.status).toBe(500)
    expect(tracked).toEqual(['moved away'])
    // PaymentDeclined is still reported (it is a 500 class); Gone's reporter stopped the logging.
    expect(logger.messages('error')).toEqual(['Unhandled error while serving a request'])
  })

  it('renders JSON when the app says so, and falls back to JSON if that predicate throws', async () => {
    const { send, logger } = await shopApp(
      { '/boom': () => failWith('boom'), '/hook/boom': () => failWith('boom') },
      {
        exceptions: (e) =>
          e.shouldRenderJsonWhen((request) => {
            if (new URL(request.request.url).pathname.startsWith('/hook/'))
              throw new Error('predicate bug')
            return false
          }),
      },
    )
    expect(
      (await send('/boom', { headers: { accept: 'application/json' } })).headers.get(
        'content-type',
      ),
    ).toContain('text/html')
    const hook = await send('/hook/boom')
    expect(hook.headers.get('content-type')).toContain('application/problem+json')
    expect(logger.messages('error')).toContain('shouldRenderJsonWhen() failed; answering with JSON')
  })

  it('logs a renderer that throws and answers with the default problem', async () => {
    const { send, logger } = await shopApp(
      { '/boom': () => failWith('boom') },
      {
        exceptions: (e) =>
          e
            .render(() => {
              throw new Error('renderer bug')
            })
            .render(() => 'not a response' as unknown as Response),
        env: { APP_DEBUG: 'false' },
      },
    )
    const response = await send('/boom')
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(logger.messages('error')).toEqual([
      'Unhandled error while serving a request',
      'An exception renderer failed',
    ])
  })

  it('throttles identical reports and says how many were suppressed', async () => {
    const { send, logger, clock } = await shopApp(
      { '/boom': () => failWith('same bug'), '/other': () => failWith('other bug') },
      { exceptions: (e) => e.throttle({ windowSeconds: 60 }) },
    )
    for (let index = 0; index < 5; index += 1) await send('/boom')
    await send('/other')
    expect(logger.messages('error')).toHaveLength(2)
    clock.advance(61_000)
    await send('/boom')
    const errors = logger.entries.filter((entry) => entry.level === 'error')
    expect(errors).toHaveLength(3)
    expect(errors[2]?.fields?.['suppressed']).toBe(4)
  })

  it('refuses a non-positive throttle window and a non-function second argument', () => {
    const config = new ExceptionsConfig()
    expect(() => config.throttle({ windowSeconds: 0 })).toThrow(RangeError)
    expect(() => config.throttle({ windowSeconds: Number.NaN })).toThrow(RangeError)
    expect(() =>
      config.render(Gone, 'nope' as unknown as (error: Gone) => Response | undefined),
    ).toThrow(TypeError)
    expect(config.throttle().collected.throttleMs).toBe(60_000)
  })

  it('reports a 5xx StrutvaneError without the debug page', async () => {
    const { send, logger } = await shopApp({
      '/down': () => {
        throw new ServiceUnavailableError(30)
      },
    })
    const response = await send('/down')
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(logger.messages('error')).toEqual(['Unhandled error while serving a request'])
  })

  it('handles thrown values that are not errors', async () => {
    const { send, logger } = await shopApp({ '/value': () => failWithValue() })
    const page = await send('/value')
    expect(page.status).toBe(500)
    const html = await page.text()
    expect(html).toContain('<h1>string</h1>')
    expect(html).toContain('a plain string')
    expect(logger.entries[logger.entries.length - 1]?.fields?.['error']).toEqual({
      name: 'string',
      message: 'a plain string',
    })
  })
})

describe('report()', () => {
  it('reports a handled error with the request reference and route, once per request', async () => {
    const { send, logger } = await shopApp({
      '/charge': () => {
        const error = new Error('gateway timeout')
        report(error)
        report(error)
        throw error
      },
    })
    const response = await send('/charge', { headers: { accept: 'application/json' } })
    const errors = logger.entries.filter((entry) => entry.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.fields).toMatchObject({
      traceId: response.headers.get('x-request-id'),
      route: '/charge',
      method: 'GET',
    })
  })

  it('skips expected client errors and works outside a request', async () => {
    const { app, logger } = await shopApp({})
    await app.run(async () => {
      report(new StrutvaneError('not_found', { status: 404 }))
      report(new Error('nightly import failed'))
    })
    expect(logger.messages('error')).toEqual(['Unhandled error'])
    expect(app.make(ExceptionHandlerToken)).toBeInstanceOf(ExceptionHandler)
  })

  it('needs a current, booted app', () => {
    const outside = (() => {
      try {
        report(new Error('x'))
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(isBootError(outside) && outside.code).toBe('no_current_application')
    const container = { has: () => false, make: () => undefined }
    const unbooted = (() => {
      try {
        runInApplication({ container: container as never, basePath: SHOP_BASE }, () =>
          report(new Error('x')),
        )
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(isBootError(unbooted) && unbooted.code).toBe('exception_handler_missing')
  })
})

describe('ExceptionHandler', () => {
  it('never shows details outside local and testing, even when told to', async () => {
    const { handler: production } = handler(() => {}, {
      showDetails: true,
      environment: 'production',
    })
    expect(production.showsDetails).toBe(false)
    const response = await production.render(new Error('secret detail'), info())
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.text()).not.toContain('secret detail')
    expect(
      handler(() => {}, { showDetails: true, environment: 'local' }).handler.showsDetails,
    ).toBe(true)
  })

  it('falls back to the plain problem when the debug page itself fails', async () => {
    const { handler: debug, logger } = handler(() => {}, { showDetails: true })
    const response = await debug.render(new Error('hidden detail'), info({ nonce: "x'; bad" }))
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.text()).not.toContain('hidden detail')
    expect(logger.messages('error')).toContain(
      'The debug page failed; answering with the plain problem',
    )
  })

  it('passes early responses through without reporting them', async () => {
    const { handler: plain, logger } = handler()
    const early = new Response(null, { status: 302, headers: { location: '/login' } })
    expect(await plain.render(new ResponseError(early), info())).toBe(early)
    expect(plain.shouldReport(new ResponseError(early))).toBe(false)
    // FW-9: maintenance mode's 503 is expected; other 5xx still are reported.
    expect(plain.shouldReport(new StrutvaneError('maintenance_mode', { status: 503 }))).toBe(false)
    expect(plain.shouldReport(new StrutvaneError('cache_unavailable', { status: 503 }))).toBe(true)
    expect(logger.entries).toEqual([])
  })

  it('skips dontReport classes and keeps working when a reporter throws', () => {
    const seen: unknown[] = []
    const { handler: configured, logger } = handler((e) =>
      e
        .dontReport(PaymentDeclined)
        .report(() => {
          throw new Error('tracker down')
        })
        .report((error) => void seen.push(error)),
    )
    configured.report(new PaymentDeclined('declined'))
    configured.report(new Error('real bug'), info())
    expect(seen).toHaveLength(1)
    expect(logger.messages('error')).toEqual([
      'An exception reporter failed',
      'Unhandled error while serving a request',
    ])
  })

  it('reports the same error object again for another request', () => {
    const { handler: plain, logger } = handler()
    const shared = new Error('cached failure')
    plain.report(shared, info({ requestId: 'a' }))
    plain.report(shared, info({ requestId: 'a' }))
    plain.report(shared, info({ requestId: 'b' }))
    expect(logger.messages('error')).toHaveLength(2)
  })

  it('remembers a bounded number of throttle keys', () => {
    let now = 0
    const { handler: throttled, logger } = handler((e) => e.throttle(), { now: () => now })
    // Same class, message and throw site = the same report.
    const bug = (index: number): Error => new Error(`bug ${index}`)
    for (let index = 0; index < 600; index += 1) throttled.report(bug(index))
    expect(logger.messages('error')).toHaveLength(600)
    // The oldest keys were evicted, so "bug 0" is reported again inside its window.
    throttled.report(bug(0))
    expect(logger.messages('error')).toHaveLength(601)
    throttled.report(bug(599))
    expect(logger.messages('error')).toHaveLength(601)
    now = 120_000
    throttled.report('not an error')
    expect(logger.messages('error')).toHaveLength(602)
  })

  it('uses the request path without its query in logs and the problem', async () => {
    const { handler: plain, logger } = handler()
    const response = await plain.render(
      new Error('x'),
      info({ request: new Request('http://localhost/reset?token=abc'), wantsJson: true }),
    )
    const body = (await response.json()) as { instance: string; traceId: string }
    expect(body.instance).toBe('/reset')
    expect(body.traceId).toBe('req-1')
    expect(response.headers.get('x-request-id')).toBe('req-1')
    expect(JSON.stringify(logger.entries)).not.toContain('token=abc')
  })
})
