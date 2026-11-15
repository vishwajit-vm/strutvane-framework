/**
 * A request that never finishes (a handler, a hook or a middleware that never resolves, a
 * dependency that stopped answering) must not hold the client and its socket forever: after the
 * request timeout the client gets a 503 problem+json, and a failure arriving after that answer is
 * contained (never an unhandled rejection).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { HTTP_HOOKS } from '../../src/contracts/index.ts'
import { HooksToken } from '../../src/core/index.ts'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
} from '../../src/http/request-timeout.ts'
import { route } from '../../src/http/route.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'

const Note = defineModel('Note', { title: field.string(50) })

let app: TestApp | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

const never = (): Promise<never> => new Promise<never>(() => undefined)

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await work
  return { value, ms: Date.now() - started }
}

describe('request timeout', () => {
  it('a handler that never resolves gets a 503 problem after the timeout', async () => {
    app = await createTestApp({
      resources: [Note],
      http: {
        requestTimeoutMs: 200,
        routes: [route.get('/stuck', { public: true, handler: never })],
      },
    })
    const { value: res, ms } = await timed(app.request('GET', '/api/v1/stuck'))
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/)
    expect((res.body as { code: string }).code).toBe('SERVICE_UNAVAILABLE')
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(ms).toBeLessThan(5_000)
  })

  it('a request hook that never resolves is bounded too', async () => {
    app = await createTestApp({ resources: [Note], http: { requestTimeoutMs: 200 } })
    app.app.make(HooksToken).on(HTTP_HOOKS.request, never, { name: 'test.stuck' })
    const res = await app.request('GET', '/health')
    expect(res.status).toBe(503)
  })

  it('a handler that fails after the timeout answered: contained, no unhandled rejection', async () => {
    app = await createTestApp({
      resources: [Note],
      http: {
        requestTimeoutMs: 100,
        routes: [
          route.get('/late', {
            public: true,
            handler: async () => {
              await new Promise((r) => setTimeout(r, 300))
              throw new Error('late failure')
            },
          }),
        ],
      },
    })
    const res = await app.request('GET', '/api/v1/late')
    expect(res.status).toBe(503)
    await new Promise((r) => setTimeout(r, 400)) // let the late failure happen inside the test
  })

  it('fast requests are untouched; 0 disables the limit; the default is generous', async () => {
    app = await createTestApp({ resources: [Note], http: { requestTimeoutMs: 0 } })
    expect((await app.request('GET', '/health')).status).toBe(200)
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    await expect(
      createTestApp({ resources: [Note], http: { requestTimeoutMs: -5 } }),
    ).rejects.toThrow(RangeError)
  })

  it('a route may set its own limit; an upload route (raised bodyLimit) is not cut at the app limit', async () => {
    const slow = (ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true }
    }
    app = await createTestApp({
      resources: [Note],
      http: {
        requestTimeoutMs: 100,
        routes: [
          route.get('/report', { public: true, timeoutMs: 1_000, handler: slow(300) }),
          route.post('/upload', { public: true, bodyLimit: 10 * 1024 * 1024, handler: slow(300) }),
          route.get('/strict', { public: true, timeoutMs: 50, handler: slow(300) }),
        ],
      },
    })
    expect((await app.request('GET', '/api/v1/report')).status).toBe(200)
    expect((await app.request('POST', '/api/v1/upload', { body: {} })).status).toBe(200)
    expect((await app.request('GET', '/api/v1/strict')).status).toBe(503)
    expect(UPLOAD_REQUEST_TIMEOUT_MS).toBeGreaterThan(120_000) // the multipart total deadline
  })
})
