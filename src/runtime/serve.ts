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
 * The handler receives a second argument, {@link ServeBindings}, with the Node request, the socket
 * peer (`ip`), the resolved client address and `waitUntil`; Hono exposes it as `c.env`
 * (compatible with `@hono/node-server`). An `Application` takes the same two:
 * `serve((request, b) => app.handle(request, b), options)`.
 *
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo, createServer as createNetServer } from 'node:net'
import {
  type ForwardedRequest,
  forwardedClient,
  parsePublicUrl,
  resolveTrustProxy,
  type TrustProxy,
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
  /** The TCP peer address, never from headers (`Application.handle`'s `ip`). */
  readonly ip: string | undefined
  /**
   * Run work after the response is sent (deferred tasks, terminable middleware) without delaying
   * it. The server keeps track of it: `close()` waits for it within the grace period, and a
   * failure goes to `onError` instead of becoming an unhandled rejection.
   */
  readonly waitUntil: (work: Promise<void>) => void
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
  /**
   * Stop gracefully: stop accepting connections, close idle keep-alive connections, let requests
   * already in flight finish (their responses carry `Connection: close`), and after `graceMs`
   * (default {@link DEFAULT_CLOSE_GRACE_MS}) cut off whatever is left, aborting those requests'
   * signals. Idempotent: every call returns the same shutdown.
   */
  close(options?: CloseOptions): Promise<void>
}

/** Options for {@link RunningServer.close}. */
export interface CloseOptions {
  /** How long in-flight requests may take to finish before their connections are cut. */
  readonly graceMs?: number
}

/**
 * Default grace period for in-flight requests on {@link RunningServer.close}. Below the usual
 * process-manager kill delay (Docker and Kubernetes send SIGKILL 10 s and 30 s after SIGTERM),
 * so requests drain and the app still shuts down its providers and flushes logs in time.
 */
export const DEFAULT_CLOSE_GRACE_MS = 8_000

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
   * The proxies in front of the app whose `X-Forwarded-For` / `X-Forwarded-Proto` may be
   * believed: a hop count (`true` = one) or the proxies' addresses or CIDR ranges
   * (`['10.0.0.0/8']`, the safer form). Default `false`: those headers are ignored, because any
   * client can send them. Set it only when a proxy you control always overwrites them. A bad
   * entry (`'*'`, a malformed range) throws when `serve` is called.
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
  /**
   * The timer behind the close grace period. Default: a real (ref'd) `setTimeout`. Tests pass
   * a manual one, so "the grace period expired" happens exactly when they say, not when a busy
   * machine gets round to it.
   */
  readonly timer?: GraceTimer
}

/**
 * Schedules `callback` after `ms` and returns a function that cancels it.
 *
 * @example
 * const timer: GraceTimer = (callback, ms) => {
 *   const handle = setTimeout(callback, ms)
 *   return () => clearTimeout(handle)
 * }
 */
export type GraceTimer = (callback: () => void, ms: number) => () => void

/** The default {@link GraceTimer}: ref'd on purpose, so the deadline fires even on an idle loop. */
const realTimer: GraceTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms)
  return () => clearTimeout(handle)
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
  // Appended to the origin, never resolved against it: resolving `//host/x` (or `/\host/x`) as a
  // relative reference would make it a scheme-relative URL that replaces the host.
  const url = new URL(`${origin}${path}`)
  if (url.origin !== new URL(origin).origin)
    throw new TypeError('request target changed the origin')
  return new Request(url, {
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
  const proxies = resolveTrustProxy(options.trustProxy)
  const publicUrl = parsePublicUrl(options.publicUrl)
  const bindHost = hostname.includes(':') ? `[${hostname}]` : hostname
  const inFlight = new InFlight(options.timer ?? realTimer)
  const server = createServer((req, res) => {
    inFlight.add(res)
    // Fires when the client disconnects before the response finished (or the server closes).
    const controller = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    // A write racing a disconnect errors the response; treat it as the disconnect it is.
    res.on('error', () => controller.abort())
    const peer = req.socket.remoteAddress
    const bindOrigin = `http://${bindHost}:${String(req.socket.localPort)}`
    const client = forwardedClient(peer, nodeView(req, bindOrigin), proxies)
    const origin = publicUrl
      ? publicUrl.origin
      : `${client.secure ? 'https' : 'http'}://${bindHost}:${String(req.socket.localPort)}`
    const bindings: ServeBindings = {
      incoming: req,
      clientAddress: client.ip,
      ip: peer,
      waitUntil: (work) => inFlight.track(work, options.onError),
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
    .then(() => listen(server, options.port, hostname, bindHost, options.onError, inFlight))
}

/** The Node request as {@link forwardedClient} reads it (no `Request` is built for this). */
function nodeView(req: IncomingMessage, bindOrigin: string): ForwardedRequest {
  return {
    url: `${bindOrigin}/`,
    headers: {
      get(name) {
        const value = req.headers[name.toLowerCase()]
        return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value
      },
    },
  }
}

/**
 * The responses still being produced and the work handed to `waitUntil`, so `close()` can wait
 * for them instead of resetting their connections (which is what `closeAllConnections()` alone
 * does to every in-flight request).
 */
class InFlight {
  readonly #open = new Set<ServerResponse>()
  readonly #work = new Set<Promise<void>>()
  #draining = false
  #idle: (() => void) | undefined
  readonly #timer: GraceTimer

  constructor(timer: GraceTimer) {
    this.#timer = timer
  }

  /** Keep `work` until it settles; a failure is reported, never an unhandled rejection. */
  track(work: Promise<void>, onError: ((error: unknown) => void) | undefined): void {
    const settled = work.then(
      () => undefined,
      (error: unknown) => {
        try {
          onError?.(error)
        } catch {
          // A failing reporter must not turn finished work into an unhandled rejection.
        }
      },
    )
    this.#work.add(settled)
    void settled.then(() => {
      this.#work.delete(settled)
      this.#checkIdle()
    })
  }

  #checkIdle(): void {
    if (this.#open.size === 0 && this.#work.size === 0) this.#idle?.()
  }

  add(res: ServerResponse): void {
    // A request that arrives on a kept-alive connection during a drain is still answered, but
    // its connection closes afterwards so the client reconnects elsewhere.
    if (this.#draining) res.shouldKeepAlive = false
    this.#open.add(res)
    res.once('close', () => {
      this.#open.delete(res)
      this.#checkIdle()
    })
  }

  /** Resolve once nothing is in flight, or after `graceMs`, whichever comes first. */
  drain(graceMs: number): Promise<void> {
    this.#draining = true
    for (const res of this.#open) if (!res.headersSent) res.shouldKeepAlive = false
    if (this.#open.size === 0 && this.#work.size === 0) return Promise.resolve()
    return new Promise((resolve) => {
      let cancel: (() => void) | undefined
      const done = (): void => {
        cancel?.()
        resolve()
      }
      this.#idle = done
      cancel = this.#timer(done, graceMs)
    })
  }
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

/** Why the server could not bind, as a stable code (the CLI maps these to its config exit code). */
export type ListenErrorCode = 'port_in_use' | 'port_access_denied' | 'address_not_available'

const LISTEN_ERROR_CODES: Readonly<Record<string, ListenErrorCode>> = {
  EADDRINUSE: 'port_in_use',
  EACCES: 'port_access_denied',
  EADDRNOTAVAIL: 'address_not_available',
}

/**
 * The server could not bind its address: a configuration problem (another process has the port,
 * a privileged port, an interface this machine does not have), not a bug. Carries the stable
 * `code`, the `host` and `port` it tried, and how to change them, so the CLI renders a config
 * error (matched by `code`, never by message) instead of "Unexpected error … report the bug".
 */
export class ServerListenError extends Error {
  override readonly name = 'ServerListenError'
  readonly code: ListenErrorCode
  readonly host: string
  readonly port: number

  constructor(code: ListenErrorCode, host: string, port: number, cause?: unknown) {
    const where = `${host.includes(':') ? `[${host}]` : host}:${port}`
    const what =
      code === 'port_in_use'
        ? `Port ${port} is already in use (${where}).`
        : code === 'port_access_denied'
          ? `Not allowed to listen on ${where}.`
          : `Cannot listen on ${where}: this machine has no such address.`
    super(
      `${what} Choose another port with APP_PORT in .env or --port <number>` +
        `${code === 'address_not_available' ? ', or another interface with --host' : ''}.`,
      cause === undefined ? undefined : { cause },
    )
    this.code = code
    this.host = host
    this.port = port
  }
}

/**
 * Map a `listen()` failure to a {@link ServerListenError} when it is one of the configuration
 * problems above; any other error is returned unchanged.
 */
export function toListenError(error: unknown, host: string, port: number): unknown {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? LISTEN_ERROR_CODES[error.code]
      : undefined
  return code === undefined ? error : new ServerListenError(code, host, port, error)
}

/**
 * Fail fast with a {@link ServerListenError} when `host:port` cannot be bound right now (bind,
 * then release it). `sv dev` checks this before it starts the watched child process, because a
 * child that fails to listen leaves Node's watch mode waiting for file changes instead of exiting.
 * Port 0 (any free port) always passes.
 */
export function assertCanListen(port: number, host = '127.0.0.1'): Promise<void> {
  if (port === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', (error) => reject(toListenError(error, host, port)))
    probe.listen(port, host, () => probe.close(() => resolve()))
  })
}

function listen(
  server: Server,
  requestedPort: number,
  hostname: string,
  bindHost: string,
  onError: ((error: unknown) => void) | undefined,
  inFlight: InFlight,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(toListenError(error, hostname, requestedPort))
    }
    server.once('error', onListenError)
    server.listen(requestedPort, hostname, () => {
      // A listening server can still emit 'error' (accept failures such as EMFILE when the
      // process runs out of file descriptors; Node keeps accepting afterwards). With no listener
      // that event is an uncaught exception that takes the whole app down, so keep one for the
      // server's lifetime and report through onError.
      server.off('error', onListenError)
      server.on('error', (error) => {
        try {
          onError?.(error)
        } catch {
          // A failing reporter must not turn a recoverable accept error into a crash.
        }
      })
      const { port } = server.address() as AddressInfo
      let closing: Promise<void> | undefined
      const close = async (graceMs: number): Promise<void> => {
        const closed = new Promise<void>((done, fail) => {
          server.close((error) => (error ? fail(error) : done()))
        })
        // Stop accepting, drop idle keep-alive connections, let in-flight requests finish, then
        // cut whatever outlived the grace period (their request signals abort).
        server.closeIdleConnections()
        await inFlight.drain(graceMs)
        server.closeAllConnections()
        await closed
      }
      resolve({
        port,
        url: `http://${bindHost}:${port}`,
        close: (options = {}) => {
          const graceMs = options.graceMs ?? DEFAULT_CLOSE_GRACE_MS
          if (!Number.isFinite(graceMs) || graceMs < 0)
            return Promise.reject(new RangeError('graceMs must be a non-negative number'))
          closing ??= close(graceMs)
          return closing
        },
      })
    })
  })
}
