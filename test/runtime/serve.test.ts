/**
 * The Node adapter under hostile clients: disconnects, HEAD requests, slow readers, spoofed
 * forwarding headers and absolute-form request targets, over real sockets.
 */
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type RunningServer, type ServeBindings, serve } from '../../src/runtime/serve.ts'

let server: RunningServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

/** A response body that never ends on its own; records pulls and cancellation. */
function endless(chunk = new Uint8Array(64 * 1024)) {
  let pulls = 0
  let cancelled!: () => void
  const cancel = new Promise<void>((r) => {
    cancelled = r
  })
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++
        c.enqueue(chunk)
      },
      cancel() {
        cancelled()
      },
    },
    { highWaterMark: 0 },
  )
  return { body, cancel, pulls: () => pulls }
}

const within = <T>(p: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])

/** Send raw bytes and collect the reply until the server closes or `ms` pass. */
function raw(port: number, text: string, ms = 1000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text))
    let out = ''
    socket.on('data', (d) => {
      out += d.toString('latin1')
    })
    const done = () => resolve(out)
    socket.on('close', done)
    setTimeout(() => {
      socket.destroy()
      done()
    }, ms)
  })
}

describe('serve', () => {
  it('a client disconnect aborts the request signal and cancels the response stream', async () => {
    const stream = endless()
    let signal: AbortSignal | undefined
    server = await serve(
      (request) => {
        signal = request.signal
        return new Response(stream.body)
      },
      { port: 0 },
    )
    const controller = new AbortController()
    const res = await fetch(server.url, { signal: controller.signal })
    const reader = res.body?.getReader()
    await reader?.read()
    controller.abort()
    await within(stream.cancel)
    expect(signal?.aborted).toBe(true)
  })

  it('HEAD never streams (and never holds) the response body', async () => {
    const stream = endless()
    server = await serve(() => new Response(stream.body, { headers: { 'x-a': '1' } }), { port: 0 })
    const res = await fetch(server.url, { method: 'HEAD' })
    expect(res.headers.get('x-a')).toBe('1')
    await within(stream.cancel)
    expect(stream.pulls()).toBe(0)
  })

  it('a slow reader cannot make the server buffer the whole body (backpressure)', async () => {
    const stream = endless()
    server = await serve(() => new Response(stream.body), { port: 0 })
    const port = server.port
    // Connect, send a request, and then never read.
    const socket = connect(port, '127.0.0.1')
    socket.pause()
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
    await new Promise((r) => setTimeout(r, 400))
    // 64 KiB per pull: without backpressure this would be thousands (hundreds of MB).
    expect(stream.pulls()).toBeLessThan(400)
    socket.destroy()
    await within(stream.cancel)
  })

  it('forwarding headers are ignored unless trustProxy is set; publicUrl fixes the origin', async () => {
    const seen: { url: string; bindings: ServeBindings }[] = []
    const handler = (request: Request, bindings: ServeBindings) => {
      seen.push({ url: request.url, bindings })
      return new Response('ok')
    }
    const headers = { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' }
    server = await serve(handler, { port: 0 })
    await fetch(`${server.url}/a`, { headers })
    await server.close()
    server = await serve(handler, { port: 0, trustProxy: 1 })
    await fetch(`${server.url}/b`, { headers })
    await server.close()
    server = await serve(handler, { port: 0, publicUrl: 'https://app.example.test/' })
    await fetch(`${server.url}/c?x=1`, { headers })
    expect(seen[0]?.bindings.clientAddress).toBe('127.0.0.1')
    expect(seen[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a$/)
    expect(seen[0]?.bindings.incoming.socket.remoteAddress).toContain('127.0.0.1')
    expect(seen[1]?.bindings.clientAddress).toBe('6.6.6.6')
    expect(seen[1]?.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/b$/)
    expect(seen[2]?.url).toBe('https://app.example.test/c?x=1')
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
  })

  it('an absolute-form request target cannot change the request origin', async () => {
    const urls: string[] = []
    server = await serve(
      (request) => {
        urls.push(request.url)
        return new Response('ok')
      },
      { port: 0 },
    )
    const reply = await raw(
      server.port,
      'GET http://evil.test/steal HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n',
    )
    expect(reply).toContain('200 OK')
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })
})
