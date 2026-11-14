/**
 * A minimal Node HTTP adapter for Web `fetch` handlers (no extra dependency).
 *
 * - **Streaming both ways.** Request bodies are streamed, never buffered here (the app's body limit
 *   applies). Response bodies are written with backpressure: when the socket buffer is full the
 *   adapter waits for `drain` instead of queueing the whole body in memory.
 * - **Disconnects are signalled.** Each `Request` carries an `AbortSignal` that fires when the
 *   client goes away, and the response body is cancelled, so long-lived streams (a log tail,
 *   server-sent events) release their resources instead of leaking until the process exits.
 * - **`HEAD` never streams.** The body of a `HEAD` response is cancelled unread.
 * - **Safe by default.** The adapter listens on 127.0.0.1; binding other interfaces is an explicit
 *   choice. The request URL is built from the bind address (never from the `Host` header), or
 *   from `publicUrl` when configured; forwarded headers count only with `trustProxy`.
 *
 * - **A dev UI on the same port.** `prepare(server)` runs before listening (Vite attaches its HMR
 *   websocket to the server there), and `fallback` gets the Node request and response for
 *   requests the app marked as unanswered UI requests (`sv dev` passes Vite's middleware).
 *
 * The handler receives a second argument, {@link ServeBindings}, with the Node request and the
 * resolved client address; Hono exposes it as `c.env` (compatible with `@hono/node-server`).
 *
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  clientAddressOf,
  forwardedProtocol,
  parsePublicUrl,
  type TrustProxy,
  trustedHops,
} from '../http/proxy.ts'
import { UI_FALLTHROUGH_HEADER } from '../http/ui-paths.ts'

/** What the adapter passes to the handler next to the request (Hono's `c.env`). */
export interface ServeBindings {
  /** The Node request (same shape `@hono/node-server` provides). */
  readonly incoming: IncomingMessage
  /**
   * The client address: the TCP peer, or the trusted `X-Forwarded-For` hop when `trustProxy` is
   * set. `undefined` when it cannot be determined safely; consumers must then fail closed.
   */
  readonly clientAddress: string | undefined
}

/** A Web request handler. */
export type FetchHandler = (
  request: Request,
  bindings: ServeBindings,
) => Response | Promise<Response>

/** A running server. */
export interface RunningServer {
  readonly port: number
  /** Where the server listens (`http://<bind address>:<port>`), not the public URL. */
  readonly url: string
  close(): Promise<void>
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** Port (0 = any free port). */
  readonly port: number
  /** Interface to bind. Default `127.0.0.1`. */
  readonly hostname?: string
  /** Receives handler failures (the client gets a bare 500). */
  readonly onError?: (error: unknown) => void
  /**
   * The URL users reach the app at, e.g. `https://app.example.com`. Request URLs use its origin,
   * so the app knows it is served over HTTPS (HSTS, `Secure` cookies) even when TLS ends at a
   * proxy. Without it, URLs use the bind address and the socket's protocol (plain HTTP).
   */
  readonly publicUrl?: string
  /**
   * Proxy hops in front of the app whose `X-Forwarded-For` / `X-Forwarded-Proto` may be believed.
   * Default `false`: those headers are ignored, because any client can send them. Set it only
   * when a proxy you control always overwrites them.
   */
  readonly trustProxy?: TrustProxy
  /**
   * Runs once the Node server exists and before it listens: the place to attach things that need
   * the server itself, such as Vite's HMR websocket (`hmr: { server }`), which listens for
   * `upgrade` events on the same port.
   */
  readonly prepare?: (server: Server) => void | Promise<void>
  /**
   * A Connect-style Node handler for requests the app marked as UI requests it did not answer
   * (`createHttpApp({ uiFallthrough: true })`; `sv dev` passes Vite's middleware). It owns the
   * response, or calls `next()` and the app's own 404 problem is sent. `next(error)` is reported
   * to `onError` and answered with a bare 500.
   */
  readonly fallback?: NodeFallback
}

/** A Connect-style Node request handler (`vite.middlewares`). */
export type NodeFallback = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void

/** Most bytes read and discarded after the app stopped reading a body, before the socket closes. */
export const MAX_DISCARD_BYTES: number = 1024 * 1024

/**
 * The request body as a web stream, with backpressure, that survives the app abandoning it.
 *
 * `Readable.toWeb(req)` throws an uncaught "Controller is already closed" when the consumer
 * cancels the stream (a body limit, an aborted multipart upload) while the socket still delivers
 * data: one oversized upload could crash the whole server. Here, once the stream is cancelled the
 * rest of the body is read and discarded (so the client still receives the 413/422 the app chose)
 * up to {@link MAX_DISCARD_BYTES}; beyond that the request is destroyed.
 */
export function requestBody(req: IncomingMessage): {
  readonly stream: ReadableStream<Uint8Array>
  /** Stop delivering data and discard the rest of the body (bounded). Idempotent. */
  abandon(): void
} {
  let done = false
  let discarded = 0
  const abandon = (): void => {
    done = true
    if (!req.complete) req.resume()
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        req.on('data', (chunk: Buffer) => {
          if (done) {
            discarded += chunk.byteLength
            if (discarded > MAX_DISCARD_BYTES) req.destroy()
            return
          }
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          if ((controller.desiredSize ?? 0) <= 0) req.pause()
        })
        req.once('end', () => {
          if (done) return
          done = true
          controller.close()
        })
        req.once('error', (error) => {
          if (done) return
          done = true
          controller.error(error)
        })
        req.once('close', () => {
          if (done) return
          // The client went away mid-body.
          done = true
          controller.error(new Error('request body aborted'))
        })
      },
      pull() {
        req.resume()
      },
      cancel() {
        abandon() // drain (and discard) the rest, bounded above
      },
    },
    { highWaterMark: 4, size: () => 1 },
  )
  return { stream, abandon }
}

function toRequest(
  req: IncomingMessage,
  origin: string,
  signal: AbortSignal,
  body: ReadableStream<Uint8Array> | undefined,
): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else headers.set(name, value)
  }
  const method = req.method ?? 'GET'
  // `req.url` is a path (origin-form). An absolute-form target must not change the origin.
  const path = (req.url ?? '/').startsWith('/') ? (req.url ?? '/') : '/'
  return new Request(new URL(path, origin), {
    method,
    headers,
    signal,
    ...(body ? { body, duplex: 'half' as const } : {}),
  })
}

/** Resolve on the next `drain` or `close`, removing both listeners (no listener build-up). */
function drainOrClose(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

/** Write a response with backpressure; stop (and cancel the body) when the client is gone. */
async function send(
  res: ServerResponse,
  response: Response,
  method: string,
  gone: AbortSignal,
): Promise<void> {
  const cookies = response.headers.getSetCookie()
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of response.headers)
    if (name !== 'set-cookie' && name !== UI_FALLTHROUGH_HEADER) headers[name] = value
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  const body = response.body
  if (!body) {
    res.end()
    return
  }
  if (method === 'HEAD' || gone.aborted) {
    await body.cancel().catch(() => undefined)
    res.end()
    return
  }
  const reader = body.getReader()
  const cancel = (): void => {
    reader.cancel().catch(() => undefined)
  }
  gone.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || gone.aborted || res.destroyed) break
      if (!res.write(value)) {
        // Wait for the socket to drain, or for the client to leave (then 'close' fires instead).
        if (res.destroyed) break // already gone: 'close' will not fire again
        await drainOrClose(res)
      }
    }
  } finally {
    gone.removeEventListener('abort', cancel)
    if (gone.aborted || res.destroyed) cancel()
    else reader.releaseLock()
    res.end()
  }
}

/** Serve `handler` until `close()` is called. */
export function serve(handler: FetchHandler, options: ServeOptions): Promise<RunningServer> {
  const hostname = options.hostname ?? '127.0.0.1'
  const hops = trustedHops(options.trustProxy)
  const publicUrl = parsePublicUrl(options.publicUrl)
  const bindHost = hostname.includes(':') ? `[${hostname}]` : hostname
  const server = createServer((req, res) => {
    // Fires when the client disconnects before the response finished (or the server closes).
    const controller = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    // A write racing a disconnect errors the response; treat it as the disconnect it is.
    res.on('error', () => controller.abort())
    const forwardedFor = req.headers['x-forwarded-for']
    const forwardedProto = req.headers['x-forwarded-proto']
    const protocol = forwardedProtocol(
      Array.isArray(forwardedProto) ? forwardedProto.join(',') : forwardedProto,
      hops,
      'http',
    )
    const origin = publicUrl
      ? publicUrl.origin
      : `${protocol}://${bindHost}:${String(req.socket.localPort)}`
    const bindings: ServeBindings = {
      incoming: req,
      clientAddress: clientAddressOf(
        req.socket.remoteAddress,
        Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor,
        hops,
      ),
    }
    const method = req.method ?? 'GET'
    const body = method !== 'GET' && method !== 'HEAD' ? requestBody(req) : undefined
    // A body the app never read (an early 413 or 401) is drained after the response, so the client
    // receives that answer instead of a connection reset (bounded by MAX_DISCARD_BYTES).
    res.once('finish', () => body?.abandon())
    Promise.resolve()
      .then(() => handler(toRequest(req, origin, controller.signal, body?.stream), bindings))
      .then((response) => {
        const fallback = options.fallback
        if (fallback === undefined || !response.headers.has(UI_FALLTHROUGH_HEADER))
          return send(res, response, method, controller.signal)
        return handOver(fallback, req, res, () => send(res, response, method, controller.signal))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return // the client left; nothing to report to it
        options.onError?.(error)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
        res.end()
      })
  })
  return Promise.resolve()
    .then(() => options.prepare?.(server))
    .then(() => listen(server, options.port, hostname, bindHost))
}

/**
 * Hand a request to a Connect-style handler. Resolves once it answered (the response finished or
 * the client left) or after `next()` and the app's own response were sent; rejects on
 * `next(error)` so the caller reports it and answers 500.
 */
function handOver(
  fallback: NodeFallback,
  req: IncomingMessage,
  res: ServerResponse,
  sendOwn: () => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let passed = false
    const done = (): void => {
      if (!passed) resolve()
    }
    res.once('close', done)
    try {
      fallback(req, res, (error) => {
        if (passed) return
        passed = true
        res.off('close', done)
        if (error !== undefined && error !== null) reject(error)
        else sendOwn().then(resolve, reject)
      })
    } catch (error) {
      passed = true
      res.off('close', done)
      reject(error)
    }
  })
}

function listen(
  server: Server,
  requestedPort: number,
  hostname: string,
  bindHost: string,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, hostname, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        url: `http://${bindHost}:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()))
            server.closeAllConnections()
          }),
      })
    })
  })
}
