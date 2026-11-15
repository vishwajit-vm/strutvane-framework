/**
 * Per-route body limits and timeouts are matched on the path the router serves. Hono routes on
 * the percent-decoded path, so a limit matched on the raw path could be dodged with an encoded
 * letter: `/api/v1/sm%61ll` reaches the `/small` route but got the app-wide limit instead of the
 * route's own (smaller) one, and an encoded upload path lost its raised limit and timeout.
 *
 * The class covered: every path-keyed decision outside the router (body limit, timeout) uses
 * `routerPath()`, the router's own decoding.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { route } from '../../src/http/route.ts'
import { routerPath } from '../../src/http/router-path.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { Customer, Invoice } from '../helpers/models.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

async function boot(): Promise<TestApp> {
  t = await createTestApp({
    resources: [Customer, Invoice],
    http: {
      requestTimeoutMs: 60_000,
      routes: [
        route.post('/small', { public: true, bodyLimit: 16, handler: async (c) => c.json() }),
        route.post('/big', {
          public: true,
          bodyLimit: 3 * 1024 * 1024,
          handler: async (c) => ({ size: JSON.stringify(await c.json()).length }),
        }),
        route.get('/slow', {
          public: true,
          timeoutMs: 50,
          handler: () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 500)),
        }),
      ],
    },
  })
  return t
}

const post = (app: TestApp, path: string, body: string) =>
  app.http.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

describe('route limits follow the router’s decoded path', () => {
  it('a lowered body limit cannot be dodged by percent-encoding the path', async () => {
    const app = await boot()
    const body = JSON.stringify({ padding: 'x'.repeat(100) })
    for (const path of ['/api/v1/small', '/api/v1/sm%61ll', '/api/v1/%73mall', '/api/%761/small']) {
      const res = await post(app, path, body)
      expect(res.status, path).toBe(413)
    }
  })

  it('a raised body limit applies to the encoded spelling too', async () => {
    const app = await boot()
    const body = JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) })
    expect((await post(app, '/api/v1/b%69g', body)).status).toBe(200)
  })

  it('a route timeout applies to the encoded spelling too', async () => {
    const app = await boot()
    const res = await app.http.request('/api/v1/sl%6Fw')
    expect(res.status).toBe(503)
  })

  it('routerPath decodes like the router: letters yes, an encoded slash no', () => {
    expect(routerPath(new Request('http://x/api/v1/sm%61ll?q=%61'))).toBe('/api/v1/small')
    expect(routerPath(new Request('http://x/a%2Fb'))).toBe('/a%2Fb')
  })
})
