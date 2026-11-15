/**
 * Graceful shutdown of a served app (`sv start`): SIGINT/SIGTERM, and the IPC shutdown message that
 * process managers and `sv` use on Windows, where an external SIGTERM kills the process without
 * running any handler (ADR-0015). Requests in flight finish, providers shut down, the exit code
 * tells a requested stop (143 for SIGTERM) from a crash, and a second trigger is not a second stop.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, createLogger, LoggerToken } from '../../src/core/index.ts'
import {
  exitCodeForStop,
  SHUTDOWN_MESSAGE,
  type ShutdownSource,
  type StartedServer,
  stopOnSignals,
} from '../../src/runtime/server.ts'
import { IMPORTS, makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** A process stand-in: signals and messages are emitted by the test. */
function fakeProcess(ipc: boolean): EventEmitter & ShutdownSource {
  const emitter = new EventEmitter()
  return Object.assign(emitter, ipc ? { send: () => true } : {}) as EventEmitter & ShutdownSource
}

function fakeStarted(stop: () => Promise<void>, lines: string[] = []): StartedServer {
  const app = createApp({ config: {} })
  app.container.value(LoggerToken, createLogger({ sink: (l) => void lines.push(l) }))
  return {
    stop,
    project: { app, http: {} as never, env: 'test', shutdown: async () => undefined },
    server: { port: 0, url: 'http://127.0.0.1:0', close: async () => undefined },
  }
}

describe('stopOnSignals', () => {
  it('SIGTERM stops once, removes its listeners and reports the reason; exit code 143', async () => {
    const source = fakeProcess(true)
    const stop = vi.fn(async () => undefined)
    const stopped = stopOnSignals(fakeStarted(stop), { source })
    source.emit('SIGTERM')
    source.emit('SIGTERM') // a second signal is not a second stop
    expect(await stopped).toBe('SIGTERM')
    expect(stop).toHaveBeenCalledTimes(1)
    for (const event of ['SIGINT', 'SIGTERM', 'message'])
      expect(source.listenerCount(event)).toBe(0)
    expect(exitCodeForStop('SIGTERM')).toBe(143)
    expect(exitCodeForStop('SIGINT')).toBe(130)
    expect(exitCodeForStop('shutdown-message')).toBe(0)
  })

  it('the IPC shutdown message stops gracefully; other messages are ignored', async () => {
    const source = fakeProcess(true)
    const stop = vi.fn(async () => undefined)
    const stopped = stopOnSignals(fakeStarted(stop), { source })
    source.emit('message', 'reload')
    source.emit('message', { type: 'shutdown' })
    expect(stop).not.toHaveBeenCalled()
    source.emit('message', SHUTDOWN_MESSAGE)
    expect(await stopped).toBe('shutdown-message')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('without an IPC channel no message listener is added (it would keep the process alive)', () => {
    const source = fakeProcess(false)
    void stopOnSignals(
      fakeStarted(async () => undefined),
      { source },
    )
    expect(source.listenerCount('message')).toBe(0)
    source.emit('SIGINT')
  })

  it('a failing stop is logged, not swallowed, and still resolves', async () => {
    const source = fakeProcess(false)
    const lines: string[] = []
    const stopped = stopOnSignals(
      fakeStarted(async () => {
        throw new Error('pool.end() failed')
      }, lines),
      { source },
    )
    source.emit('SIGINT')
    expect(await stopped).toBe('SIGINT')
    expect(lines.join('\n')).toMatch(/Graceful shutdown failed.*pool\.end\(\) failed/)
  })
})

describe('graceful shutdown of a real served app (child process)', () => {
  it('the shutdown message drains the request in flight and the process exits 0', async () => {
    const project = await makeProject(
      projectFiles({
        'app/http/routes/slow.ts': `import { route } from '${IMPORTS.http}'
export default [
  route.get('/slow', { public: true, handler: async () => {
    process.send?.({ type: 'started' })
    await new Promise((r) => setTimeout(r, 700))
    return { finished: true }
  } }),
]
`,
      }),
    )
    cleanups.push(project.cleanup)
    const serverUrl = new URL('../../src/runtime/server.ts', import.meta.url).href
    const code = `
import { startServer, stopOnSignals } from ${JSON.stringify(serverUrl)}
const started = await startServer({ root: ${JSON.stringify(project.root)}, port: 0, web: false })
process.send({ type: 'ready', url: started.server.url })
const reason = await stopOnSignals(started)
process.stderr.write('stopped: ' + reason + '\\n')
process.disconnect()
`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, APP_ENV: 'local' },
    })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    const url = await new Promise<string>((resolve, reject) => {
      child.once('message', (m) => resolve((m as { url: string }).url))
      child.once('exit', () => reject(new Error(`child exited early: ${stderr}`)))
    })
    // Wait until the request reached the handler (a fixed sleep can end first under load, and a
    // connection without a request yet is idle, so the drain rightly drops it).
    const started = new Promise<void>((resolve) =>
      child.on('message', (m) => {
        if ((m as { type?: string }).type === 'started') resolve()
      }),
    )
    const inFlight = fetch(`${url}/api/v1/slow`).then(async (r) => ({
      status: r.status,
      body: await r.json(),
    }))
    await started
    child.send(SHUTDOWN_MESSAGE)
    expect(await inFlight).toEqual({ status: 200, body: { finished: true } })
    expect(await exited).toBe(0)
    expect(stderr).toContain('stopped: shutdown-message')
  }, 120_000)
})
