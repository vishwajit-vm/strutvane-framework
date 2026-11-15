// A provider that fails to boot must not leave the providers booted before it running.
import { describe, expect, test } from 'vitest'
import { defineProvider } from '../../src/core/index.ts'
import { bootProject } from '../../src/runtime/boot.ts'
import type { LoadedProject } from '../../src/runtime/project.ts'

describe('bootProject', () => {
  test('a boot failure shuts down the providers that already booted, in reverse order', async () => {
    const events: string[] = []
    const opened = (name: string) =>
      defineProvider({
        name,
        register() {},
        boot() {
          events.push(`boot ${name}`) // e.g. a database pool or a queue connection
        },
        shutdown() {
          events.push(`shutdown ${name}`)
        },
      })
    const failing = defineProvider({
      name: 'failing',
      register() {},
      boot() {
        throw new Error('cannot reach the mail server')
      },
    })
    const project: LoadedProject = {
      root: process.cwd(),
      config: { app: { env: 'local' } },
      providers: [opened('db'), opened('cache'), failing],
      models: [],
      resources: [],
      routes: [],
    }
    await expect(bootProject(project, { env: 'local' })).rejects.toThrow(/mail server/)
    expect(events).toEqual(['boot db', 'boot cache', 'shutdown cache', 'shutdown db'])
  })
})
