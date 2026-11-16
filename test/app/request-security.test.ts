/**
 * The kernel's request security: security headers with a per-request CSP nonce on every response
 * (404 and 500 included), the CSP report endpoint, trusted hosts, trusted proxies, body and JSON
 * limits with prototype-pollution-safe parsing, and CORS. Attack-style cases include Host header
 * poisoning, X-Forwarded spoofing, header injection and pollution payloads.
 */
import { describe, expect, it } from 'vitest'
import type { Application } from '../../src/foundation/application.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import type { HttpContext } from '../../src/http/app/context.ts'
import type { MiddlewareConfig } from '../../src/http/app/middleware.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { author, blogApp, customApp } from './helpers.ts'

const echo = (ctx: HttpContext): Response =>
  ctx.json({ ip: ctx.ip, secure: ctx.state.secure, host: ctx.state.host, nonce: ctx.nonce })
const echoBody = async (ctx: HttpContext): Promise<Response> => ctx.json({ body: await ctx.body() })

/** Send a raw request with a chosen socket peer. */
function send(
  app: Application,
  url: string,
  init: RequestInit = {},
  ip = '203.0.113.10',
): Promise<Response> {
  return app.handle(new Request(url, init), { ip })
}

async function bootFailure(
  configure: (m: MiddlewareConfig) => void,
  env: Record<string, string> = {},
): Promise<string> {
  const error = await customApp({}, configure, env).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (isBootError(error)) return error.message
  throw new Error(`Expected boot to fail, got ${String(error)}`)
}

describe('security headers', () => {
  it('are on every response, errors and 404s included', async () => {
    const { app } = await blogApp({ APP_DEBUG: 'false' })
    for (const path of ['/api/posts', '/api/nowhere', '/_diagnostics/boom', '/up']) {
      const response = await send(app, `http://localhost${path}`, {
        headers: { accept: 'application/json' },
      })
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      expect(response.headers.get('permissions-policy')).toContain('camera=()')
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('gives each response a fresh CSP nonce, the same one the view sees', async () => {
    const { app } = await customApp({ web: defineRoutes([Route.get('/page', echo)]) })
    const first = await send(app, 'http://localhost/page')
    const second = await send(app, 'http://localhost/page')
    const nonce = ((await first.json()) as { nonce: string }).nonce
    expect(first.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`)
    expect(second.headers.get('content-security-policy')).not.toContain(nonce)
  })

  it('a 500 never leaks the error to the client, logs it, and still gets every header', async () => {
    const { app, logger } = await blogApp({ APP_DEBUG: 'false' })
    const response = await send(app, 'http://localhost/_diagnostics/boom', {
      headers: { accept: 'application/json' },
    })
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain('reading "title"')
    expect(text).toContain('INTERNAL_ERROR')
    expect(logger.messages('error')).toContain('Unhandled error while serving a request')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
  })

  it('shows debug details only with APP_DEBUG in local or testing', async () => {
    const debug = await blogApp({ APP_DEBUG: 'true' })
    const shown = await (
      await send(debug.app, 'http://localhost/_diagnostics/boom', {
        headers: { accept: 'application/json' },
      })
    ).json()
    expect(JSON.stringify(shown)).toContain('reading \\"title\\"')
    const production = await blogApp(
      { APP_ENV: 'production', APP_DEBUG: 'true' },
      { forceDebug: true },
    )
    const plain = await (await send(production.app, 'http://localhost/_diagnostics/boom')).text()
    expect(plain).not.toContain('reading')
    expect(production.logger.messages('warn').join('\n')).toContain('--force-debug')
  })

  it('sends HSTS only in production over HTTPS, never from a spoofed X-Forwarded-Proto', async () => {
    const routes = { web: defineRoutes([Route.get('/page', echo)]) }
    const testing = await customApp(routes)
    expect(
      (await send(testing.app, 'http://localhost/page')).headers.get('strict-transport-security'),
    ).toBeNull()
    const production = await customApp(routes, (m) => m.trustProxies({ at: ['10.0.0.0/8'] }), {
      APP_ENV: 'production',
      APP_DEBUG: 'false',
      APP_URL: 'https://blog.example.com',
    })
    const overHttps = await send(
      production.app,
      'http://blog.example.com/page',
      { headers: { 'x-forwarded-proto': 'https' } },
      '10.0.0.5',
    )
    expect(overHttps.headers.get('strict-transport-security')).toContain('max-age=')
    const spoofed = await send(
      production.app,
      'http://blog.example.com/page',
      { headers: { 'x-forwarded-proto': 'https' } },
      '198.51.100.9',
    )
    expect(spoofed.headers.get('strict-transport-security')).toBeNull()
  })

  it('adds configured CSP sources and supports report-only', async () => {
    const { app } = await customApp({ web: defineRoutes([Route.get('/page', echo)]) }, (m) =>
      m.securityHeaders({
        csp: { 'img-src': ['https://images.example.com'] },
        cspReportOnly: true,
      }),
    )
    const response = await send(app, 'http://localhost/page')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(response.headers.get('content-security-policy-report-only')).toContain(
      'https://images.example.com',
    )
  })

  it('header injection: CSP sources that smuggle directives are refused at boot', async () => {
    expect(
      await bootFailure((m) =>
        m.securityHeaders({ csp: { 'script-src': ["'self'; script-src *"] } }),
      ),
    ).toContain('security setting')
  })

  it('header injection: a CR/LF in a response header value never splits a header', async () => {
    const { app } = await customApp(
      {
        web: defineRoutes([
          Route.get('/inject', (ctx) =>
            ctx.json({}, 200, { 'x-name': 'a\r\nset-cookie: admin=1' }),
          ),
        ]),
      },
      () => {},
      { APP_DEBUG: 'false' },
    )
    const response = await send(app, 'http://localhost/inject')
    expect(response.status).toBe(500)
    expect(response.headers.get('set-cookie') ?? '').not.toContain('admin=1')
  })
})

describe('the CSP report endpoint', () => {
  const report = (body: unknown, type = 'application/csp-report'): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': type },
    body: JSON.stringify(body),
  })

  it('logs sanitised violations through the Logger, never query strings or control characters', async () => {
    const { app, logger } = await blogApp()
    const response = await send(
      app,
      'http://localhost/_strutvane/csp-report',
      report({
        'csp-report': {
          'document-uri': 'http://localhost/reset?token=SECRET123',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'https://evil.example/x.js?session=SECRET456',
          'line-number': 7,
          'source-file': 'http://localhost/app.js\n{"level":"error"}',
        },
      }),
    )
    expect(response.status).toBe(204)
    const entry = logger.entries.find((candidate) => candidate.message === 'CSP violation')
    expect(entry?.level).toBe('warn')
    expect(entry?.fields).toMatchObject({
      directive: 'script-src-elem',
      blocked: 'https://evil.example',
      document: '/reset',
      line: 7,
    })
    expect(JSON.stringify(logger.entries)).not.toContain('SECRET')
  })

  it('accepts the Reporting API format and caps what it reads', async () => {
    const { app, logger } = await blogApp()
    const many = Array.from({ length: 30 }, () => ({
      type: 'csp-violation',
      body: { documentURL: 'http://localhost/', effectiveDirective: 'img-src', blockedURL: 'data' },
    }))
    expect(
      (
        await send(
          app,
          'http://localhost/_strutvane/csp-report',
          report(many, 'application/reports+json'),
        )
      ).status,
    ).toBe(204)
    expect(logger.entries.filter((entry) => entry.message === 'CSP violation')).toHaveLength(10)
    expect(
      (await send(app, 'http://localhost/_strutvane/csp-report', report({}, 'text/plain'))).status,
    ).toBe(415)
    expect(
      (
        await send(
          app,
          'http://localhost/_strutvane/csp-report',
          report({ 'csp-report': { pad: 'x'.repeat(20_000) } }),
        )
      ).status,
    ).toBe(413)
    expect(
      (
        await send(app, 'http://localhost/_strutvane/csp-report', {
          method: 'POST',
          headers: { 'content-type': 'application/csp-report' },
          body: '{"__proto__":{}}',
        })
      ).status,
    ).toBe(400)
  })
})

describe('trusted hosts (Host header poisoning)', () => {
  it('refuses a request for a host that is not on the allowlist, without echoing it', async () => {
    const { app } = await blogApp()
    const poisoned = await send(app, 'http://evil.example/api/posts', {
      headers: { accept: 'application/json' },
    })
    expect(poisoned.status).toBe(400)
    const body = await poisoned.text()
    expect(body).toContain('untrusted_host')
    expect(body).not.toContain('evil.example')
    for (const host of ['localhost', '127.0.0.1', '[::1]'])
      expect((await send(app, `http://${host}/api/posts`)).status, host).toBe(200)
    expect(
      (await send(app, 'http://localhost/api/posts', { headers: { host: 'evil.example' } })).status,
    ).toBe(400)
  })

  it('allows only APP_URL in production by default, and patterns when configured', async () => {
    const env = { APP_ENV: 'production', APP_DEBUG: 'false', APP_URL: 'https://blog.example.com' }
    const routes = { web: defineRoutes([Route.get('/page', echo)]) }
    const plain = await customApp(routes, () => {}, env)
    expect((await send(plain.app, 'https://blog.example.com/page')).status).toBe(200)
    expect((await send(plain.app, 'https://evilblog.example.com/page')).status).toBe(400)
    const patterns = await customApp(
      routes,
      (m) => m.trustHosts({ at: ['example.com'], subdomains: true }),
      env,
    )
    expect((await send(patterns.app, 'https://api.example.com/page')).status).toBe(200)
    expect((await send(patterns.app, 'https://example.com.evil.net/page')).status).toBe(400)
  })

  it('X-Forwarded-Host counts only from a trusted proxy, and is then checked too', async () => {
    const { app } = await customApp({ web: defineRoutes([Route.get('/page', echo)]) }, (m) =>
      m.trustProxies({ at: ['10.0.0.0/8'] }),
    )
    const fromClient = await send(
      app,
      'http://localhost/page',
      { headers: { 'x-forwarded-host': 'evil.example' } },
      '198.51.100.9',
    )
    expect(((await fromClient.json()) as { host: string }).host).toBe('localhost')
    expect(
      (
        await send(
          app,
          'http://localhost/page',
          { headers: { 'x-forwarded-host': 'evil.example' } },
          '10.1.1.1',
        )
      ).status,
    ).toBe(400)
  })

  it('refuses "*" as a trusted host at boot', async () => {
    expect(await bootFailure((m) => m.trustHosts({ at: ['*'] }))).toContain(
      '"*" alone would trust every host',
    )
  })
})

describe('trusted proxies (X-Forwarded spoofing)', () => {
  const routes = { web: defineRoutes([Route.get('/ip', echo)]) }
  const ipOf = async (response: Response): Promise<string> =>
    ((await response.json()) as { ip: string }).ip

  it('ignores X-Forwarded-For from an untrusted peer, and when no proxy is configured', async () => {
    const { app } = await customApp(routes, (m) => m.trustProxies({ at: ['10.0.0.0/8'] }))
    expect(
      await ipOf(
        await send(
          app,
          'http://localhost/ip',
          { headers: { 'x-forwarded-for': '1.2.3.4' } },
          '198.51.100.9',
        ),
      ),
    ).toBe('198.51.100.9')
    const none = await customApp(routes)
    expect(
      await ipOf(
        await send(
          none.app,
          'http://localhost/ip',
          { headers: { 'x-forwarded-for': '1.2.3.4' } },
          '10.0.0.5',
        ),
      ),
    ).toBe('10.0.0.5')
  })

  it('takes the right-most untrusted address, and distrusts garbage', async () => {
    const { app } = await customApp(routes, (m) =>
      m.trustProxies({ at: ['10.0.0.0/8', '192.168.1.1'] }),
    )
    expect(
      await ipOf(
        await send(
          app,
          'http://localhost/ip',
          { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 192.168.1.1' } },
          '10.0.0.5',
        ),
      ),
    ).toBe('203.0.113.7')
    expect(
      await ipOf(
        await send(
          app,
          'http://localhost/ip',
          { headers: { 'x-forwarded-for': 'not-an-ip, 203.0.113.7' } },
          '10.0.0.5',
        ),
      ),
    ).toBe('10.0.0.5')
  })

  it('believes a client X-Request-Id only through a trusted proxy', async () => {
    const { app } = await customApp(routes, (m) => m.trustProxies({ at: ['10.0.0.0/8'] }))
    const direct = await send(
      app,
      'http://localhost/ip',
      { headers: { 'x-request-id': 'forged-request-id' } },
      '198.51.100.9',
    )
    expect(direct.headers.get('x-request-id')).not.toBe('forged-request-id')
    const proxied = await send(
      app,
      'http://localhost/ip',
      { headers: { 'x-request-id': 'proxy-request-id' } },
      '10.0.0.5',
    )
    expect(proxied.headers.get('x-request-id')).toBe('proxy-request-id')
  })

  it('refuses "*" and malformed ranges at boot', async () => {
    expect(
      await bootFailure((m) => m.trustProxies({ at: ['*', '10.0.0.0/33', '10.0.0.0/8'] })),
    ).toContain('2 security settings are unsafe or invalid')
  })
})

describe('body limits and prototype-pollution-safe JSON', () => {
  const routes = { api: defineRoutes([Route.post('/echo', echoBody)]) }

  it('refuses __proto__ and constructor.prototype payloads anywhere, and nothing is polluted', async () => {
    const prepared = await customApp(routes)
    const alice = prepared.client.actingAs(author(prepared, 2))
    for (const payload of [
      '{"__proto__":{"isAdmin":true}}',
      '{"a":[{"b":{"__proto__":{"x":1}}}]}',
      '{"constructor":{"prototype":{"isAdmin":true}}}',
      '{"\\u005f_proto__":{"x":1}}',
    ])
      (await alice.send('POST', '/api/echo', payload)).assertProblem(400, 'forbidden_json_key')
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined()
    ;(await alice.send('POST', '/api/echo', '{"constructor":"Acme Builders"}'))
      .assertStatus(200)
      .assertJsonPath('body.constructor', 'Acme Builders')
  })

  it('refuses deep and key-heavy JSON before parsing it, and honours custom limits', async () => {
    const prepared = await customApp(routes)
    const alice = prepared.client.actingAs(author(prepared, 2))
    ;(
      await alice.send('POST', '/api/echo', `${'['.repeat(100_000)}${']'.repeat(100_000)}`)
    ).assertProblem(413, 'json_too_deep')
    ;(
      await alice.send(
        'POST',
        '/api/echo',
        `{${Array.from({ length: 1001 }, (_, index) => `"k${index}":1`).join(',')}}`,
      )
    ).assertProblem(413, 'json_too_many_keys')
    ;(await alice.send('POST', '/api/echo', `"${'x'.repeat(1024 * 1024)}"`)).assertProblem(
      413,
      'PAYLOAD_TOO_LARGE',
    )
    const tight = await customApp(routes, (m) => m.limits({ maxDepth: 2, maxKeys: 3 }))
    const bob = tight.client.actingAs(author(tight, 3))
    ;(await bob.send('POST', '/api/echo', '{"a":{"b":1}}')).assertStatus(200)
    ;(await bob.send('POST', '/api/echo', '{"a":{"b":{"c":1}}}')).assertProblem(
      413,
      'json_too_deep',
    )
    expect(
      await bootFailure((m) => m.limits({ maxBytes: 0, maxDepth: 1.5, maxKeys: 10_000_000 })),
    ).toContain('3 security settings')
  })
})

describe('CORS', () => {
  const routes = { api: defineRoutes([Route.get('/data', (ctx) => ctx.json({ data: 1 }))]) }
  const preflight = (origin: string, headers = 'content-type'): RequestInit => ({
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': headers,
    },
  })

  it('is off by default: no CORS headers, no preflight answers', async () => {
    const { app } = await customApp(routes)
    expect(
      (
        await send(app, 'http://localhost/api/data', {
          headers: { origin: 'https://app.example.com' },
        })
      ).headers.get('access-control-allow-origin'),
    ).toBeNull()
    const answer = await send(
      app,
      'http://localhost/api/data',
      preflight('https://app.example.com'),
    )
    expect(answer.headers.get('access-control-allow-origin')).toBeNull()
    expect(answer.status).toBe(405)
  })

  it('answers exact allowed origins only, with Vary: Origin', async () => {
    const { app } = await customApp(routes, (m) =>
      m.cors({ origins: ['https://app.example.com'], credentials: true }),
    )
    const allowed = await send(app, 'http://localhost/api/data', {
      headers: { origin: 'https://app.example.com' },
    })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    expect(allowed.headers.get('vary')).toContain('Origin')
    for (const origin of ['https://evil.example', 'null', 'https://app.example.com.evil.net'])
      expect(
        (await send(app, 'http://localhost/api/data', { headers: { origin } })).headers.get(
          'access-control-allow-origin',
        ),
        origin,
      ).toBeNull()
    expect(
      (await send(app, 'http://localhost/api/data', preflight('https://app.example.com'))).status,
    ).toBe(204)
  })

  it('refuses "*" with credentials at boot', async () => {
    expect(await bootFailure((m) => m.cors({ origins: ['*'], credentials: true }))).toContain(
      "can't be combined with credentials",
    )
  })
})
