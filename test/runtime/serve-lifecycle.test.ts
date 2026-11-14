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
