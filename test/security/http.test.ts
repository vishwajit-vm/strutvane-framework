/**
 * The `HttpClient` (Laravel's `Http`): the fluent builder, body encoding, fakes and assertions,
 * stray-request prevention, and the SSRF guard staying on under fakes and real requests.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BootError } from '../../src/foundation/boot-error.ts'
import {
  HttpClient,
  HttpClientError,
  HttpClientToken,
  type RecordedRequest,
} from '../../src/security/http.ts'

let server: Server
let port = 0
const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      })
      if (request.url === '/big') return void response.end('x'.repeat(4096))
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/hello' })
        return void response.end()
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ method: request.method, url: request.url }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const localClient = (): HttpClient =>
  new HttpClient({ resolver: async () => ['127.0.0.1'], allow: ['127.0.0.1/32'] })

async function failure(promise: Promise<unknown>): Promise<HttpClientError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (error instanceof HttpClientError) return error
  throw new Error(`Expected an HttpClientError, got ${String(error)}`)
}

describe('real requests', () => {
  it('sends JSON, forms, text and bytes with the right content types', async () => {
    const http = localClient()
    const base = `http://api.test:${port}`
    seen.length = 0
    const json = await http.withToken('t0k3n').acceptJson().post(`${base}/items`, { name: 'x' })
    expect(json.status).toBe(200)
    expect(json.json()).toEqual({ method: 'POST', url: '/items' })
    await http.asForm().put(`${base}/form`, { a: 1, b: 'two words' })
    await http.patch(`${base}/text`, 'plain')
    await http
      .withHeaders({ 'Content-Type': 'application/x-custom' })
      .delete(`${base}/bytes`, new Uint8Array([1, 2]))
    await http.get(`${base}/search`, { q: 'strut vane', page: 2, exact: true })
    await http.head(`${base}/head`, { a: 1 })
    await http.head(`${base}/plain-head`)
    const [post, form, text, bytes, search, head] = seen
    expect(post?.headers.authorization).toBe('Bearer t0k3n')
    expect(post?.headers.accept).toBe('application/json')
    expect(post?.headers['content-type']).toBe('application/json')
    expect(post?.body).toBe('{"name":"x"}')
    expect(form?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(form?.body).toBe('a=1&b=two+words')
    expect(text?.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(bytes?.headers['content-type']).toBe('application/x-custom')
    expect(bytes?.method).toBe('DELETE')
    expect(search?.url).toBe('/search?q=strut+vane&page=2&exact=true')
    expect(head?.method).toBe('HEAD')
  })

  it('applies per-request limits and keeps the SSRF guard on', async () => {
    const http = localClient()
    const big = await failure(http.maxBytes(100).get(`http://api.test:${port}/big`))
    expect(big.code).toBe('response_too_large')
    const redirect = await failure(http.maxRedirects(0).get(`http://api.test:${port}/redirect`))
    expect(redirect.code).toBe('too_many_redirects')
    expect((await http.timeout(5_000).get(`http://api.test:${port}/redirect`)).status).toBe(200)
    const guarded = new HttpClient({ resolver: async () => ['127.0.0.1'] })
    expect((await failure(guarded.get(`http://api.test:${port}/`))).code).toBe('ssrf_blocked')
    const allowed = await guarded.allow(['api.test']).get(`http://api.test:${port}/ok`)
    expect(allowed.status).toBe(200)
    expect((await failure(guarded.get('http://169.254.169.254/'))).code).toBe('ssrf_blocked')
  })

  it('refuses nonsense options at configuration time', () => {
    const http = new HttpClient()
    expect(() => http.timeout(0)).toThrow(BootError)
    expect(() => http.timeout(1.5)).toThrow(BootError)
    expect(() => http.maxBytes(-1)).toThrow(BootError)
    expect(() => http.maxRedirects(21)).toThrow(BootError)
    expect(() => http.allow(['*'])).toThrow(BootError)
    expect(() => new HttpClient({ timeoutMs: 0 })).toThrow(BootError)
    expect(() => new HttpClient({ allow: ['not a host'] })).toThrow(BootError)
    expect(HttpClientToken.name).toBe('strutvane.http-client')
  })
})

describe('fakes', () => {
  it('fake() with no argument answers every request with an empty 200 and records it', async () => {
    const http = new HttpClient().fake()
    const response = await http.post('https://api.example.com/hooks', { event: 'paid' })
    expect(response.status).toBe(200)
    expect(response.text()).toBe('')
    http.assertSent(
      (request) =>
        request.method === 'POST' &&
        request.url === 'https://api.example.com/hooks' &&
        (request.json() as { event: string }).event === 'paid' &&
        request.headers.get('content-type') === 'application/json',
    )
    http.assertSentCount(1)
    http.assertNotSent((request) => request.method === 'GET')
    expect(http.recorded()).toHaveLength(1)
  })

  it('matches URL patterns in order, with or without a scheme, stubs or handlers', async () => {
    const http = new HttpClient().fake({
      'api.github.com/users/*': HttpClient.response({ login: 'octocat' }, 200, { 'x-rate': '59' }),
      'https://example.com/text': { body: 'hello', headers: { 'content-type': 'text/plain' } },
      'example.com/bytes': { body: new Uint8Array([104, 105]) },
      'example.com/null': { body: null, status: 204 },
      'example.com/echo': (request: RecordedRequest) => ({
        status: 201,
        body: { got: request.body },
      }),
      '*': { status: 404 },
    })
    const user = await http.get('https://api.github.com/users/octocat')
    expect(user.json()).toEqual({ login: 'octocat' })
    expect(user.headers.get('content-type')).toBe('application/json')
    expect(user.headers.get('x-rate')).toBe('59')
    expect((await http.get('https://example.com/text')).text()).toBe('hello')
    expect((await http.get('http://example.com/text')).status).toBe(404)
    expect((await http.get('http://example.com/bytes')).text()).toBe('hi')
    expect((await http.get('http://example.com/null')).status).toBe(204)
    const echo = await http.post('http://example.com/echo', 'raw')
    expect(echo.status).toBe(201)
    expect(echo.json()).toEqual({ got: 'raw' })
    expect((await http.get('https://other.example/anything')).status).toBe(404)
    http.assertSentCount(7)
  })

  it('preventStrayRequests() throws for anything without a fake; nothing reaches the network', async () => {
    const http = new HttpClient().fake({ 'api.example.com/*': { body: {} } }).preventStrayRequests()
    expect((await http.get('https://api.example.com/a')).status).toBe(200)
    const stray = await failure(http.get('https://other.example.com/'))
    expect(stray.code).toBe('stray_request')
    expect(stray.message).toContain('GET https://other.example.com/')
    const strict = new HttpClient().preventStrayRequests()
    expect((await failure(strict.get('https://example.com/'))).code).toBe('stray_request')
    strict.assertNothingSent()
    strict.preventStrayRequests(false)
  })

  it('fakes still refuse bad URLs, literal private addresses and loopback names', async () => {
    const http = new HttpClient().fake()
    expect((await failure(http.get('http://169.254.169.254/latest/meta-data/'))).code).toBe(
      'ssrf_blocked',
    )
    expect((await failure(http.get('http://localhost:3000/'))).code).toBe('ssrf_blocked')
    expect((await failure(http.get('file:///etc/passwd'))).code).toBe('invalid_url')
    expect((await http.allow(['10.0.0.0/8']).get('http://10.0.0.5/')).status).toBe(200)
    http.assertSentCount(1)
  })

  it('assertions explain what was sent when they fail', async () => {
    const http = new HttpClient().fake()
    expect(() => http.assertSent(() => true)).toThrow('Sent: nothing')
    http.assertNothingSent()
    await http.get('https://example.com/a')
    expect(() => http.assertSent((request) => request.url.endsWith('/b'))).toThrow(
      'GET https://example.com/a',
    )
    expect(() => http.assertNotSent(() => true)).toThrow('one was sent')
    expect(() => http.assertNothingSent()).toThrow('were sent')
    expect(() => http.assertSentCount(2)).toThrow('Expected 2 requests, but 1')
  })

  it('every builder method is available from the client and returns a new request', async () => {
    const http = new HttpClient().fake()
    const base = http.withHeaders({ 'x-a': '1' })
    const derived = base.withHeaders({ 'X-B': '2' })
    await base.get('https://example.com/base')
    await derived
      .acceptJson()
      .asForm()
      .timeout(1000)
      .maxBytes(10)
      .maxRedirects(1)
      .allow(['10.0.0.0/8'])
      .withToken('x', 'Token')
      .post('https://example.com/derived', { a: 1 })
    await http.timeout(1000).put('https://example.com/p', { a: 1 })
    await http.maxBytes(10).patch('https://example.com/p', { a: 1 })
    await http.maxRedirects(1).delete('https://example.com/p')
    await http.asForm().post('https://example.com/f', ['x'])
    await http.withToken('y').send('OPTIONS', 'https://example.com/o')
    await http.head('https://example.com/h')
    const [first, second, , , , form, options] = http.recorded()
    expect(first?.headers.get('x-b')).toBeNull()
    expect(second?.headers.get('x-a')).toBe('1')
    expect(second?.headers.get('x-b')).toBe('2')
    expect(second?.headers.get('authorization')).toBe('Token x')
    expect(second?.body).toBe('a=1')
    expect(form?.body).toBe('0=x')
    expect(options?.method).toBe('OPTIONS')
    expect(first?.json).toBeTypeOf('function')
    expect(() => first?.json()).toThrow()
  })
})
