/**
 * The "many ways" rule (blueprint §5.2): CSRF, auth, can and throttle applied by default,
 * app-wide, per route, per group (callback and array), per controller, as a handler wrapper and
 * imperatively, all running the same middleware class; the boot errors for contradictions and
 * typos; the security profile behind `route:list --security`; and attack-style CSRF bypass and
 * `_method` spoofing attempts.
 */
import { describe, expect, it } from 'vitest'
import { hasAdminRole } from '../../src/auth/gate.ts'
import { Application } from '../../src/foundation/application.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import { HttpContext } from '../../src/http/app/context.ts'
import type { Next } from '../../src/http/app/middleware.ts'
import { defineProtection } from '../../src/http/app/protection.ts'
import {
  auth,
  can,
  csrf,
  csrf_field,
  csrf_meta,
  throttle,
  withAuth,
  withCan,
  withCsrf,
  withThrottle,
} from '../../src/http/app/protections.ts'
import { csrfToken } from '../../src/http/csrf.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { blogConfig } from './fixtures/blog/bootstrap/app.ts'
import { author, BLOG_BASE, blogApp, customApp, type TestApp, testEnv } from './helpers.ts'

const SESSION = 'session-abc'
const cookie = { cookie: `strutvane_session=${SESSION}` }
const ok = (ctx: HttpContext): Response => ctx.json({ ok: true })
const tokenFor = (prepared: TestApp, session = SESSION): string =>
  csrfToken(prepared.app.security.csrf.key, session)

/** A raw POST with a session cookie and nothing proving where it came from. */
async function forgedPost(
  prepared: TestApp,
  path: string,
  extra: Record<string, string> = {},
): Promise<number> {
  return (await prepared.client.withHeaders({ ...cookie, ...extra }).postJson(path, {})).status
}

async function bootError(
  promise: Promise<unknown>,
): Promise<{ code: string; hint: string; message: string }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (isBootError(error)) return error
  throw new Error(`Expected a boot error, got ${String(error)}`)
}

describe('CSRF in every style', () => {
  it('is on by default for web and api routes', async () => {
    const prepared = await customApp({
      web: defineRoutes([Route.post('/web-form', ok)]),
      api: defineRoutes([Route.post('/thing', ok)]),
    })
    expect(await forgedPost(prepared, '/web-form')).toBe(419)
    expect(await forgedPost(prepared, '/api/thing')).toBe(419)
    expect(await forgedPost(prepared, '/api/thing', { 'x-csrf-token': tokenFor(prepared) })).toBe(
      200,
    )
    expect(await forgedPost(prepared, '/api/thing', { 'x-xsrf-token': tokenFor(prepared) })).toBe(
      200,
    )
  })

  it('validateCsrfTokens({ except }) exempts matching full paths only, and warns about patterns that match nothing', async () => {
    const prepared = await customApp(
      { api: defineRoutes([Route.post('/webhooks/stripe', ok), Route.post('/webhooksx', ok)]) },
      (m) => m.validateCsrfTokens({ except: ['api/webhooks/*', 'webhooks/*'] }),
    )
    expect(await forgedPost(prepared, '/api/webhooks/stripe')).toBe(200)
    expect(await forgedPost(prepared, '/api/webhooksx')).toBe(419)
    expect(prepared.logger.messages('warn').join('\n')).toContain(
      'The CSRF exception "webhooks/*" matches no route',
    )
    expect(prepared.logger.messages('warn').join('\n')).not.toContain(
      '"api/webhooks/*" matches no route',
    )
  })

  it('validateCsrfTokens({ origins }) trusts an extra exact origin, never a lookalike', async () => {
    const prepared = await customApp({ api: defineRoutes([Route.post('/thing', ok)]) }, (m) =>
      m.validateCsrfTokens({ origins: ['https://admin.example.com'] }),
    )
    expect(await forgedPost(prepared, '/api/thing', { origin: 'https://admin.example.com' })).toBe(
      200,
    )
    expect(
      await forgedPost(prepared, '/api/thing', { origin: 'https://admin.example.com.evil.net' }),
    ).toBe(419)
    expect(await forgedPost(prepared, '/api/thing', { origin: 'http://admin.example.com' })).toBe(
      419,
    )
  })

  it('refuses null, "*" and path-carrying trusted origins at boot, all at once', async () => {
    const error = await bootError(
      customApp({}, (m) =>
        m.validateCsrfTokens({ origins: ['null', '*', 'https://a.example.com/path'] }),
      ),
    )
    expect(error.code).toBe('insecure_configuration')
    expect(error.message).toMatch(/3 security settings are unsafe/)
  })

  it('route and group opt-outs, and a re-add inside an opted-out group (array and callback groups)', async () => {
    const prepared = await customApp({
      web: defineRoutes([
        Route.post('/hook', ok).withoutMiddleware('csrf'),
        Route.withoutMiddleware('csrf').group([
          Route.post('/open', ok),
          Route.post('/guarded', ok).middleware('csrf'),
        ]),
        Route.middleware('csrf').group([Route.post('/grouped', ok)]),
      ]),
      api: (router) => {
        router.withoutMiddleware('csrf').group(() => {
          router.post('/cb-open', ok)
          router.post('/cb-guarded', ok).middleware('csrf')
        })
      },
    })
    expect(await forgedPost(prepared, '/hook')).toBe(200)
    expect(await forgedPost(prepared, '/open')).toBe(200)
    expect(await forgedPost(prepared, '/guarded')).toBe(419)
    expect(await forgedPost(prepared, '/grouped')).toBe(419)
    expect(await forgedPost(prepared, '/api/cb-open')).toBe(200)
    expect(await forgedPost(prepared, '/api/cb-guarded')).toBe(419)
  })

  it('controller static middleware: csrf({ except }) opts one action out, the rest stay protected', async () => {
    class PaymentController {
      static readonly middleware = [csrf({ except: ['callback'] })]
      callback(ctx: HttpContext): Response {
        return ctx.json({ received: true })
      }
      pay(ctx: HttpContext): Response {
        return ctx.json({ paid: true })
      }
    }
    const prepared = await customApp({
      api: defineRoutes([
        Route.post('/pay/callback', [PaymentController, 'callback']),
        Route.post('/pay', [PaymentController, 'pay']),
      ]),
    })
    expect(await forgedPost(prepared, '/api/pay/callback')).toBe(200)
    expect(await forgedPost(prepared, '/api/pay')).toBe(419)
  })

  it('withCsrf(handler) protects a plain function, routed or called directly', async () => {
    const handler = withCsrf(async (ctx) => ctx.json({ imported: true }))
    const prepared = await customApp({
      web: defineRoutes([Route.withoutMiddleware('csrf').group([Route.post('/import', handler)])]),
    })
    expect(await forgedPost(prepared, '/import')).toBe(419)
    expect(await forgedPost(prepared, '/import', { 'x-csrf-token': tokenFor(prepared) })).toBe(200)
    // Called directly (no router), the wrapper runs the check itself.
    const direct = new HttpContext({
      request: new Request('http://localhost/import', { method: 'POST', headers: cookie }),
      sessionCookie: prepared.app.security.csrf.cookie,
    })
    await expect(prepared.app.run(() => handler(direct))).rejects.toMatchObject({ status: 419 })
  })

  it('csrf.verify(ctx), csrf.token(ctx), csrf_field() and csrf_meta() work imperatively', async () => {
    const prepared = await customApp({
      web: defineRoutes([
        Route.withoutMiddleware('csrf').group([
          Route.post('/manual', async (ctx) => {
            await csrf.verify(ctx)
            return ctx.json({ ok: true })
          }),
        ]),
        Route.get('/form', (ctx) =>
          ctx.html(
            `<head>${csrf_meta(ctx)}</head><form method="post">${csrf_field(ctx)}</form><p>${csrf.token(ctx)}</p>`,
          ),
        ),
      ]),
    })
    expect(await forgedPost(prepared, '/manual')).toBe(419)
    expect(await forgedPost(prepared, '/manual', { 'x-csrf-token': tokenFor(prepared) })).toBe(200)
    const page = await prepared.client.withHeaders(cookie).get('/form')
    expect(page.text).toContain(`<input type="hidden" name="_token" value="${tokenFor(prepared)}">`)
    expect(page.text).toContain(`<meta name="csrf-token" content="${tokenFor(prepared)}">`)
    // No session, no token: a token bound to nothing would protect nothing.
    ;(await prepared.client.get('/form')).assertStatus(500)
  })

  it("accepts the _token field of a urlencoded form, never another session's", async () => {
    const prepared = await customApp({ web: defineRoutes([Route.post('/form', ok)]) })
    const form = prepared.client.withHeaders(cookie)
    ;(await form.postForm('/form', { title: 'Hi', _token: tokenFor(prepared) })).assertStatus(200)
    ;(
      await form.postForm('/form', { title: 'Hi', _token: tokenFor(prepared, 'other') })
    ).assertStatus(419)
  })

  it('keys on the configured session cookie: both spellings are checked (CONSISTENCY #105)', async () => {
    const prepared = await customApp({ web: defineRoutes([Route.post('/thing', ok)]) })
    expect(
      await forgedPost(prepared, '/thing', { cookie: `__Host-strutvane_session=${SESSION}` }),
    ).toBe(419)
    expect(
      (await prepared.client.withHeaders({ cookie: 'other_session=1' }).postJson('/thing', {}))
        .status,
    ).toBe(200)
  })

  it('issues the XSRF-TOKEN cookie for front ends, readable by scripts and SameSite=Lax (CONSISTENCY #17)', async () => {
    const prepared = await customApp({ web: defineRoutes([Route.get('/page', ok)]) })
    const response = await prepared.client.withHeaders(cookie).get('/page')
    const header = response.headers.get('set-cookie') ?? ''
    expect(header).toContain(`XSRF-TOKEN=${tokenFor(prepared)}`)
    expect(header).toContain('SameSite=Lax')
    expect(header).not.toContain('HttpOnly')
  })

  it('withoutCsrf() works in tests and is refused outside APP_ENV=testing (CONSISTENCY #60)', async () => {
    const prepared = await customApp({ api: defineRoutes([Route.post('/thing', ok)]) })
    ;(
      await prepared.client.withHeaders(cookie).withoutCsrf().postJson('/api/thing', {})
    ).assertStatus(200)
    const local = await customApp({ api: defineRoutes([Route.post('/thing', ok)]) }, () => {}, {
      APP_ENV: 'local',
    })
    await expect(
      local.client.withHeaders(cookie).withoutCsrf().postJson('/api/thing', {}),
    ).rejects.toThrow('withoutCsrf()/actingAs() was used with APP_ENV=local.')
    await expect(local.client.actingAs(author(local, 2)).getJson('/up')).rejects.toThrow(
      /APP_ENV=local/,
    )
  })
})

describe('the same styles for auth, can and throttle (one generic helper)', () => {
  it('controller entries with only/except, wrappers and imperative checks', async () => {
    class ReportController {
      static readonly middleware = [
        auth({ except: ['index'] }),
        can({ params: ['view-reports'], only: ['secret'] }),
        throttle({ params: ['2', '1'], only: ['index'] }),
      ]
      index(ctx: HttpContext): Response {
        return ctx.json({ public: true })
      }
      mine(ctx: HttpContext): Response {
        return ctx.json({ me: ctx.requireUser().id })
      }
      secret(ctx: HttpContext): Response {
        return ctx.json({ secret: true })
      }
    }
    const prepared = await customApp(
      {
        api: defineRoutes([
          Route.get('/reports', [ReportController, 'index']),
          Route.get('/reports/mine', [ReportController, 'mine']),
          Route.get('/reports/secret', [ReportController, 'secret']),
          Route.get(
            '/wrapped/me',
            withAuth(async (ctx) => ctx.json({ me: ctx.requireUser().id })),
          ),
          Route.get(
            '/wrapped/admin',
            withAuth(withCan(async (ctx) => ctx.json({ admin: true }), 'view-reports')),
          ),
          Route.get(
            '/wrapped/limited',
            withThrottle(async (ctx) => ctx.json({ ok: true }), '1', '1'),
          ),
          Route.get('/imperative', async (ctx) => {
            await auth.verify(ctx)
            return ctx.json({ me: ctx.requireUser().id })
          }),
        ]),
      },
      (m) => m.defineAbility('view-reports', (user) => hasAdminRole(user)),
    )
    const guest = prepared.client
    const alice = prepared.client.actingAs(author(prepared, 2))
    const admin = prepared.client.actingAs(author(prepared, 1))
    ;(await guest.getJson('/api/reports')).assertStatus(200)
    ;(await guest.getJson('/api/reports/mine')).assertStatus(401)
    ;(await alice.getJson('/api/reports/mine')).assertStatus(200)
    ;(await alice.getJson('/api/reports/secret')).assertProblem(403, 'forbidden')
    ;(await admin.getJson('/api/reports/secret')).assertStatus(200)
    ;(await guest.getJson('/api/reports')).assertStatus(200)
    ;(await guest.getJson('/api/reports')).assertStatus(429)
    ;(await guest.getJson('/api/wrapped/me')).assertStatus(401)
    ;(await alice.getJson('/api/wrapped/me')).assertStatus(200)
    ;(await alice.getJson('/api/wrapped/admin')).assertStatus(403)
    ;(await admin.getJson('/api/wrapped/admin')).assertStatus(200)
    ;(await guest.getJson('/api/wrapped/limited')).assertStatus(200)
    ;(await guest.getJson('/api/wrapped/limited')).assertStatus(429)
    ;(await guest.getJson('/api/imperative')).assertStatus(401)
    ;(await alice.getJson('/api/imperative')).assertStatus(200)
  })

  it('a wrapped handler runs its middleware once when routed', async () => {
    let runs = 0
    class Counting {
      async handle(_ctx: HttpContext, next: Next): Promise<Response> {
        runs++
        return next()
      }
    }
    const counted = defineProtection('counted', Counting)
    const prepared = await customApp(
      { api: defineRoutes([Route.get('/once', counted.wrap(ok))]) },
      (m) => m.alias({ counted: Counting }),
    )
    ;(await prepared.client.getJson('/api/once')).assertStatus(200)
    expect(runs).toBe(1)
    expect(counted.reference('a', 'b')).toBe('counted:a,b')
  })

  it('refuses contradictions and typos at boot, with did-you-mean', async () => {
    expect(
      (
        await bootError(
          customApp({
            api: defineRoutes([Route.post('/x', ok).middleware('auth').withoutMiddleware('auth')]),
          }),
        )
      ).code,
    ).toBe('middleware_conflict')
    expect(
      (
        await bootError(
          customApp({ api: defineRoutes([Route.post('/x', ok).withoutMiddleware('cfrs')]) }),
        )
      ).hint,
    ).toBe('Did you mean "csrf"?')
    expect(
      (await bootError(customApp({ api: defineRoutes([Route.get('/x', ok).middleware('auht')]) })))
        .hint,
    ).toBe('Did you mean "auth"?')
    expect(
      (
        await bootError(
          customApp(
            { api: defineRoutes([Route.get('/x', ok).middleware('can:view-repots')]) },
            (m) => m.defineAbility('view-reports', () => true),
          ),
        )
      ).hint,
    ).toBe('Did you mean "view-reports"?')
    expect(
      (
        await bootError(
          customApp({ api: defineRoutes([Route.get('/x', ok).middleware('throttle:logn')]) }),
        )
      ).hint,
    ).toBe('Did you mean "login"?')
    expect(
      (
        await bootError(
          customApp({ api: defineRoutes([Route.get('/x', ok).middleware('signed')]) }),
        )
      ).code,
    ).toBe('signed_route_without_name')
    class Typo {
      static readonly middleware = [auth({ only: ['indx'] })]
      index(ctx: HttpContext): Response {
        return ctx.json({})
      }
    }
    expect(
      (await bootError(customApp({ api: defineRoutes([Route.get('/x', [Typo, 'index'])]) }))).hint,
    ).toBe('Did you mean "index"?')
    class NotProtections {
      static readonly middleware = ['auth']
      index(ctx: HttpContext): Response {
        return ctx.json({})
      }
    }
    expect(
      (
        await bootError(
          customApp({ api: defineRoutes([Route.get('/x', [NotProtections, 'index'])]) }),
        )
      ).code,
    ).toBe('invalid_controller_middleware')
    class Impostor {
      async handle(_ctx: HttpContext, next: Next): Promise<Response> {
        return next()
      }
    }
    expect((await bootError(customApp({}, (m) => m.alias({ csrf: Impostor })))).code).toBe(
      'reserved_middleware_alias',
    )
  })

  it('an ability must return exactly true', async () => {
    const prepared = await customApp(
      { api: defineRoutes([Route.get('/x', ok).middleware('can:truthy')]) },
      (m) => m.defineAbility('truthy', () => 'yes' as unknown as boolean),
    )
    ;(await prepared.client.getJson('/api/x')).assertStatus(403)
  })

  it('buckets IPv6 clients by /64 for the default throttle key', async () => {
    const prepared = await customApp({
      web: defineRoutes([Route.get('/limited', ok).middleware('throttle:1,1')]),
    })
    ;(await prepared.client.fromIp('2001:db8:1:2::1').getJson('/limited')).assertStatus(200)
    ;(await prepared.client.fromIp('2001:db8:1:2:ffff::9').getJson('/limited')).assertStatus(429)
    ;(await prepared.client.fromIp('2001:db8:1:3::1').getJson('/limited')).assertStatus(200)
  })
})

describe('the security profile (route:list --security)', () => {
  it('shows protections, flags every opt-out and where it was written', async () => {
    class HookController {
      static readonly middleware = [csrf({ except: ['receive'] })]
      receive(ctx: HttpContext): Response {
        return ctx.json({})
      }
    }
    const prepared = await customApp(
      {
        web: defineRoutes([
          Route.post('/hook', ok).withoutMiddleware('csrf'),
          Route.withoutMiddleware('csrf').group([Route.post('/grouped', ok)]),
        ]),
        api: defineRoutes([
          Route.post('/webhooks/stripe', ok),
          Route.post('/receive', [HookController, 'receive']),
          Route.get('/me', ok).middleware('auth'),
        ]),
      },
      (m) => m.validateCsrfTokens({ except: ['api/webhooks/*'] }),
    )
    const { app } = prepared
    const profile = (uri: string) => {
      const route = app.routes.find((candidate) => candidate.uri === uri)
      if (route === undefined) throw new Error(uri)
      return app.securityProfile(route)
    }
    expect(profile('/hook').optOuts).toEqual([{ alias: 'csrf', source: 'route' }])
    expect(profile('/grouped').optOuts).toEqual([{ alias: 'csrf', source: 'group' }])
    expect(profile('/api/webhooks/stripe').optOuts).toEqual([
      { alias: 'csrf', source: 'app', detail: 'api/webhooks/*' },
    ])
    expect(profile('/api/receive').optOuts).toEqual([{ alias: 'csrf', source: 'controller' }])
    expect(profile('/api/me').protections).toEqual(['csrf', 'auth', 'throttle:api'])
    expect(profile('/_strutvane/csp-report')).toMatchObject({
      protections: ['throttle:60,1'],
      optOuts: [{ alias: 'csrf', source: 'route' }],
      warnings: [],
    })
  })

  it('warns about unsafe routes without CSRF and developer routes without auth', async () => {
    const app = Application.configure({ basePath: BLOG_BASE, env: testEnv })
      .withConfig(blogConfig)
      .create()
    app.addRoutes(
      defineRoutes([
        Route.post('/_tools/reset', ok),
        Route.get('/_tools/ok', ok).name('tools.ok').middleware('signed'),
      ]),
    )
    await app.boot()
    const profile = (uri: string) => {
      const route = app.routes.find((candidate) => candidate.uri === uri)
      if (route === undefined) throw new Error(uri)
      return app.securityProfile(route)
    }
    expect(profile('/_tools/reset').warnings).toEqual([
      'unsafe method with no CSRF check',
      'developer tool route without auth',
    ])
    expect(profile('/_tools/ok').warnings).toEqual([])
    expect(profile('/up').warnings).toEqual([])
  })
})

describe('CSRF bypass attempts (attack-style)', () => {
  it('missing Sec-Fetch-Site and Origin needs the token; Referer is never trusted', async () => {
    const prepared = await blogApp()
    expect(await forgedPost(prepared, '/api/posts')).toBe(419)
    expect(await forgedPost(prepared, '/api/posts', { referer: 'http://localhost/posts' })).toBe(
      419,
    )
    expect(await forgedPost(prepared, '/api/posts', { 'sec-fetch-site': 'none' })).toBe(419)
    expect(await forgedPost(prepared, '/api/posts', { 'sec-fetch-site': 'same-origin' })).toBe(401)
  })

  it('null Origin and sibling subdomains never pass, with or without fetch metadata', async () => {
    const prepared = await blogApp()
    for (const origin of [
      'null',
      'http://evil.localhost',
      'http://localhost.evil.com',
      'http://localhost:8080',
      'https://localhost',
    ])
      expect(await forgedPost(prepared, '/api/posts', { origin }), origin).toBe(419)
    expect(
      await forgedPost(prepared, '/api/posts', {
        'sec-fetch-site': 'same-site',
        origin: 'http://localhost',
      }),
    ).toBe(419)
    expect(await forgedPost(prepared, '/api/posts', { origin: 'http://localhost' })).toBe(401)
  })

  it('a session cookie plus a junk bearer header is still checked (CONSISTENCY #124)', async () => {
    const prepared = await blogApp()
    expect(await forgedPost(prepared, '/api/posts', { authorization: 'Bearer forged' })).toBe(419)
    expect(await forgedPost(prepared, '/api/posts', { authorization: 'Basic YTpi' })).toBe(419)
    // No session cookie at all: nothing a browser could forge, so no check.
    ;(
      await prepared.client
        .withHeaders({ 'sec-fetch-site': 'cross-site' })
        .postJson('/api/posts', {})
    ).assertStatus(401)
    const ctx = new HttpContext({
      request: new Request('http://localhost/', {
        headers: { ...cookie, authorization: 'Bearer x' },
      }),
      sessionCookie: prepared.app.security.csrf.cookie,
    })
    expect(ctx.sessionId()).toBeUndefined()
    expect(ctx.sessionCookieValue()).toBe(SESSION)
  })

  it('header and query method overrides are ignored: a forged POST stays a checked POST', async () => {
    const prepared = await blogApp()
    expect(await forgedPost(prepared, '/api/posts', { 'x-http-method-override': 'GET' })).toBe(419)
    expect(await forgedPost(prepared, '/api/posts?_method=GET')).toBe(419)
    // A GET asking to be a POST stays a GET: it lists, it never creates.
    ;(
      await prepared.client
        .withHeaders({ ...cookie, 'x-http-method-override': 'POST' })
        .getJson('/api/posts?_method=POST')
    ).assertStatus(200)
  })

  it('JSON content-type tricks: text/plain and form bodies are refused, before and after CSRF', async () => {
    const prepared = await blogApp()
    const body = JSON.stringify({ title: 'Simple request' })
    const alice = prepared.client.actingAs(author(prepared, 2))
    for (const type of [
      'text/plain',
      'text/plain; charset=application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      expect(
        (
          await prepared.client
            .withHeaders({ ...cookie, 'content-type': type })
            .send('POST', '/api/posts', body)
        ).status,
        type,
      ).toBe(419)
      expect(
        (await alice.withHeaders({ 'content-type': type }).send('POST', '/api/posts', body)).status,
        type,
      ).toBe(415)
    }
    ;(
      await alice
        .withHeaders({ 'content-type': 'application/json; charset=utf-8' })
        .send('POST', '/api/posts', body)
    ).assertStatus(201)
  })
})

describe('_method spoofing (attack-style)', () => {
  const spoofRoutes = {
    web: defineRoutes([
      Route.delete('/things/{id}', (ctx) =>
        ctx.json({ deleted: ctx.param('id'), method: ctx.method }),
      ),
      Route.put('/things/{id}', (ctx) => ctx.json({ put: ctx.param('id') })),
      Route.get('/things/{id}', (ctx) => ctx.json({ shown: ctx.param('id') })),
    ]),
  }

  it('turns a POST form into PUT, PATCH or DELETE, and CSRF runs on the spoofed request', async () => {
    const prepared = await customApp(spoofRoutes)
    const form = prepared.client.withHeaders(cookie)
    ;(await form.postForm('/things/7', { _method: 'DELETE', _token: tokenFor(prepared) }))
      .assertStatus(200)
      .assertJsonPath('method', 'DELETE')
    ;(await form.postForm('/things/7', { _method: 'put', _token: tokenFor(prepared) }))
      .assertStatus(200)
      .assertJsonPath('put', '7')
    // The forged spoofed DELETE (no token) is refused exactly like a real one.
    ;(await form.postForm('/things/7', { _method: 'DELETE' })).assertProblem(
      419,
      'csrf_token_mismatch',
    )
  })

  it('refuses spoofing to GET, HEAD or TRACE, and nonsense', async () => {
    const prepared = await customApp(spoofRoutes)
    const form = prepared.client.withHeaders({}).withoutCsrf()
    for (const method of ['GET', 'HEAD', 'TRACE', 'CONNECT', 'FOO'])
      (await form.postForm('/things/7', { _method: method })).assertProblem(
        400,
        'invalid_method_override',
      )
  })

  it('never spoofs a GET, and ignores a _method in the query string', async () => {
    const prepared = await customApp(spoofRoutes)
    ;(await prepared.client.getJson('/things/7?_method=DELETE')).assertJsonPath('shown', '7')
    ;(await prepared.client.withoutCsrf().postForm('/things/7?_method=DELETE', {})).assertProblem(
      405,
      'method_not_allowed',
    )
  })
})

describe('regression: oversized form bodies never hang the request', () => {
  it('a forged form bigger than the token read limit is refused promptly (cloned-body cancel)', async () => {
    const prepared = await customApp({ web: defineRoutes([Route.post('/form', ok)]) })
    const big = await prepared.client
      .withHeaders(cookie)
      .postForm('/form', { _method: 'PUT', pad: 'x'.repeat(70 * 1024) })
    big.assertProblem(419, 'csrf_token_mismatch')
  })
})
