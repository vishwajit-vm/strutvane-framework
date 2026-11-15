/**
 * The Node adapter's lifecycle under failure: errors the listening server emits after startup
 * (accept failures when the process runs out of file descriptors), and closing with requests
 * still in flight. Real sockets, real servers.
 */
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { type RunningServer, serve } from '../../src/runtime/serve.ts'

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

describe('serve: close() drains in-flight requests', () => {
  it('a request in flight when close() is called still gets its full response', async () => {
    server = await serve(
      async () => {
        await sleep(300)
        return new Response('done')
      },
      { port: 0 },
    )
    const inFlight = attempt(`${server.url}/slow`)
    await sleep(50)
    const closing = server.close()
    expect(await inFlight).toBe('200 done')
    await closing
    server = undefined
  })

  it('no new connections are accepted while draining', async () => {
    server = await serve(
      async () => {
        await sleep(300)
        return new Response('done')
      },
      { port: 0 },
    )
    const url = server.url
    const inFlight = attempt(`${url}/slow`)
    await sleep(50)
    const closing = server.close()
    expect(await attempt(`${url}/late`)).toMatch(/^failed/)
    expect(await inFlight).toBe('200 done')
    await closing
    server = undefined
  })

  it('a request that outlives the grace period is cut off, so close() always finishes', async () => {
    let signal: AbortSignal | undefined
    server = await serve(
      (request) => {
        signal = request.signal
        return new Promise<Response>(() => undefined) // never answers
      },
      { port: 0 },
    )
    const stuck = attempt(`${server.url}/stuck`)
    await sleep(50)
    const started = Date.now()
    await server.close({ graceMs: 200 })
    server = undefined
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await stuck).toMatch(/^failed/)
    // The handler learns the client is gone, so it can stop its work.
    for (let i = 0; i < 50 && !signal?.aborted; i++) await sleep(20)
    expect(signal?.aborted).toBe(true)
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
