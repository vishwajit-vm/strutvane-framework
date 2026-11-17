/**
 * The HTTP kernel around the router: the `http.onRequest`/`http.onResponse` hooks (the actor and
 * tenant come from the auth hook; a hook may answer, and CSRF still covers it), deferred work and
 * terminable middleware (after the response, errors logged and never changing it), the request
 * timeout, the maintenance stage, invokable controllers and HEAD.
 */
import { describe, expect, it } from 'vitest'
import type {
  HttpRequestHookPayload,
  HttpResponseHookPayload,
} from '../../src/contracts/http-hooks.ts'
import { StrutvaneError } from '../../src/core/errors/errors.ts'
import { HooksToken, LoggerToken } from '../../src/core/tokens.ts'
import { Application } from '../../src/foundation/application.ts'
import { defer, type HttpContext } from '../../src/http/app/context.ts'
import { MaintenanceCheckToken } from '../../src/http/app/kernel.ts'
import type { Next } from '../../src/http/app/middleware.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { testClient } from '../../src/testing/app-client.ts'
import { blogConfig } from './fixtures/blog/bootstrap/app.ts'
import { BLOG_BASE, customApp, MemoryLogger, testEnv } from './helpers.ts'

const ok = (ctx: HttpContext): Response => ctx.json({ ok: true })

describe('the request hooks', () => {
  it('takes the user and tenant from http.onRequest, adds its headers, and reports http.onResponse', async () => {
    const seen: HttpResponseHookPayload[] = []
    const prepared = await customApp({
      api: defineRoutes([
        Route.get('/whoami/{id}', (ctx) =>
          ctx.json({ user: ctx.user?.id ?? null, tenant: ctx.tenant?.id ?? null }),
        ).middleware('auth'),
      ]),
    })
    const hooks = prepared.app.make(HooksToken)
    hooks.on(
      'http.onRequest',
      (payload) => ({
        ...(payload as HttpRequestHookPayload),
        actor: { id: 'u-9', type: 'user', roles: [], attrs: {} },
        tenant: { id: 'acme', strategy: 'shared' },
        headers: new Headers({ 'x-session-refreshed': '1' }),
      }),
      { name: 'test.actor', after: 'blog.bearer' },
    )
    hooks.on('http.onResponse', (payload) => void seen.push(payload as HttpResponseHookPayload), {
      name: 'test.observer',
    })
    const response = await prepared.client.getJson('/api/whoami/7')
    response.assertStatus(200).assertJsonPath('user', 'u-9').assertJsonPath('tenant', 'acme')
    expect(response.headers.get('x-session-refreshed')).toBe('1')
    expect(seen).toEqual([expect.objectContaining({ status: 200, route: '/api/whoami/{id}' })])
    await prepared.client.getJson('/api/nothing')
    expect(seen[1]).toEqual(expect.not.objectContaining({ route: expect.anything() }))
  })

  it('a hook may answer a request itself, and CSRF still covers it (CONSISTENCY #125)', async () => {
    const prepared = await customApp({})
    let signedIn = 0
    prepared.app.make(HooksToken).on(
      'http.onRequest',
      (payload) => {
        const request = (payload as HttpRequestHookPayload).request
        if (new URL(request.url).pathname !== '/auth/sign-in') return undefined
        signedIn++
        return {
          ...(payload as HttpRequestHookPayload),
          response: Response.json({ signedIn: true }),
        }
      },
      { name: 'test.sign-in' },
    )
    const forged = await prepared.client
      .withHeaders({ cookie: 'strutvane_session=abc' })
      .postJson('/auth/sign-in', {})
    forged.assertProblem(419, 'csrf_token_mismatch')
    expect(signedIn).toBe(0)
    const fine = await prepared.client.postJson('/auth/sign-in', {})
    fine.assertStatus(200).assertJsonPath('signedIn', true)
    expect(fine.headers.get('content-security-policy')).not.toBeNull()
  })

  it('a hook that refuses a request with a StrutvaneError gives that problem, and a failing response hook is only logged', async () => {
    const prepared = await customApp({ api: defineRoutes([Route.get('/x', ok)]) })
    const hooks = prepared.app.make(HooksToken)
    hooks.on(
      'http.onRequest',
      (payload) => {
        if (new URL((payload as HttpRequestHookPayload).request.url).searchParams.has('deny'))
          throw new StrutvaneError('forbidden', { status: 403 })
        return undefined
      },
      { name: 'test.deny' },
    )
    hooks.on(
      'http.onResponse',
      () => {
        throw new Error('observer broke')
      },
      { name: 'test.broken' },
    )
    ;(await prepared.client.getJson('/api/x?deny=1')).assertProblem(403, 'forbidden')
    ;(await prepared.client.getJson('/api/x')).assertStatus(200)
    expect(prepared.logger.messages('error')).toContain('An http.onResponse hook failed')
  })
})

describe('deferred work and terminable middleware', () => {
  it('runs after the response; failures are logged and never change it', async () => {
    const order: string[] = []
    class Audit {
      async handle(_ctx: HttpContext, next: Next): Promise<Response> {
        order.push('audit.handle')
        return next()
      }
      terminate(_ctx: HttpContext, response: Response): void {
        order.push(`audit.terminate ${response.status}`)
        throw new Error('audit sink down')
      }
    }
    const prepared = await customApp(
      {
        api: defineRoutes([
          Route.get('/work', (ctx) => {
            ctx.defer(() => void order.push('deferred 1'))
            defer(async () => {
              order.push('deferred 2')
              throw new Error('mail server down')
            })
            ctx.defer(() => void order.push('deferred 3'))
            order.push('handler')
            return ctx.json({ ok: true })
          }).middleware('audit'),
        ]),
      },
      (m) => m.alias({ audit: Audit }),
    )
    const response = await prepared.client.getJson('/api/work')
    response.assertStatus(200).assertJsonPath('ok', true)
    expect(order).toEqual([
      'audit.handle',
      'handler',
      'audit.terminate 200',
      'deferred 1',
      'deferred 2',
      'deferred 3',
    ])
    expect(prepared.logger.messages('error')).toEqual([
      'Terminable middleware failed',
      'Deferred work failed',
    ])
  })

  it('hands deferred work to waitUntil (the Node adapter) instead of delaying the response', async () => {
    let release: () => void = () => {}
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    let finished = false
    const prepared = await customApp({
      web: defineRoutes([
        Route.get('/slow-after', (ctx) => {
          ctx.defer(async () => {
            await blocker
            finished = true
          })
          return ctx.json({ sent: true })
        }),
      ]),
    })
    const pending: Promise<void>[] = []
    const response = await prepared.app.handle(new Request('http://localhost/slow-after'), {
      waitUntil: (work) => void pending.push(work),
    })
    expect(response.status).toBe(200)
    expect(finished).toBe(false)
    release()
    await Promise.all(pending)
    expect(finished).toBe(true)
  })

  it('refuses defer() outside a request', () => {
    expect(() => defer(() => undefined)).toThrow(/outside an HTTP request/)
  })
})

describe('the kernel stages', () => {
  it('answers 503 when a request takes longer than the timeout', async () => {
    const prepared = await customApp(
      { web: defineRoutes([Route.get('/hang', () => new Promise<Response>(() => undefined))]) },
      (m) => m.requestTimeout(30),
    )
    ;(await prepared.client.getJson('/hang')).assertProblem(503, 'service_unavailable')
    expect(() => prepared.app.middleware.requestTimeout(-1)).toThrow(RangeError)
  })

  it('runs the maintenance check between the host check and routing', async () => {
    const app = Application.configure({ basePath: BLOG_BASE, env: testEnv })
      .withConfig(blogConfig)
      .withRouting({ web: defineRoutes([Route.get('/page', ok)]) })
      .create()
    let checked: { healthPath: string; secureCookies: boolean } | undefined
    app.container.value(LoggerToken, new MemoryLogger())
    app.container.value(MaintenanceCheckToken, async (request, options) => {
      checked = { healthPath: options.healthPath, secureCookies: options.secureCookies }
      return new URL(request.url).pathname === options.healthPath
        ? undefined
        : new Response('down', { status: 503 })
    })
    const client = testClient(app)
    ;(await client.get('/page')).assertStatus(503)
    ;(await client.getJson('/up')).assertStatus(200)
    expect(checked).toEqual({ healthPath: '/up', secureCookies: false })
    // An untrusted host is refused before maintenance answers.
    expect((await app.handle(new Request('http://evil.example/page'))).status).toBe(400)
  })

  it('answers HEAD on GET routes without a body, and routes invokable controllers', async () => {
    class Invokable {
      __invoke(ctx: HttpContext): Response {
        return ctx.json({ invoked: ctx.method })
      }
    }
    const prepared = await customApp({
      web: defineRoutes([Route.get('/inv', Invokable), Route.any('/anything', ok)]),
    })
    ;(await prepared.client.getJson('/inv')).assertJsonPath('invoked', 'GET')
    const head = await prepared.client.request(
      new Request('http://localhost/inv', { method: 'HEAD' }),
    )
    head.assertStatus(200)
    expect(head.text).toBe('')
    ;(await prepared.client.send('PATCH', '/anything', {})).assertStatus(200)
  })

  it('refuses a controller action that returns something other than a Response', async () => {
    const prepared = await customApp(
      {
        web: defineRoutes([
          Route.get('/bad', (() => ({ not: 'a response' })) as unknown as (
            ctx: HttpContext,
          ) => Response),
        ]),
      },
      () => {},
      { APP_DEBUG: 'true' },
    )
    const response = await prepared.client.getJson('/bad')
    response.assertStatus(500)
    expect(response.text).toContain('not_a_response')
  })
})
