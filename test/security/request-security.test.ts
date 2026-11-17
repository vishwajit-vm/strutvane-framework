/**
 * The pure parts of spike 12's request-security suite: header building (a fresh CSP nonce per
 * call, HSTS only in production over a really-HTTPS connection, CR/LF and directive injection
 * refused at configuration time, a route's own CSP wins), trusted proxies (`X-Forwarded-*`
 * spoofing), and CORS (off by default, exact allowlist, `*` with credentials refused).
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  forwardedClient,
  type ResolvedProxies,
  resolveTrustProxy,
  trustedHops,
} from '../../src/http/proxy.ts'
import { securityHeaders } from '../../src/http/security.ts'
import {
  CORS_OFF,
  corsHeaders,
  corsPreflight,
  type ResolvedCors,
  resolveCors,
} from '../../src/security/cors.ts'
import {
  applySecurityHeaders,
  CSP_REPORT_PATH,
  createCspNonce,
  cspValue,
  cspWeakness,
  type HeaderOptions,
  resolveHeaders,
} from '../../src/security/secure-headers.ts'
import { SecuritySettingError } from '../../src/security/setting-error.ts'

function problemsOf(run: () => unknown): readonly string[] {
  try {
    run()
  } catch (error) {
    if (error instanceof SecuritySettingError) return error.problems
    throw error
  }
  throw new Error('Expected a SecuritySettingError')
}

const PROD = { environment: 'production' }
const LOCAL = { environment: 'local' }

describe('security headers', () => {
  it('builds the page defaults, with a fresh nonce per response', () => {
    const resolved = resolveHeaders({}, LOCAL)
    const first = new Headers()
    const second = new Headers()
    const a = createCspNonce()
    const b = createCspNonce()
    expect(a).not.toBe(b)
    applySecurityHeaders(first, resolved, { nonce: a, secure: false, environment: 'local' })
    applySecurityHeaders(second, resolved, { nonce: b, secure: false, environment: 'local' })
    const csp = first.get('content-security-policy') ?? ''
    expect(csp).toContain(`script-src 'self' 'nonce-${a}'`)
    expect(csp).toContain(`style-src 'self' 'nonce-${a}'`)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain(`report-uri ${CSP_REPORT_PATH}`)
    expect(csp).not.toContain('upgrade-insecure-requests')
    expect(second.get('content-security-policy')).not.toContain(a)
    expect(first.get('x-content-type-options')).toBe('nosniff')
    expect(first.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(first.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(first.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(first.get('permissions-policy')).toContain('camera=()')
    expect(first.get('x-frame-options')).toBe('DENY')
    expect(first.get('cache-control')).toBeNull()
  })

  it('sends HSTS only in production over HTTPS', () => {
    const resolved = resolveHeaders({}, PROD)
    const hsts = (secure: boolean, environment: string): string | null => {
      const headers = new Headers()
      applySecurityHeaders(headers, resolved, { nonce: createCspNonce(), secure, environment })
      return headers.get('strict-transport-security')
    }
    expect(hsts(true, 'production')).toBe('max-age=31536000; includeSubDomains')
    expect(hsts(false, 'production')).toBeNull()
    expect(hsts(true, 'local')).toBeNull()
    expect(hsts(true, 'testing')).toBeNull()
    expect(cspValue(resolved.csp ?? new Map(), createCspNonce())).toContain(
      'upgrade-insecure-requests',
    )
    expect(resolveHeaders({ hsts: { maxAge: 63_072_000, preload: true } }, PROD).hsts).toBe(
      'max-age=63072000; includeSubDomains; preload',
    )
    expect(resolveHeaders({ hsts: { includeSubDomains: false } }, PROD).hsts).toBe(
      'max-age=31536000',
    )
    expect(resolveHeaders({ hsts: false }, PROD).hsts).toBeUndefined()
    expect(resolveHeaders({ hsts: { maxAge: 0 } }, PROD).hsts).toBeUndefined()
  })

  it('HSTS never follows a spoofed X-Forwarded-Proto from an untrusted peer', () => {
    const resolved = resolveHeaders({}, PROD)
    const proxies = resolveTrustProxy(['10.0.0.0/8'])
    const request = new Request('http://blog.example.com/page', {
      headers: { 'x-forwarded-proto': 'https' },
    })
    const headersFrom = (peer: string): Headers => {
      const headers = new Headers()
      const client = forwardedClient(peer, request, proxies)
      applySecurityHeaders(headers, resolved, {
        nonce: createCspNonce(),
        secure: client.secure,
        environment: 'production',
      })
      return headers
    }
    expect(headersFrom('10.0.0.5').get('strict-transport-security')).not.toBeNull()
    expect(headersFrom('198.51.100.9').get('strict-transport-security')).toBeNull()
  })

  it("keeps headers the response set itself (a route's own CSP wins)", () => {
    const resolved = resolveHeaders({ cspReportOnly: true }, LOCAL)
    const own = new Headers({
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'SAMEORIGIN',
    })
    applySecurityHeaders(own, resolved, {
      nonce: createCspNonce(),
      secure: false,
      environment: 'local',
    })
    expect(own.get('content-security-policy')).toBe("default-src 'none'")
    expect(own.get('content-security-policy-report-only')).toBeNull()
    expect(own.get('x-frame-options')).toBe('SAMEORIGIN')
    const reportOnly = new Headers()
    applySecurityHeaders(reportOnly, resolved, {
      nonce: createCspNonce(),
      secure: false,
      environment: 'local',
    })
    expect(reportOnly.get('content-security-policy')).toBeNull()
    expect(reportOnly.get('content-security-policy-report-only')).toContain('script-src')
  })

  it("adds configured CSP sources (replacing 'none') and can turn CSP off", () => {
    const resolved = resolveHeaders(
      {
        csp: {
          'img-src': ['https://images.example.com'],
          'frame-ancestors': ['https://partner.example.com'],
          'worker-src': ["'self'", "'nonce-{nonce}'"],
        },
      },
      LOCAL,
    )
    const policy = cspValue(resolved.csp ?? new Map(), 'abcdefghijklmnop')
    expect(policy).toContain("img-src 'self' data: https://images.example.com")
    expect(policy).toContain('frame-ancestors https://partner.example.com')
    expect(policy).toContain("worker-src 'self' 'nonce-abcdefghijklmnop'")
    const off = resolveHeaders({ csp: false }, LOCAL)
    expect(off.csp).toBeUndefined()
    const headers = new Headers()
    applySecurityHeaders(headers, off, {
      nonce: createCspNonce(),
      secure: false,
      environment: 'local',
    })
    expect(headers.get('content-security-policy')).toBeNull()
  })

  it('the api preset is what the JSON API sends', () => {
    const resolved = resolveHeaders({ preset: 'api' }, PROD)
    const headers = new Headers()
    applySecurityHeaders(headers, resolved, {
      nonce: createCspNonce(),
      secure: true,
      environment: 'production',
    })
    expect(headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(headers.get('referrer-policy')).toBe('no-referrer')
    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get('permissions-policy')).toContain('publickey-credentials-get=(self)')
    expect(
      resolveHeaders({ preset: 'api', cacheControl: false }, PROD).fixed.map(([n]) => n),
    ).not.toContain('cache-control')
    expect(resolveHeaders({ cacheControl: 'private, no-cache' }, PROD).fixed).toContainEqual([
      'cache-control',
      'private, no-cache',
    ])
  })

  it('header injection: sources and values that smuggle directives or lines are refused, all at once', () => {
    const problems = problemsOf(() =>
      resolveHeaders(
        {
          csp: {
            'script-src': [
              "'self'; script-src *",
              'https://a.example.com\r\nX-Evil: 1',
              "'unsafe-inline' ",
            ],
            'bad directive': ['x'],
            'img-src': 'https://x' as unknown as readonly string[],
          },
          permissionsPolicy: 'camera=()\r\nSet-Cookie: a=b',
          referrerPolicy: 'unsafe-url',
          cacheControl: 'no-store\nx: y',
          hsts: { maxAge: -1 },
          preset: 'web' as 'page',
        },
        PROD,
      ),
    )
    expect(problems).toHaveLength(10)
    expect(problems.join('\n')).toContain('would inject another directive')
    expect(
      problemsOf(() => resolveHeaders({ hsts: { preload: true, maxAge: 60 } }, PROD))[0],
    ).toContain('preload')
    expect(problemsOf(() => resolveHeaders({ cacheControl: '' }, PROD))).toHaveLength(1)
  })

  it('CR/LF can never split a header: the platform refuses it, and nonces are checked', () => {
    expect(() => new Headers({ 'x-name': 'a\r\nset-cookie: admin=1' })).toThrow(TypeError)
    const resolved = resolveHeaders({}, LOCAL)
    expect(() =>
      applySecurityHeaders(new Headers(), resolved, {
        nonce: "abc'; script-src *",
        secure: false,
        environment: 'local',
      }),
    ).toThrow(TypeError)
  })

  it('rates the CSP for security:check', () => {
    expect(cspWeakness(undefined)).toBe('CSP is turned off')
    expect(cspWeakness(resolveHeaders({}, LOCAL).csp)).toBeUndefined()
    expect(
      cspWeakness(resolveHeaders({ csp: { 'script-src': ["'unsafe-inline'"] } }, LOCAL).csp),
    ).toBe("script-src allows 'unsafe-inline'")
    expect(cspWeakness(new Map([['default-src', ['*']]]))).toBe('script-src allows *')
  })

  it('the Hono middleware uses the same builder, with the api preset and a nonce hook', async () => {
    const options: HeaderOptions = { preset: 'page' }
    const nonce = createCspNonce()
    const page = new Hono()
    page.use('*', securityHeaders({ headers: options, environment: 'local', nonce: () => nonce }))
    page.get('/', (c) => c.text('ok'))
    const response = await page.request('https://x.test/')
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`)
    expect(response.headers.get('strict-transport-security')).toBeNull()
    const api = new Hono()
    api.use('*', securityHeaders({ hstsMaxAge: 0 }))
    api.get('/', (c) => c.text('ok'))
    const apiResponse = await api.request('https://x.test/')
    expect(apiResponse.headers.get('strict-transport-security')).toBeNull()
    expect(apiResponse.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    const noHsts = new Hono()
    noHsts.use('*', securityHeaders({ hstsMaxAge: 60, headers: { hsts: false } }))
    noHsts.get('/', (c) => c.text('ok'))
    expect(
      (await noHsts.request('https://x.test/')).headers.get('strict-transport-security'),
    ).toBeNull()
    expect(() => securityHeaders({ headers: { referrerPolicy: 'nope' } })).toThrow(
      SecuritySettingError,
    )
  })
})

describe('trusted proxies (X-Forwarded spoofing)', () => {
  const request = (headers: Record<string, string>, url = 'http://localhost/ip'): Request =>
    new Request(url, { headers })

  it('ignores X-Forwarded-* from an untrusted peer, and from anyone when none are configured', () => {
    const proxies = resolveTrustProxy(['10.0.0.0/8'])
    const spoof = request({
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
    })
    expect(forwardedClient('198.51.100.9', spoof, proxies)).toEqual({
      ip: '198.51.100.9',
      secure: false,
      host: 'localhost',
    })
    for (const none of [undefined, false, 0, [] as string[]])
      expect(forwardedClient('10.0.0.5', spoof, resolveTrustProxy(none)).ip).toBe('10.0.0.5')
    expect(forwardedClient(undefined, spoof, proxies).ip).toBeUndefined()
    expect(forwardedClient('garbage', spoof, proxies).ip).toBeUndefined()
  })

  it('takes the right-most untrusted address, so a client-written left entry is ignored', () => {
    const proxies = resolveTrustProxy(['10.0.0.0/8', '192.168.1.1'])
    const via = (xff: string): string | undefined =>
      forwardedClient('10.0.0.5', request({ 'x-forwarded-for': xff }), proxies).ip
    expect(via('6.6.6.6, 203.0.113.7, 192.168.1.1')).toBe('203.0.113.7')
    expect(via('2001:db8::1')).toBe('2001:db8:0:0:0:0:0:1')
    expect(via('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(via('10.0.0.9, 10.0.0.8')).toBe('10.0.0.9')
    expect(
      forwardedClient('::ffff:10.0.0.5', request({ 'x-forwarded-for': '1.1.1.1' }), proxies).ip,
    ).toBe('1.1.1.1')
    expect(forwardedClient('10.0.0.5', request({}), proxies).ip).toBe('10.0.0.5')
  })

  it('distrusts the whole header when any entry is garbage', () => {
    const proxies = resolveTrustProxy({ at: ['10.0.0.0/8'] })
    for (const header of [
      'not-an-ip, 203.0.113.7',
      '203.0.113.7, 1.2.3.4:80',
      '127.0.0.1%eth0',
      '',
    ])
      expect(
        forwardedClient('10.0.0.5', request({ 'x-forwarded-for': header }), proxies).ip,
        header,
      ).toBe('10.0.0.5')
  })

  it('reads proto and host from a trusted proxy only, and only the headers it was told to', () => {
    const proxies = resolveTrustProxy(['10.0.0.0/8'])
    const trusted = forwardedClient(
      '10.0.0.5',
      request({
        'x-forwarded-proto': 'http, https',
        'x-forwarded-host': 'a.example, Blog.Example.com:8443',
      }),
      proxies,
    )
    expect(trusted).toEqual({ ip: '10.0.0.5', secure: true, host: 'blog.example.com' })
    const garbage = forwardedClient(
      '10.0.0.5',
      request(
        { 'x-forwarded-proto': 'gopher', 'x-forwarded-host': 'evil.example/path' },
        'https://localhost/',
      ),
      proxies,
    )
    expect(garbage).toEqual({ ip: '10.0.0.5', secure: true, host: 'localhost' })
    const onlyFor = resolveTrustProxy({ at: ['10.0.0.0/8'], headers: ['for'] })
    expect(
      forwardedClient(
        '10.0.0.5',
        request({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.1.1.1' }),
        onlyFor,
      ),
    ).toEqual({ ip: '1.1.1.1', secure: false, host: 'localhost' })
    const downgrade = forwardedClient(
      '10.0.0.5',
      request({ 'x-forwarded-proto': 'http' }, 'https://localhost/'),
      proxies,
    )
    expect(downgrade.secure).toBe(false)
  })

  it('the hop-count model trusts the nearest hops by position', () => {
    const one = resolveTrustProxy(true)
    expect(one.hops).toBe(1)
    const client = forwardedClient(
      '10.0.0.2',
      request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7', 'x-forwarded-proto': 'https' }),
      one,
    )
    expect(client).toEqual({ ip: '198.51.100.7', secure: true, host: 'localhost' })
    expect(
      forwardedClient('10.0.0.2', request({ 'x-forwarded-for': 'junk' }), one).ip,
    ).toBeUndefined()
    expect(
      forwardedClient(
        '10.0.0.2',
        request({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }),
        resolveTrustProxy(2),
      ).ip,
    ).toBe('1.1.1.1')
    const hostOff: ResolvedProxies = { ...one, headers: ['for'] }
    expect(forwardedClient('10.0.0.2', request({ 'x-forwarded-for': '1.1.1.1' }), hostOff).ip).toBe(
      '1.1.1.1',
    )
  })

  it('refuses "*", malformed ranges, impossible hop counts and unknown headers, all at once', () => {
    expect(problemsOf(() => resolveTrustProxy(['*', '10.0.0.0/33', '10.0.0.0/8']))).toHaveLength(2)
    expect(problemsOf(() => resolveTrustProxy(33))).toHaveLength(1)
    expect(problemsOf(() => resolveTrustProxy(-1))).toHaveLength(1)
    expect(
      problemsOf(() => resolveTrustProxy({ at: ['10.0.0.1'], headers: ['port' as 'for'] })),
    ).toHaveLength(1)
    expect(() => trustedHops(['10.0.0.0/8'])).toThrow(RangeError)
  })
})

describe('CORS', () => {
  const cors = (options: Parameters<typeof resolveCors>[0]): ResolvedCors => resolveCors(options)
  const preflight = (origin: string, headers = 'content-type', path = '/api/data'): Request =>
    new Request(`http://localhost${path}`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': headers,
      },
    })
  const actual = (origin: string, path = '/api/data'): Request =>
    new Request(`http://localhost${path}`, { headers: { origin } })

  it('is off by default: no CORS headers, no preflight answers', () => {
    expect(resolveCors(undefined)).toBe(CORS_OFF)
    expect(corsPreflight(preflight('https://app.example.com'), CORS_OFF)).toBeUndefined()
    const headers = new Headers()
    corsHeaders(actual('https://app.example.com'), CORS_OFF, headers)
    expect([...headers]).toEqual([])
  })

  it('answers exact allowed origins only, with Vary: Origin', () => {
    const settings = cors({
      origins: ['https://App.Example.com'],
      credentials: true,
      exposedHeaders: ['x-ratelimit-remaining'],
    })
    const allowed = new Headers()
    corsHeaders(actual('https://app.example.com'), settings, allowed)
    expect(allowed.get('access-control-allow-origin')).toBe('https://app.example.com')
    expect(allowed.get('access-control-allow-credentials')).toBe('true')
    expect(allowed.get('access-control-expose-headers')).toBe('x-ratelimit-remaining')
    expect(allowed.get('vary')).toContain('Origin')
    for (const origin of [
      'https://evil.example',
      'null',
      'https://app.example.com.evil.net',
      'http://app.example.com',
    ]) {
      const headers = new Headers()
      corsHeaders(actual(origin), settings, headers)
      expect(headers.get('access-control-allow-origin'), origin).toBeNull()
      expect(headers.get('vary')).toBe('Origin')
    }
    const outside = new Headers()
    corsHeaders(actual('https://app.example.com', '/web/page'), settings, outside)
    expect(outside.get('vary')).toBeNull()
    expect(
      corsPreflight(preflight('https://app.example.com', 'content-type', '/web/x'), settings),
    ).toBeUndefined()
    const ok = corsPreflight(preflight('https://app.example.com'), settings)
    expect(ok?.status).toBe(204)
    expect(ok?.headers.get('access-control-allow-methods')).toContain('PATCH')
    expect(ok?.headers.get('access-control-max-age')).toBe('600')
    expect(ok?.headers.get('access-control-allow-credentials')).toBe('true')
    const odd = corsPreflight(preflight('https://app.example.com', 'x-evil'), settings)
    expect(odd?.status).toBe(204)
    expect(odd?.headers.get('access-control-allow-origin')).toBeNull()
    // The response decorator never re-adds headers to a (refused) preflight.
    const refused = new Headers()
    corsHeaders(preflight('https://app.example.com', 'x-evil'), settings, refused)
    expect(refused.get('access-control-allow-origin')).toBeNull()
    expect(corsPreflight(actual('https://app.example.com'), settings)).toBeUndefined()
  })

  it('allows "*" only without credentials, and matches the router\'s decoded path', () => {
    const open = cors({ origins: ['*'], paths: ['/public/*'] })
    const headers = new Headers()
    corsHeaders(actual('https://any.example', '/public/%64ata'), open, headers)
    expect(headers.get('access-control-allow-origin')).toBe('*')
    expect(headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('refuses "*" with credentials and other misconfigurations at boot, all at once', () => {
    expect(problemsOf(() => resolveCors({ origins: ['*'], credentials: true }))[0]).toContain(
      'origins "*" can\'t be combined with credentials: true',
    )
    expect(
      problemsOf(() => resolveCors({ origins: ['null', 'https://a.example.com/path'] })),
    ).toHaveLength(2)
    expect(problemsOf(() => resolveCors({ origins: [] }))[0]).toContain('leave CORS off')
    expect(problemsOf(() => resolveCors({ origins: ['*', 'https://a.example.com'] }))[0]).toContain(
      'ambiguous',
    )
    expect(
      problemsOf(() =>
        resolveCors({
          origins: ['https://a.example.com'],
          methods: ['GET POST'],
          headers: ['x evil'],
          exposedHeaders: ['a\r\nb'],
          maxAge: 90_000,
          paths: [' '],
        }),
      ),
    ).toHaveLength(5)
  })
})
