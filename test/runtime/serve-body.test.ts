// Attack-style: a request body the app abandons mid-stream (body limit, aborted upload) must never
// crash the server. `Readable.toWeb(req)` threw an uncaught "Controller is already closed" here.
import { describe, expect, test } from 'vitest'
import { MAX_DISCARD_BYTES, serve } from '../../src/runtime/serve.ts'
import { parseMultipart } from '../../src/storage/multipart.ts'

const chunked = (chunks: number, size = 64 * 1024) => {
  let n = 0
  const chunk = new Uint8Array(size).fill(120)
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (n++ < chunks) c.enqueue(chunk)
      else c.close()
    },
  })
}

describe('serve: abandoned request bodies', () => {
  test('cancelling after the first chunk, ignoring the body, or reading it all: the server survives', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    const server = await serve(
      async (request) => {
        const path = new URL(request.url).pathname
        if (path === '/cancel') {
          const reader = request.body?.getReader()
          await reader?.read()
          await reader?.cancel()
          return new Response('stopped', { status: 413 })
        }
        if (path === '/ignore') return new Response('no', { status: 401 })
        if (path === '/multipart') {
          // The parser aborts the body as soon as the file passes its limit.
          const parsed = await parseMultipart(request, { maxFileSize: 1024 }).catch(() => undefined)
          await parsed?.cleanup()
          return new Response('too large', { status: 413 })
        }
        return new Response(String((await request.arrayBuffer()).byteLength))
      },
      { port: 0 },
    )
    try {
      const send = (path: string, chunks: number) =>
        fetch(`${server.url}${path}`, {
          method: 'POST',
          body: chunked(chunks),
          duplex: 'half',
        } as RequestInit).then(
          async (r) => ({ status: r.status as number | 'reset', text: await r.text() }),
          () => ({ status: 'reset' as const, text: '' }),
        )
      // Within the discard budget the client gets the app's answer.
      expect(await send('/cancel', 8)).toEqual({ status: 413, text: 'stopped' })
      expect(await send('/ignore', 8)).toEqual({ status: 401, text: 'no' })
      // Far beyond it the connection is closed (bounded work for the server), never a crash.
      const chunks = Math.ceil((MAX_DISCARD_BYTES * 4) / (64 * 1024))
      expect([413, 'reset']).toContain((await send('/cancel', chunks)).status)
      expect([401, 'reset']).toContain((await send('/ignore', chunks)).status)
      // A multipart upload aborted by the parser mid-stream (the crash seen in the playground).
      const boundary = 'b0undary'
      const head = new TextEncoder().encode(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="a.bin"',
          'Content-Type: application/octet-stream',
          '',
          '',
        ].join('\r\n'),
      )
      for (const n of [8, 40]) {
        let i = 0
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (i === 0) c.enqueue(head)
            if (i++ < n) c.enqueue(new Uint8Array(64 * 1024).fill(1))
            else c.close()
          },
        })
        const r = await fetch(`${server.url}/multipart`, {
          method: 'POST',
          body,
          duplex: 'half',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        } as RequestInit).then(
          (x) => x.status,
          () => 'reset',
        )
        expect([413, 'reset']).toContain(r)
      }
      // Normal bodies still stream through completely.
      expect(await send('/read', 20)).toEqual({ status: 200, text: String(20 * 64 * 1024) })
      await new Promise((r) => setTimeout(r, 100))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      await server.close()
    }
  })
})
