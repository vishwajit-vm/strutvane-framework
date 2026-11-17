/**
 * The Node adapter with an application (`bootstrap/app.ts`): the socket peer and `waitUntil` reach
 * `app.handle`, deferred work runs after the response and `close()` waits for it, every form of
 * `trustProxy` is accepted (a list of proxies no longer throws), and `startApplication` boots the
 * app before the port opens. Real sockets, real servers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Application } from '../../src/foundation/application.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { defer } from '../../src/http/app/context.ts'
import { defineRoutes, Route, type RouteEntry } from '../../src/routing/route.ts'
import { type RunningServer, type ServeBindings, serve } from '../../src/runtime/serve.ts'
import {
  type ShutdownSource,
  type StartedApplication,
  startApplication,
  startedEnv,
  stopOnSignals,
} from '../../src/runtime/server.ts'
import { APP_KEY, appFolder, cleanupFolders } from '../commands/helpers.ts'

let server: RunningServer | undefined
let started: StartedApplication | undefined
afterEach(async () => {
  await server?.close()
  await started?.stop()
  server = undefined
  started = undefined
  cleanupFolders()
})

const config = {
  app: defineConfig((env) => ({
    name: 'Serve Test',
    env: env.string('APP_ENV', 'production'),
    debug: false,
    url: env.string('APP_URL', 'http://localhost'),
    key: env.string('APP_KEY'),
    port: 0,
  })),
}

function buildApp(
  base: string,
  routes: readonly RouteEntry[],
  env: Record<string, string> = {},
): Application {
  return Application.configure({
    basePath: base,
    env: { APP_ENV: 'testing', APP_KEY, APP_URL: 'http://127.0.0.1', ...env },
  })
    .withConfig(config)
    .withRouting({ web: defineRoutes(routes) })
    .create()
}

describe('serve: bindings', () => {
  it('passes the socket peer as ip and a waitUntil that close() waits for', async () => {
    const seen: ServeBindings[] = []
    let finish!: () => void
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    let workDone = false
    server = await serve(
      (_request, bindings) => {
        seen.push(bindings)
        bindings.waitUntil(
          work.then(() => {
            workDone = true
          }),
        )
        return new Response('ok')
      },
      { port: 0, trustProxy: 1 },
    )
    const response = await fetch(server.url, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect(await response.text()).toBe('ok')
    // The peer is the socket, never a header; the client address follows the trusted hop.
    expect(seen[0]?.ip).toMatch(/127\.0\.0\.1$/)
    expect(seen[0]?.clientAddress).toBe('203.0.113.9')
    // close() waits for the deferred work (within the grace period).
    let closed = false
    const closing = server.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    finish()
    await closing
    expect(workDone).toBe(true)
    server = undefined
  })

  it('a failing waitUntil job goes to onError, never an unhandled rejection', async () => {
    const reported: unknown[] = []
    server = await serve(
      (_request, bindings) => {
        bindings.waitUntil(Promise.reject(new Error('after-response job failed')))
        return new Response('ok')
      },
      { port: 0, onError: (error) => reported.push(error) },
    )
    expect((await fetch(server.url)).status).toBe(200)
    await server.close()
    server = undefined
    expect(reported).toEqual([new Error('after-response job failed')])
  })

  it('accepts trustProxy as a list of proxies: only those peers may forward', async () => {
    const seen: { url: string; bindings: ServeBindings }[] = []
    const handler = (request: Request, bindings: ServeBindings) => {
      seen.push({ url: request.url, bindings })
      return new Response('ok')
    }
    const headers = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }
    server = await serve(handler, { port: 0, trustProxy: ['127.0.0.0/8', '::1'] })
    await fetch(server.url, { headers })
    await server.close()
    server = await serve(handler, { port: 0, trustProxy: ['10.0.0.0/8'] })
    await fetch(server.url, { headers })
    expect(seen[0]?.bindings.clientAddress).toBe('203.0.113.9')
    expect(seen[0]?.url).toMatch(/^https:/)
    // A peer outside the list: the headers are ignored.
    expect(seen[1]?.bindings.clientAddress).toBe('127.0.0.1')
    expect(seen[1]?.url).toMatch(/^http:/)
  })

  it('refuses a trustProxy list that trusts everyone, before listening', async () => {
    expect(() => serve(() => new Response('ok'), { port: 0, trustProxy: ['*'] })).toThrow(
      /never "\*"/,
    )
  })
})

describe('startApplication', () => {
  it('boots bootstrap/app.ts, serves it with the peer and waitUntil, and shuts it down', async () => {
    const base = appFolder()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = buildApp(base, [
      Route.get('/hello', (ctx) => {
        defer(async () => {
          await gate
          order.push('deferred')
        })
        return ctx.json({ hello: true })
      }).name('hello'),
    ])
    started = await startApplication({ root: base, port: 0, load: async () => app })
    expect(app.state).toBe('booted')
    expect(startedEnv(started)).toBe('testing')
    const response = await fetch(`${started.server.url}/hello`)
    expect(await response.json()).toEqual({ hello: true })
    // The response did not wait for the deferred work; stop() does.
    order.push('responded')
    const stopping = started.stop()
    release()
    await stopping
    expect(order).toEqual(['responded', 'deferred'])
    expect(app.state).not.toBe('booted')
    started = undefined
  })

  it('never opens the port for an app that refuses to boot', async () => {
    const base = appFolder()
    const app = buildApp(base, [], { APP_KEY: 'too-short' })
    await expect(startApplication({ root: base, port: 0, load: async () => app })).rejects.toThrow(
      /APP_KEY/,
    )
  })

  it('stops on a signal and logs nothing when the stop succeeds', async () => {
    const base = appFolder()
    started = await startApplication({
      root: base,
      port: 0,
      load: async () => buildApp(base, []),
    })
    const listeners = new Map<string, () => void>()
    const source: ShutdownSource = {
      on: (event: string, listener: (message?: unknown) => void) =>
        listeners.set(event, () => listener()),
      off: (event: string) => listeners.delete(event),
    }
    const stopping = stopOnSignals(started, { source })
    listeners.get('SIGTERM')?.()
    expect(await stopping).toBe('SIGTERM')
    started = undefined
  })
})
