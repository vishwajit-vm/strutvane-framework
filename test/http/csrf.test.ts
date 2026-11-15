/**
 * CSRF attack tests (blueprint §5.2; CONSISTENCY #17, #30, #105). Every unsafe request that
 * carries the session cookie must prove it came from the app's own pages. The "session layer"
 * here is a request hook that signs in whoever presents the configured session cookie, exactly
 * as `@strutvane/auth` does; each test is named after the attack it proves impossible.
 *
 * The class covered: every route that changes state (CRUD create/update/delete/restore, custom
 * routes with and without a body, hook-answered routes) under every cookie spelling.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Actor } from '../../src/contracts/index.ts'
import { HTTP_HOOKS } from '../../src/contracts/index.ts'
import { HooksToken } from '../../src/core/index.ts'
import type { HttpAppOptions } from '../../src/http/create-http-app.ts'
import {
  CSRF_ERROR_CODE,
  csrfToken,
  exactOrigin,
  matchesPathPattern,
  resolveCsrf,
} from '../../src/http/csrf.ts'
import { route } from '../../src/http/route.ts'
import {
  cookieValues,
  SessionCookieToken,
  sessionCookieName,
  sessionCookieValue,
} from '../../src/http/session-cookie.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { frameworkProvider } from '../../src/provider.ts'
import { bootProject } from '../../src/runtime/boot.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'

const BASE = '/api/v1'
const APP_KEY = 'a6Xq3yHk0Vt9Lm2Pz8Rc5Wb1Nf7Jd4Gs'
const SESSION = 's3ss10n-v4lu3'

const Memo = defineModel('Memo', { title: field.string(80) }, { softDeletes: true })

const user: Actor = { id: 'u1', type: 'user', roles: [], attrs: {} }

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** A test app whose "session layer" signs in any request carrying `cookie`. */
async function boot(
  http: Omit<HttpAppOptions, 'resources' | 'registry' | 'database'> = {},
  cookie = 'strutvane_session',
): Promise<TestApp> {
  t = await createTestApp({
    resources: [Memo],
    http: {
      appKey: APP_KEY,
      routes: [
        route.post('/ping', { public: true, handler: () => undefined }),
        route.delete('/ping', { public: true, handler: () => undefined }),
        route.post('/oauth/callback', { public: true, handler: () => ({ ok: true }) }),
      ],
      ...http,
    },
  })
  t.app.make(HooksToken).on(
    HTTP_HOOKS.request,
    (payload) => {
      const p = payload as { request: Request; actor: Actor | null }
      const sent = cookieValues(p.request.headers.get('cookie'), cookie)[0]
      if (sent !== SESSION) return undefined
      // Sign-in answered by the hook itself, like auth's POST /login: rotates the cookie.
      if (new URL(p.request.url).pathname === '/login')
        return {
          ...p,
          response: new Response(null, {
            status: 204,
            headers: { 'set-cookie': `${cookie}=rotated; Path=/; HttpOnly` },
          }),
        }
      return { ...p, actor: user }
    },
    { name: 'test.session' },
  )
  return t
}

const token = (session = SESSION) =>
  csrfToken(
    resolveCsrf(
      {},
      {
        appKey: APP_KEY,
        publicUrl: undefined,
        cookie: sessionCookieName({ secure: false }),
      },
    ).key,
    session,
  )

async function send(
  app: TestApp,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Response> {
  return app.http.request(path, { method, headers, ...(body !== undefined ? { body } : {}) })
}

async function problemCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code
}

describe('CSRF: cross-site requests that ride on the session cookie are refused', () => {
  it('a cross-site form post to a bodyless custom route gets 419 csrf_token_mismatch', async () => {
    const app = await boot()
    const res = await send(app, 'POST', `${BASE}/ping`, {
      cookie: `strutvane_session=${SESSION}`,
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(res.status).toBe(419)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = (await res.json()) as { code: string; status: number; title: string }
    expect(body).toMatchObject({ code: CSRF_ERROR_CODE, status: 419, title: 'Page expired' })
  })

  it('every unsafe CRUD route is covered: create, update, delete and restore', async () => {
    const app = await boot()
    const memo = await app.repository(Memo).create({ title: 'm' })
    await app.repository(Memo).delete(memo.id)
    const attack = { cookie: `strutvane_session=${SESSION}`, 'sec-fetch-site': 'cross-site' }
    const json = { ...attack, 'content-type': 'application/json' }
    const calls: [string, string, Record<string, string>, string?][] = [
      ['POST', `${BASE}/memos`, json, '{"title":"x"}'],
      ['PATCH', `${BASE}/memos/${memo.id}`, json, '{"title":"x"}'],
      ['DELETE', `${BASE}/memos/${memo.id}`, attack],
      ['POST', `${BASE}/memos/${memo.id}/restore`, attack],
      ['DELETE', `${BASE}/ping`, attack],
      ['PUT', `${BASE}/memos/${memo.id}`, json, '{}'],
    ]
    for (const [method, path, headers, body] of calls) {
      const res = await send(app, method, path, headers, body)
      expect(res.status, `${method} ${path}`).toBe(419)
    }
    // Nothing changed: the soft-deleted row is still deleted.
    expect(await app.repository(Memo).find(memo.id)).toBeUndefined()
  })

  it('a no-cors fetch (no Origin, Sec-Fetch-Site cross-site) is refused', async () => {
    const app = await boot()
    const res = await send(
      app,
      'POST',
      `${BASE}/ping`,
      {
        cookie: `strutvane_session=${SESSION}`,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'content-type': 'text/plain',
      },
      'x',
    )
    expect(res.status).toBe(419)
  })

  it('a null Origin (sandboxed iframe, data: URL) never passes', async () => {
    const app = await boot()
    const res = await send(app, 'POST', `${BASE}/ping`, {
      cookie: `strutvane_session=${SESSION}`,
      origin: 'null',
    })
    expect(res.status).toBe(419)
  })

  it('a sibling subdomain (same-site, not same-origin) is refused', async () => {
    const app = await boot({ publicUrl: 'https://app.example.com' })
    for (const headers of [
      { origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example.com' },
      { origin: 'https://app.example.com.evil.test' },
      { origin: 'http://app.example.com' },
    ]) {
      const res = await send(app, 'POST', `${BASE}/ping`, {
        cookie: `__Host-strutvane_session=${SESSION}`,
        ...headers,
      })
      expect(res.status, JSON.stringify(headers)).toBe(419)
    }
  })

  it('method override headers and fields never turn a POST into a safe method', async () => {
    const app = await boot()
    const res = await send(
      app,
      'POST',
      `${BASE}/ping?_method=GET`,
      {
        cookie: `strutvane_session=${SESSION}`,
        'x-http-method-override': 'GET',
        'x-http-method': 'GET',
        'x-method-override': 'GET',
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
      '_method=GET',
    )
    expect(res.status).toBe(419)
  })

  it('the renamed cookie is checked: __Host- prefix and a custom configured name', async () => {
    const prefixed = await boot({ publicUrl: 'https://app.example.com' })
    expect(prefixed.app.make(SessionCookieToken).name).toBe('__Host-strutvane_session')
    const viaHost = await send(prefixed, 'POST', `${BASE}/ping`, {
      cookie: `__Host-strutvane_session=${SESSION}`,
      'sec-fetch-site': 'cross-site',
    })
    expect(viaHost.status).toBe(419)
    await prefixed.close()

    const custom = await boot({ session: { cookie: 'acme_sid' } }, 'acme_sid')
    expect(custom.app.make(SessionCookieToken).name).toBe('acme_sid')
    const viaCustom = await send(custom, 'POST', `${BASE}/ping`, {
      cookie: `acme_sid=${SESSION}`,
      'sec-fetch-site': 'cross-site',
    })
    expect(viaCustom.status).toBe(419)
  })

  it('a junk bearer token next to the session cookie does not switch the check off', async () => {
    const app = await boot()
    const res = await send(app, 'POST', `${BASE}/ping`, {
      cookie: `strutvane_session=${SESSION}`,
      authorization: 'Bearer junk',
      'sec-fetch-site': 'cross-site',
    })
    expect(res.status).toBe(419)
  })

  it('a token from another session, a truncated token or a forged one is refused', async () => {
    const app = await boot()
    for (const sent of [token('another-session'), token().slice(0, -1), 'x'.repeat(43), '']) {
      const res = await send(app, 'POST', `${BASE}/ping`, {
        cookie: `strutvane_session=${SESSION}; XSRF-TOKEN=${sent}`,
        'x-xsrf-token': sent,
        'sec-fetch-site': 'cross-site',
      })
      expect(res.status).toBe(419)
      expect(await problemCode(res)).toBe(CSRF_ERROR_CODE)
    }
  })

  it('a request the session hook answers itself (sign-in, logout) is checked too', async () => {
    const app = await boot()
    const res = await send(app, 'POST', '/login', {
      cookie: `strutvane_session=${SESSION}`,
      'sec-fetch-site': 'cross-site',
    })
    expect(res.status).toBe(419)
  })

  it('an except pattern cannot be reached through percent-encoding tricks', async () => {
    const app = await boot({ csrf: { except: ['api/v1/oauth/*'] } })
    const res = await send(app, 'POST', `${BASE}/oauth%2F..%2Fping`, {
      cookie: `strutvane_session=${SESSION}`,
      'sec-fetch-site': 'cross-site',
    })
    expect(res.status).not.toBe(204)
  })
})

describe('CSRF: the app’s own pages and non-browser clients still work', () => {
  it('same-origin requests pass on Sec-Fetch-Site or an exact Origin', async () => {
    const app = await boot({ publicUrl: 'https://app.example.com' })
    const cookie = `strutvane_session=${SESSION}`
    expect(
      (await send(app, 'POST', `${BASE}/ping`, { cookie, 'sec-fetch-site': 'same-origin' })).status,
    ).toBe(204)
    expect(
      (await send(app, 'POST', `${BASE}/ping`, { cookie, origin: 'https://app.example.com' }))
        .status,
    ).toBe(204)
    // The request's own (allowlisted) host counts as the app's origin, with the scheme the app
    // is served over (https here, from APP_URL), e.g. a second host name of the same app.
    expect(
      (await send(app, 'POST', `${BASE}/ping`, { cookie, origin: 'https://localhost' })).status,
    ).toBe(204)
    expect(
      (await send(app, 'POST', `${BASE}/ping`, { cookie, origin: 'http://localhost' })).status,
    ).toBe(419)
    await app.close()
    // Local development over http without APP_URL: the page's own origin passes.
    const local = await boot()
    expect(
      (await send(local, 'POST', `${BASE}/ping`, { cookie, origin: 'http://localhost' })).status,
    ).toBe(204)
  })

  it('a valid token passes in X-XSRF-TOKEN, X-CSRF-TOKEN or a form _token field', async () => {
    const app = await boot()
    const cookie = `strutvane_session=${SESSION}`
    for (const headers of [{ 'x-xsrf-token': token() }, { 'x-csrf-token': token() }]) {
      const res = await send(app, 'POST', `${BASE}/ping`, { cookie, ...headers })
      expect(res.status).toBe(204)
    }
    const form = await send(
      app,
      'POST',
      `${BASE}/ping`,
      { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      `a=1&_token=${encodeURIComponent(token())}`,
    )
    expect(form.status).toBe(204)
  })

  it('a bearer-token client without the session cookie is not checked', async () => {
    const app = await boot()
    const res = await send(app, 'POST', `${BASE}/ping`, {
      authorization: 'Bearer real-token',
      origin: 'https://other.example',
    })
    expect(res.status).toBe(204)
  })

  it('safe methods and excepted callback paths are not checked', async () => {
    const app = await boot({ csrf: { except: ['api/v1/oauth/*'] } })
    const cookie = `strutvane_session=${SESSION}`
    const callback = await send(app, 'POST', `${BASE}/oauth/callback`, {
      cookie,
      'sec-fetch-site': 'cross-site',
    })
    expect(callback.status).toBe(200)
    const read = await send(app, 'GET', '/health', { cookie, 'sec-fetch-site': 'cross-site' })
    expect(read.status).toBe(200)
  })

  it('a trusted extra origin passes; csrf: false turns the check off explicitly', async () => {
    const app = await boot({ csrf: { origins: ['https://admin.example.com'] } })
    const ok = await send(app, 'POST', `${BASE}/ping`, {
      cookie: `strutvane_session=${SESSION}`,
      origin: 'https://admin.example.com',
    })
    expect(ok.status).toBe(204)
    await app.close()
    const off = await boot({ csrf: false })
    const res = await send(off, 'POST', `${BASE}/ping`, {
      cookie: `strutvane_session=${SESSION}`,
      'sec-fetch-site': 'cross-site',
    })
    expect(res.status).toBe(204)
  })
})

describe('CSRF: the XSRF-TOKEN cookie for front-end code', () => {
  it('is set for a session, readable by scripts, SameSite=Lax, and accepted back', async () => {
    const app = await boot()
    const res = await send(app, 'GET', '/health', { cookie: `strutvane_session=${SESSION}` })
    const set = res.headers.getSetCookie().find((c) => c.startsWith('XSRF-TOKEN='))
    expect(set).toBeDefined()
    expect(set).toContain('SameSite=Lax')
    expect(set).toContain('Path=/')
    expect(set?.toLowerCase()).not.toContain('httponly')
    const value = set?.split(';')[0]?.slice('XSRF-TOKEN='.length) ?? ''
    expect(value).toBe(token())
    const echoed = await send(app, 'POST', `${BASE}/ping`, {
      cookie: `strutvane_session=${SESSION}; XSRF-TOKEN=${value}`,
      'x-xsrf-token': value,
    })
    expect(echoed.status).toBe(204)
    // In step already: not sent again.
    expect(echoed.headers.getSetCookie().some((c) => c.startsWith('XSRF-TOKEN='))).toBe(false)
  })

  it('follows a rotated session cookie, is Secure on https, and goes when the session ends', async () => {
    const app = await boot({ publicUrl: 'https://app.example.com' })
    const login = await send(app, 'POST', '/login', {
      cookie: `strutvane_session=${SESSION}`,
      'sec-fetch-site': 'same-origin',
    })
    const xsrf = login.headers.getSetCookie().find((c) => c.startsWith('XSRF-TOKEN='))
    expect(xsrf).toContain(`XSRF-TOKEN=${token('rotated')}`)
    expect(xsrf).toContain('Secure')
    const anonymous = await send(app, 'GET', '/health', { cookie: 'XSRF-TOKEN=stale' })
    expect(anonymous.headers.getSetCookie().find((c) => c.startsWith('XSRF-TOKEN='))).toContain(
      'Max-Age=0',
    )
  })

  it('is not issued to callers without a session', async () => {
    const app = await boot()
    const res = await send(app, 'GET', '/health', {})
    expect(res.headers.getSetCookie()).toEqual([])
  })
})

describe('CSRF settings and helpers fail closed', () => {
  it('refuses wildcard, null and path-carrying origins, and blank except patterns', () => {
    const where = {
      appKey: APP_KEY,
      publicUrl: undefined,
      cookie: sessionCookieName({ secure: false }),
    }
    for (const origin of [
      '*',
      'null',
      'https://a.example/path',
      'https://*.example.com',
      'ftp://a.example',
    ]) {
      expect(() => resolveCsrf({ origins: [origin] }, where), origin).toThrow(TypeError)
    }
    expect(() => resolveCsrf({ except: [' '] }, where)).toThrow(/path pattern/)
    expect(exactOrigin('https://Admin.Example.com')).toBe('https://admin.example.com')
    expect(exactOrigin('https://a.example?')).toBeUndefined()
  })

  it('path patterns match whole paths only', () => {
    expect(matchesPathPattern('webhooks/*', '/webhooks/stripe')).toBe(true)
    expect(matchesPathPattern('webhooks', '/webhooks/stripe')).toBe(false)
    expect(matchesPathPattern('a.b', '/aXb')).toBe(false)
  })

  it('session cookie names: one source, both spellings recognised, prefixes refused', () => {
    expect(sessionCookieName({ secure: true }).name).toBe('__Host-strutvane_session')
    expect(sessionCookieName({ secure: false }).name).toBe('strutvane_session')
    expect(() => sessionCookieName({ base: '__Host-x', secure: true })).toThrow(TypeError)
    expect(() => sessionCookieName({ base: 'a b', secure: false })).toThrow(TypeError)
    const cookie = sessionCookieName({ secure: true })
    expect(sessionCookieValue('strutvane_session=a', cookie)).toBe('a')
    expect(sessionCookieValue('__Host-strutvane_session=b; strutvane_session=a', cookie)).toBe('b')
    expect(sessionCookieValue('strutvane_session=', cookie)).toBeUndefined()
    expect(cookieValues('a="q"; b=2', 'a')).toEqual(['q'])
  })

  it('without an APP_KEY tokens use a per-process random key (never a fixed one)', () => {
    const where = {
      appKey: undefined,
      publicUrl: undefined,
      cookie: sessionCookieName({ secure: false }),
    }
    const a = resolveCsrf({}, where)
    const b = resolveCsrf({}, where)
    expect(csrfToken(a.key, 's')).not.toBe(csrfToken(b.key, 's'))
  })
})

describe('CSRF in a booted project: config/session.ts is the one source', () => {
  it('the cookie name, the https prefix and the except list come from the project config', async () => {
    const booted = await bootProject({
      root: process.cwd(),
      config: {
        app: { env: 'local', publicUrl: 'https://app.example.com', key: APP_KEY },
        session: { cookie: 'acme_sid', csrf: { except: ['api/v1/hooks/*'] } },
      },
      providers: [
        frameworkProvider({ database: { driver: 'sqlite', url: ':memory:' }, models: [] }),
      ],
      models: [],
      resources: [],
      routes: [route.post('/hooks/in', { public: true, handler: () => undefined })],
    })
    try {
      expect(booted.app.make(SessionCookieToken).name).toBe('__Host-acme_sid')
      const attack = await booted.http.request('/api/v1/nothing', {
        method: 'POST',
        headers: { cookie: '__Host-acme_sid=x', 'sec-fetch-site': 'cross-site' },
      })
      expect(attack.status).toBe(419)
      const callback = await booted.http.request('/api/v1/hooks/in', {
        method: 'POST',
        headers: { cookie: '__Host-acme_sid=x', 'sec-fetch-site': 'cross-site' },
      })
      expect(callback.status).toBe(204)
    } finally {
      await booted.shutdown()
    }
  })
})
