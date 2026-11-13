/**
 * A minimal Node HTTP adapter for Web `fetch` handlers (no extra dependency).
 *
 * Request bodies are streamed, never buffered here (the app's body limit applies). The adapter
 * listens on 127.0.0.1 by default; binding other interfaces is an explicit choice.
 *
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

/** A Web request handler. */
export type FetchHandler = (request: Request) => Response | Promise<Response>

/** A running server. */
export interface RunningServer {
  readonly port: number
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
}

function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else headers.set(name, value)
  }
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' as const }
      : {}),
  })
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const cookies = response.headers.getSetCookie()
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>)
      res.write(chunk)
  }
  res.end()
}

/** Serve `handler` until `close()` is called. */
export function serve(handler: FetchHandler, options: ServeOptions): Promise<RunningServer> {
  const hostname = options.hostname ?? '127.0.0.1'
  const origin = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}`
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handler(toRequest(req, `${origin}:${String(req.socket.localPort)}`)))
      .then((response) => send(res, response))
      .catch((error: unknown) => {
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
        url: `${origin}:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()))
            server.closeAllConnections()
          }),
      })
    })
  })
}
