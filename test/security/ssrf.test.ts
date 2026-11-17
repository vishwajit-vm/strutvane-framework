/**
 * The SSRF-safe fetch (ported from spike 12). Every blocked case also proves that *no connection
 * was made*: a real local server counts its hits, and blocked requests leave the count at zero.
 * Names are resolved by an injected resolver, never real DNS.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BootError } from '../../src/foundation/boot-error.ts'
import {
  ALLOW_NOTHING,
  checkLiteralTarget,
  HttpClientError,
  parseAllowList,
  type Resolver,
  safeFetch,
} from '../../src/security/http-client.ts'
import {
  blockedReason,
  canonicalIp,
  embeddedIpv4,
  formatIp,
  inCidr,
  parseCidr,
  parseIp,
} from '../../src/security/ip.ts'

let server: Server
let port = 0
let hits = 0
const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    hits++
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      })
      if (request.url === '/hang') return
      if (request.url === '/slow-body') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.write('partial')
        return
      }
      if (request.url === '/big') {
        response.end('x'.repeat(64 * 1024))
        return
      }
      if (request.url === '/declared-big') {
        response.writeHead(200, { 'content-length': String(10 * 1024 * 1024) })
        response.write('x')
        return
      }
      if (request.url === '/json') {
        response.setHeader('content-type', 'application/json')
        response.setHeader('set-cookie', ['a=1', 'b=2'])
        response.end('{"ok":true}')
        return
      }
      if (request.url?.startsWith('/redirect')) {
        const status = Number(new URL(request.url, 'http://x').searchParams.get('status') ?? '302')
        const to = new URL(request.url, 'http://x').searchParams.get('to') ?? '/'
        response.writeHead(status, { location: to })
        response.end()
        return
      }
      response.setHeader('content-type', 'text/plain')
      response.end(`hello ${request.headers.host ?? ''}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Resolves every name with the given answers in turn (the last repeats); counts its calls. */
function resolverTo(...answers: (readonly string[])[]): Resolver & { calls: number } {
  const resolver = Object.assign(
    async (): Promise<readonly string[]> => {
      const answer = answers[Math.min(resolver.calls, answers.length - 1)] ?? []
      resolver.calls++
      return answer
    },
    { calls: 0 },
  )
  return resolver
}

async function refused(
  url: string,
  options: Parameters<typeof safeFetch>[1] = {},
): Promise<HttpClientError> {
  const before = hits
  const error = await safeFetch(url, { timeoutMs: 2000, ...options }).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(hits, `${url} must not connect`).toBe(before)
  if (error instanceof HttpClientError) return error
  throw new Error(`Expected ${url} to be refused, got ${String(error)}`)
}

async function failure(promise: Promise<unknown>): Promise<HttpClientError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (error instanceof HttpClientError) return error
  throw new Error(`Expected an HttpClientError, got ${String(error)}`)
}

const local = (): { resolver: Resolver; allow: readonly string[] } => ({
  resolver: resolverTo(['127.0.0.1']),
  allow: ['127.0.0.1/32'],
})

describe('the special-range table', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private (10/8)'],
    ['172.31.255.255', 'private (172.16/12)'],
    ['192.168.0.1', 'private (192.168/16)'],
    ['169.254.169.254', 'link-local (includes cloud metadata 169.254.169.254)'],
    ['100.100.100.200', 'carrier-grade NAT (includes cloud metadata 100.100.100.200)'],
    ['0.0.0.0', 'this network'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00:ec2::254', 'unique local (includes AWS metadata fd00:ec2::254)'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:0:7f00:1', 'loopback'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'link-local (includes cloud metadata 169.254.169.254)'],
    ['64:ff9b:1::1', 'NAT64 local-use'],
    ['2002:7f00:1::', 'loopback'],
    ['224.0.0.1', 'multicast'],
    ['[::1]', 'loopback'],
  ])('%s is blocked (%s)', (address, reason) => {
    const ip = parseIp(address)
    expect(ip).toBeDefined()
    if (ip !== undefined) expect(blockedReason(ip)).toBe(reason)
  })

  it('leaves public addresses alone', () => {
    for (const address of [
      '93.184.216.34',
      '8.8.8.8',
      '2606:4700:4700::1111',
      '172.32.0.1',
      '11.0.0.1',
      '2002:5db8:d822::',
    ]) {
      const ip = parseIp(address)
      expect(ip !== undefined && blockedReason(ip), address).toBeUndefined()
    }
  })

  it('parses strictly and formats canonically', () => {
    for (const bad of ['2130706433', '0x7f.0.0.1', '1.2.3.4:80', 'fe80::1%eth0', '', 'x'])
      expect(parseIp(bad), bad).toBeUndefined()
    for (const bad of [
      '10.0.0.0/33',
      '10.0.0.0/8/1',
      '::/129',
      '10.0.0.0/x',
      'x/8',
      '10.0.0.0/08x',
    ])
      expect(parseCidr(bad), bad).toBeUndefined()
    const range = parseCidr('10.0.0.0/8')
    const v6 = parseCidr('2001:db8::/32')
    const ip = parseIp('10.200.0.1')
    expect(range && ip && inCidr(ip, range)).toBe(true)
    expect(v6 && ip && inCidr(ip, v6)).toBe(false)
    expect(parseCidr('0.0.0.0/0')?.base).toBe(0n)
    expect(formatIp({ version: 4, value: 2130706433n })).toBe('127.0.0.1')
    expect(canonicalIp('::ffff:10.0.0.1')).toBe('10.0.0.1')
    expect(canonicalIp('2001:DB8::1')).toBe('2001:db8:0:0:0:0:0:1')
    expect(canonicalIp('nope')).toBeUndefined()
    const v4 = parseIp('1.2.3.4')
    expect(v4 && embeddedIpv4(v4)).toBeUndefined()
  })
})

describe('safeFetch refuses private, loopback, link-local and metadata targets', () => {
  it.each([
    'http://127.0.0.1:PORT/',
    'http://localhost:PORT/',
    'http://api.localhost:PORT/',
    'http://[::1]:PORT/',
    'http://[::ffff:127.0.0.1]:PORT/',
    'http://[::ffff:7f00:1]:PORT/',
    'http://2130706433:PORT/',
    'http://0x7f.0.0.1:PORT/',
    'http://0177.0.0.1:PORT/',
    'http://127.1:PORT/',
    'http://0:PORT/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://10.0.0.1/',
    'http://127.0.0.1\t:PORT/',
  ])('%s', async (template) => {
    const error = await refused(template.replace('PORT', String(port)))
    expect(error.code).toBe('ssrf_blocked')
  })

  it('refuses names that resolve to a blocked address, even when mixed with public ones', async () => {
    const url = `http://service.test:${port}/`
    expect((await refused(url, { resolver: resolverTo(['127.0.0.1']) })).code).toBe('ssrf_blocked')
    expect(
      (await refused(url, { resolver: resolverTo(['93.184.216.34', '169.254.169.254']) })).code,
    ).toBe('ssrf_blocked')
  })

  it('refuses failed, empty or junk DNS answers', async () => {
    const url = `http://service.test:${port}/`
    const broken: Resolver = async () => {
      throw new Error('ENOTFOUND')
    }
    expect((await refused(url, { resolver: broken })).code).toBe('dns_failed')
    expect((await refused(url, { resolver: resolverTo([]) })).code).toBe('dns_failed')
    expect((await refused(url, { resolver: resolverTo(['not-an-ip']) })).code).toBe('dns_failed')
  })

  it('refuses non-http schemes, URLs with credentials, and header injection', async () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://127.0.0.1/',
      'ftp://example.com/',
      `http://user:pass@service.test:${port}/`,
      'not a url',
    ]) {
      expect((await refused(url)).code, url).toBe('invalid_url')
    }
    const headers = { 'x-name': 'a\r\nx-evil: 1' }
    expect((await refused(`http://service.test:${port}/`, { ...local(), headers })).code).toBe(
      'invalid_header',
    )
    expect(
      (await refused(`http://service.test:${port}/`, { ...local(), headers: { 'bad name': 'x' } }))
        .code,
    ).toBe('invalid_header')
  })

  it('allow lists take ranges and host names, and refuse "*"', async () => {
    expect(() => parseAllowList(['*'])).toThrow(BootError)
    expect(() => parseAllowList(['10.0.0.0/33', 'ok.example'])).toThrow('"10.0.0.0/33" is not')
    const allow = parseAllowList(['*.internal', 'billing.example', '10.0.0.0/8'])
    expect(allow.hosts).toEqual(['*.internal', 'billing.example'])
    expect(() => checkLiteralTarget(new URL('http://10.1.1.1/'), allow)).not.toThrow()
    expect(() => checkLiteralTarget(new URL('http://10.1.1.1/'), ALLOW_NOTHING)).toThrow(
      HttpClientError,
    )
    expect(checkLiteralTarget(new URL('http://example.com/'), ALLOW_NOTHING)).toBeUndefined()
    // An allowed host name is reached even though it resolves to a private address.
    const viaName = await safeFetch(`http://svc.internal:${port}/hello`, {
      resolver: resolverTo(['127.0.0.1']),
      allow: ['*.internal'],
    })
    expect(viaName.text()).toBe(`hello svc.internal:${port}`)
    const viaLocalName = await safeFetch(`http://app.localhost:${port}/hello`, {
      resolver: resolverTo(['127.0.0.1']),
      allow: ['*.localhost'],
    })
    expect(viaLocalName.status).toBe(200)
  })
})

describe('safeFetch connects to the address it checked (DNS rebinding)', () => {
  it('resolves once and pins the socket to the checked address', async () => {
    // First answer: an address the app allows. Every later answer: cloud metadata.
    const resolver = resolverTo(['127.0.0.1'], ['169.254.169.254'])
    const response = await safeFetch(`http://service.test:${port}/hello`, {
      resolver,
      allow: ['127.0.0.1/32'],
    })
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.text()).toBe(`hello service.test:${port}`)
    expect(response.url).toBe(`http://service.test:${port}/hello`)
    expect(resolver.calls).toBe(1)
  })

  it('re-checks every redirect hop', async () => {
    const options = local()
    const before = hits
    const metadata = encodeURIComponent('http://169.254.169.254/latest/meta-data/')
    const error = await failure(
      safeFetch(`http://service.test:${port}/redirect?to=${metadata}`, options),
    )
    expect(error.code).toBe('ssrf_blocked')
    expect(hits - before).toBe(1)
    const followed = await safeFetch(
      `http://service.test:${port}/redirect?to=${encodeURIComponent('/hello')}`,
      options,
    )
    expect(followed.text()).toBe(`hello service.test:${port}`)
    const toFile = await failure(
      safeFetch(
        `http://service.test:${port}/redirect?to=${encodeURIComponent('file:///etc/passwd')}`,
        options,
      ),
    )
    expect(toFile.code).toBe('invalid_url')
  })

  it('drops credentials when a redirect leaves the origin, and the body after a 303', async () => {
    const options = { resolver: resolverTo(['127.0.0.1']), allow: ['127.0.0.1/32'] }
    seen.length = 0
    const away = encodeURIComponent(`http://other.test:${port}/hello`)
    await safeFetch(`http://service.test:${port}/redirect?to=${away}`, {
      ...options,
      method: 'POST',
      body: '{"a":1}',
      headers: {
        authorization: 'Bearer secret',
        cookie: 'a=1',
        'content-type': 'application/json',
        'x-keep': '1',
      },
    })
    const [first, second] = seen
    expect(first?.headers.authorization).toBe('Bearer secret')
    expect(first?.body).toBe('{"a":1}')
    expect(second?.headers.authorization).toBeUndefined()
    expect(second?.headers.cookie).toBeUndefined()
    expect(second?.headers['x-keep']).toBe('1')
    expect(second?.body).toBe('')
    seen.length = 0
    // Same-origin 307 keeps the method, the body and the credentials.
    const same = encodeURIComponent('/hello')
    await safeFetch(`http://service.test:${port}/redirect?status=307&to=${same}`, {
      ...options,
      method: 'PUT',
      body: 'x',
      headers: { authorization: 'Bearer secret' },
    })
    expect(seen[1]?.headers.authorization).toBe('Bearer secret')
    expect(seen[1]?.body).toBe('x')
  })

  it('enforces the timeout, the size cap and the redirect limit', async () => {
    const hang = await failure(
      safeFetch(`http://service.test:${port}/hang`, { ...local(), timeoutMs: 200 }),
    )
    expect(hang.code).toBe('timeout')
    const slowBody = await failure(
      safeFetch(`http://service.test:${port}/slow-body`, { ...local(), timeoutMs: 300 }),
    )
    expect(slowBody.code).toBe('timeout')
    const big = await failure(
      safeFetch(`http://service.test:${port}/big`, { ...local(), maxBytes: 1024 }),
    )
    expect(big.code).toBe('response_too_large')
    const declared = await failure(
      safeFetch(`http://service.test:${port}/declared-big`, { ...local(), maxBytes: 1024 }),
    )
    expect(declared.code).toBe('response_too_large')
    const loop = `http://service.test:${port}/redirect?to=${encodeURIComponent('/redirect?to=%2Fredirect%3Fto%3D%252Fhello')}`
    const tooMany = await failure(safeFetch(loop, { ...local(), maxRedirects: 1 }))
    expect(tooMany.code).toBe('too_many_redirects')
    const spent = await failure(
      safeFetch(`http://service.test:${port}/`, { ...local(), timeoutMs: -1 }),
    )
    expect(spent.code).toBe('timeout')
  })

  it('reports a refused connection as connection_failed', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const error = await failure(safeFetch(`http://service.test:${closedPort}/`, local()))
    expect(error.code).toBe('connection_failed')
  })

  it('reads headers (repeated ones too) and JSON through the pollution guard', async () => {
    const response = await safeFetch(`http://service.test:${port}/json`, local())
    expect(response.json()).toEqual({ ok: true })
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(response.body.length).toBe(11)
  })
})
