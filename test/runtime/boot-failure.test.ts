/**
 * Boot failure cleanup: when one provider fails (or never finishes) booting, the providers that
 * already booted must be shut down again. Otherwise their connections, pools and timers stay open:
 * the process cannot exit, and `sv start` hangs after printing the error.
 */
import { createServer, type Server } from 'node:net'
import { describe, expect, it } from 'vitest'
import { defineProvider, ProviderError } from '../../src/core/index.ts'
import { BootTimeoutError, bootProject } from '../../src/runtime/boot.ts'
import type { LoadedProject } from '../../src/runtime/project.ts'

/** A provider that holds a real listening socket from boot until shutdown. */
function holdsSocket(log: string[]) {
  let socket: Server | undefined
  return defineProvider({
    name: 'holds-socket',
    register() {},
    async boot() {
      socket = createServer()
      await new Promise<void>((resolve) => socket?.listen(0, '127.0.0.1', resolve))
      log.push('socket open')
    },
    async shutdown() {
      await new Promise<void>((resolve) => socket?.close(() => resolve()))
      log.push('socket closed')
    },
  })
}

const project = (providers: LoadedProject['providers']): LoadedProject => ({
  root: process.cwd(),
  config: { app: { env: 'local' } },
  providers,
  models: [],
  resources: [],
  routes: [],
})

describe('bootProject: boot failure cleanup', () => {
  it('a provider that throws in boot: the providers booted before it are shut down', async () => {
    const log: string[] = []
    const failing = defineProvider({
      name: 'fails',
      register() {},
      boot() {
        throw new Error('cannot reach the mail server')
      },
    })
    const error = await bootProject(project([holdsSocket(log), failing])).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).provider).toBe('fails')
    expect(log).toEqual(['socket open', 'socket closed'])
  })

  it('a provider whose boot never settles: boot fails after the deadline and cleans up', async () => {
    const log: string[] = []
    const hangs = defineProvider({
      name: 'hangs',
      register() {},
      boot: () => new Promise<void>(() => undefined),
    })
    const started = Date.now()
    const error = await bootProject(project([holdsSocket(log), hangs]), {
      bootTimeoutMs: 200,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BootTimeoutError)
    expect((error as Error).message).toMatch(/did not finish booting within 200 ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(log).toEqual(['socket open', 'socket closed'])
  })

  it('rejects a nonsensical boot timeout', async () => {
    await expect(bootProject(project([]), { bootTimeoutMs: -1 })).rejects.toThrow(RangeError)
  })
})
