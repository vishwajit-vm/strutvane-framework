/**
 * A port the server cannot bind is a configuration problem with a stable code, the host and port,
 * and the fix, never a bare Node error: `serve()`, `startServer()` (`sv start`) and `sv dev`
 * (which checks before starting its watched child).
 */
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type CommandContextLike, commands } from '../../src/commands.ts'
import { migrateProject } from '../../src/runtime/migrations.ts'
import { loadProject } from '../../src/runtime/project.ts'
import {
  assertCanListen,
  ServerListenError,
  serve,
  toListenError,
} from '../../src/runtime/serve.ts'
import { startServer } from '../../src/runtime/server.ts'
import { makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** Hold a port on 127.0.0.1 for the test. */
async function occupy(): Promise<number> {
  const blocker: Server = createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())))
  const address = blocker.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe('listen errors', () => {
  it('serve() on a taken port rejects with PORT_IN_USE naming host, port and the fix', async () => {
    const port = await occupy()
    const error = await serve(() => new Response('x'), { port }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServerListenError)
    expect(error).toMatchObject({ code: 'PORT_IN_USE', host: '127.0.0.1', port })
    expect((error as Error).message).toContain(`Port ${port} is already in use (127.0.0.1:${port})`)
    expect((error as Error).message).toContain('APP_PORT')
    expect((error as Error).message).toContain('--port')
    expect((error as Error).cause).toMatchObject({ code: 'EADDRINUSE' })
  })

  it('assertCanListen probes and releases; port 0 always passes', async () => {
    const port = await occupy()
    await expect(assertCanListen(port)).rejects.toMatchObject({ code: 'PORT_IN_USE', port })
    await assertCanListen(0)
    // A free port passes and is released again (serve can take it right after).
    const free = await new Promise<number>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const a = s.address()
        s.close(() => resolve(typeof a === 'object' && a ? a.port : 0))
      })
    })
    await assertCanListen(free)
    const server = await serve(() => new Response('ok'), { port: free })
    await server.close()
  })

  it('maps EACCES and EADDRNOTAVAIL, and passes other errors through unchanged', () => {
    const node = (code: string) => Object.assign(new Error(code), { code })
    expect(toListenError(node('EACCES'), '0.0.0.0', 80)).toMatchObject({
      code: 'PORT_ACCESS_DENIED',
      message: expect.stringContaining('Not allowed to listen on 0.0.0.0:80'),
    })
    const v6 = toListenError(node('EADDRNOTAVAIL'), '::1', 3000) as Error
    expect(v6).toMatchObject({ code: 'ADDRESS_NOT_AVAILABLE', host: '::1' })
    expect(v6.message).toContain('[::1]:3000')
    expect(v6.message).toContain('--host')
    const other = node('ECONNRESET')
    expect(toListenError(other, 'h', 1)).toBe(other)
    expect(toListenError('text', 'h', 1)).toBe('text')
  })

  it('startServer (sv start) and sv dev report a taken port as ServerListenError', async () => {
    const port = await occupy()
    const p = await makeProject(projectFiles())
    cleanups.push(p.cleanup)
    await migrateProject(await loadProject(p.root, { dotenv: false }))
    await expect(startServer({ root: p.root, port, env: 'local' })).rejects.toMatchObject({
      name: 'ServerListenError',
      code: 'PORT_IN_USE',
      port,
    })
    // sv dev fails before it spawns the watched child.
    const dev = commands.find((c) => c.name === 'dev')
    if (!dev) throw new Error('dev command missing')
    const lines: string[] = []
    const ctx: CommandContextLike = {
      flags: { port: String(port) },
      requireProject: () => ({ root: p.root }),
      out: {
        line: (s = '') => lines.push(s),
        success: (s) => lines.push(s),
        info: (s) => lines.push(s),
        warn: (s) => lines.push(s),
        table: () => undefined,
      },
    }
    await expect(dev.run(ctx)).rejects.toMatchObject({ code: 'PORT_IN_USE', port })
    expect(lines).toEqual([])
  })
})
