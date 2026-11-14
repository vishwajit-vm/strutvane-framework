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
 * The handler receives a second argument, {@link ServeBindings}, with the Node request and the
 * resolved client address; Hono exposes it as `c.env` (compatible with `@hono/node-server`).
 *
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import {
  clientAddressOf,
  forwardedProtocol,
  parsePublicUrl,
  type TrustProxy,
  trustedHops,
} from '../http/proxy.ts'

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
}

function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else headers.set(name, value)
  }
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  // `req.url` is a path (origin-form). An absolute-form target must not change the origin.
  const path = (req.url ?? '/').startsWith('/') ? (req.url ?? '/') : '/'
  return new Request(new URL(path, origin), {
    method,
    headers,
    signal,
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' as const }
      : {}),
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
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value
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
    Promise.resolve()
      .then(() => handler(toRequest(req, origin, controller.signal), bindings))
      .then((response) => send(res, response, method, controller.signal))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return // the client left; nothing to report to it
        options.onError?.(error)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
        res.end()
      })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, hostname, () => {
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
