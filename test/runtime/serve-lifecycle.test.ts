/**
 * The Node adapter's lifecycle under failure: errors the listening server emits after startup
 * (accept failures when the process runs out of file descriptors), and closing with requests
 * still in flight. Real sockets, real servers.
 */
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { type GraceTimer, type RunningServer, serve } from '../../src/runtime/serve.ts'

let server: RunningServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('serve: errors after listening', () => {
  it('accept errors (EMFILE) are reported to onError and never crash the process, however many', async () => {
    let node: Server | undefined
    const reported: unknown[] = []
    server = await serve(() => new Response('ok'), {
      port: 0,
      prepare: (s) => {
        node = s
      },
      onError: (e) => reported.push(e),
    })
    const accept = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE', syscall: 'accept' })
    // Without a listener, `emit('error')` throws: that is the uncaught exception in production.
    for (let i = 0; i < 3; i++) expect(() => node?.emit('error', accept)).not.toThrow()
    expect(reported).toHaveLength(3)
    // And the server still serves.
    expect((await fetch(server.url)).status).toBe(200)
  })

  it('without onError, or with an onError that throws, the error is still contained', async () => {
    for (const onError of [undefined, () => void JSON.parse('{')]) {
      let node: Server | undefined
      server = await serve(() => new Response('ok'), {
        port: 0,
        prepare: (s) => {
          node = s
        },
        ...(onError ? { onError } : {}),
      })
      expect(() => node?.emit('error', new Error('accept EMFILE'))).not.toThrow()
      expect(() => node?.emit('error', new Error('accept EMFILE'))).not.toThrow()
      await server.close()
      server = undefined
    }
  })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A request whose outcome is recorded instead of thrown. */
const attempt = (url: string): Promise<string> =>
  fetch(url).then(
    async (r) => `${r.status} ${await r.text()}`,
    (e: unknown) => `failed ${String((e as { cause?: { code?: string } }).cause?.code ?? e)}`,
  )

/**
 * A handler that takes `ms` to answer, and a promise that resolves once a request reached it.
 * Tests wait for that instead of sleeping: under load a fixed sleep can end before the request
 * has even arrived, and a connection with no request yet is idle, so close() rightly drops it.
 */
function slowHandler(ms: number) {
  let arrived!: () => void
  const started = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const handler = async () => {
    arrived()
    await sleep(ms)
    return new Response('done')
  }
  return { handler, started }
}

describe('serve: close() drains in-flight requests', () => {
  it('a request in flight when close() is called still gets its full response', async () => {
    const slow = slowHandler(300)
    server = await serve(slow.handler, { port: 0 })
    const inFlight = attempt(`${server.url}/slow`)
    await slow.started
    const closing = server.close()
    expect(await inFlight).toBe('200 done')
    await closing
    server = undefined
  })

  it('no new connections are accepted while draining', async () => {
    const slow = slowHandler(300)
    server = await serve(slow.handler, { port: 0 })
    const url = server.url
    const inFlight = attempt(`${url}/slow`)
    await slow.started
    const closing = server.close()
    expect(await attempt(`${url}/late`)).toMatch(/^failed/)
    expect(await inFlight).toBe('200 done')
    await closing
    server = undefined
  })

  it('a request that outlives the grace period is cut off, so close() always finishes', async () => {
    // A manual grace timer: the deadline passes exactly when the test fires it, so the outcome never
    // depends on how busy the machine is (this test was flaky under load with a real 200 ms timer).
    let expire: (() => void) | undefined
    let graceMs: number | undefined
    const timer: GraceTimer = (callback, ms) => {
      expire = callback
      graceMs = ms
      return () => {
        expire = undefined
      }
    }
    let arrived!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>((resolve) => {
      arrived = resolve
    })
    server = await serve(
      (request) => {
        arrived(request.signal)
        return new Promise<Response>(() => undefined) // never answers
      },
      { port: 0, timer },
    )
    const stuck = attempt(`${server.url}/stuck`)
    const signal = await started
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    let closed = false
    const closing = server.close({ graceMs: 200 }).then(() => {
      closed = true
    })
    server = undefined
    // Within the grace period the request is still alive and close() still waiting.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    expect(graceMs).toBe(200)
    expect(closed).toBe(false)
    expect(signal.aborted).toBe(false)
    // The deadline passes: the connection is cut, close() finishes, the handler learns it.
    expire?.()
    await closing
    expect(await stuck).toMatch(/^failed/)
    await aborted
    expect(signal.aborted).toBe(true)
  })

  it('close() is idempotent: concurrent and repeated calls share one shutdown', async () => {
    server = await serve(() => new Response('ok'), { port: 0 })
    const a = server.close()
    const b = server.close()
    await Promise.all([a, b])
    await server.close()
    server = undefined
  })
})
