/** The installer runtime: transactional, previewable, idempotent, reversible. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DevkitError } from '../src/errors.ts'
import {
  checkIdempotent,
  type DevkitInstaller,
  defineInstaller,
  runInstaller,
} from '../src/installer.ts'
import { faultyIo, readFile, rejectionOf, snapshot, tempProject, writeFiles } from './helpers.ts'

const CONFIG = `import { defineConfig } from '@strutvane/core'

export default defineConfig({
  providers: [],
})
`

/**
 * A realistic installer, shaped like `@strutvane/auth`'s: a config file, env vars (one secret),
 * dependencies and a provider. Its uninstall reverses all of it.
 */
const sampleInstaller = defineInstaller({
  name: 'sample-auth',
  enhances: ['@strutvane/ui'],
  async install({ fs, env, deps, config, log, has, answers }) {
    const { strategy } = answers
    await fs.write(
      'config/auth.ts',
      `export default { strategy: '${String(strategy ?? 'session')}' }\n`,
    )
    await env.add('Auth', [
      { key: 'AUTH_SECRET', secret: true, comment: 'Signs session cookies' },
      { key: 'AUTH_URL', value: 'http://localhost:3000' },
    ])
    await deps.add({ 'better-auth': '1.4.0' })
    await config.registerProvider('@strutvane/auth/provider')
    if (has('@strutvane/ui')) log.info('ui detected: auth screens enabled')
    else log.warn('ui not installed: skipping auth screens')
  },
  async uninstall({ fs, env, deps, config }) {
    await fs.remove('config/auth.ts')
    await env.remove(['AUTH_SECRET', 'AUTH_URL'])
    await deps.remove(['better-auth'])
    await config.unregisterProvider('@strutvane/auth/provider')
  },
} satisfies DevkitInstaller)

let projectRoot: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  await writeFiles(projectRoot, {
    'package.json': `${JSON.stringify({ name: 'app', dependencies: { zod: '4.6.7' } }, null, 2)}\n`,
    'strutvane.config.ts': CONFIG,
  })
})
afterEach(() => cleanup())

describe('E2E: sample installer', () => {
  test('install → install again is identical → uninstall restores the project', async () => {
    const original = await snapshot(projectRoot)

    const first = await runInstaller(sampleInstaller, { projectRoot })
    expect(first.committed).toBe(true)
    expect(first.changes.map((c) => [c.path, c.kind])).toEqual([
      ['.env', 'create'],
      ['.env.example', 'create'],
      ['config/auth.ts', 'create'],
      ['package.json', 'update'],
      ['strutvane.config.ts', 'update'],
    ])
    const afterFirst = await snapshot(projectRoot)
    expect(afterFirst['.env']).toMatch(/AUTH_SECRET=[A-Za-z0-9_-]{43}\n/)
    expect(afterFirst['.env.example']).toContain('AUTH_SECRET=\n')
    expect(afterFirst['strutvane.config.ts']).toContain('authProvider')
    expect(JSON.parse(afterFirst['package.json'] ?? '{}').dependencies['better-auth']).toBe('1.4.0')

    const second = await runInstaller(sampleInstaller, { projectRoot })
    expect(second.changes).toEqual([])
    expect(second.committed).toBe(false)
    expect(await snapshot(projectRoot)).toEqual(afterFirst) // the secret was NOT regenerated

    const removed = await runInstaller(sampleInstaller, { projectRoot, mode: 'uninstall' })
    expect(removed.mode).toBe('uninstall')
    const after = await snapshot(projectRoot)
    // .env files stay (they may hold the developer's other values) but are emptied of our keys.
    expect(after['.env']).toBe('')
    expect(after['.env.example']).toBe('')
    const { '.env': _e, '.env.example': _x, ...rest } = after
    expect(rest).toEqual(original)
  })

  test('checkIdempotent reports nothing left to change for a well-behaved installer', async () => {
    expect(await checkIdempotent(sampleInstaller, { projectRoot })).toEqual([])
  })

  test('checkIdempotent catches a non-idempotent installer', async () => {
    let runs = 0
    const bad = defineInstaller({
      name: 'counter',
      async install({ fs }) {
        await fs.write('count.txt', `${++runs}\n`, { overwrite: true })
      },
    })
    expect((await checkIdempotent(bad, { projectRoot })).map((c) => c.path)).toEqual(['count.txt'])
  })
})

describe('runInstaller', () => {
  test('dry run returns the diff and messages and writes nothing', async () => {
    const before = await snapshot(projectRoot)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const result = await runInstaller(sampleInstaller, {
      projectRoot,
      dryRun: true,
      answers: { strategy: 'jwt' },
      installedPackages: ['@strutvane/ui'],
      logger,
    })
    expect(result).toMatchObject({ dryRun: true, committed: false, installer: 'sample-auth' })
    expect(result.diff).toContain("+export default { strategy: 'jwt' }")
    expect(result.messages).toEqual([
      { level: 'info', message: 'ui detected: auth screens enabled' },
    ])
    expect(logger.info).toHaveBeenCalledWith('ui detected: auth screens enabled')
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('warnings are collected and forwarded', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const result = await runInstaller(sampleInstaller, { projectRoot, dryRun: true, logger })
    expect(result.messages).toEqual([
      { level: 'warn', message: 'ui not installed: skipping auth screens' },
    ])
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  test('an installer that throws halfway changes nothing (INSTALLER_FAILED)', async () => {
    const before = await snapshot(projectRoot)
    const broken = defineInstaller({
      name: 'broken',
      async install({ fs, env }) {
        await fs.write('a.ts', 'a\n')
        await env.add('X', [{ key: 'X', value: '1' }])
        throw new Error('boom')
      },
    })
    const error = await rejectionOf(runInstaller(broken, { projectRoot }))
    expect((error as DevkitError).code).toBe('INSTALLER_FAILED')
    expect((error as Error).message).toMatch(/nothing was changed.*boom/)
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('a DevkitError from an editor surfaces unchanged (its code is the useful part)', async () => {
    const local = defineInstaller({
      name: 'local-dep',
      async install({ deps }) {
        await deps.add({ x: 'link:../x' })
      },
    })
    const error = await rejectionOf(runInstaller(local, { projectRoot }))
    expect((error as DevkitError).code).toBe('LOCAL_DEPENDENCY_SPEC')
  })

  test('an I/O failure during commit rolls everything back', async () => {
    const before = await snapshot(projectRoot)
    const error = await rejectionOf(runInstaller(sampleInstaller, { projectRoot, io: faultyIo(3) }))
    expect((error as DevkitError).code).toBe('TRANSACTION_ABORTED')
    expect(await snapshot(projectRoot)).toEqual(before)
  })

  test('uninstall without an uninstall hook is refused', async () => {
    const noUninstall = defineInstaller({ name: 'one-way', async install() {} })
    const error = await rejectionOf(runInstaller(noUninstall, { projectRoot, mode: 'uninstall' }))
    expect((error as DevkitError).code).toBe('UNINSTALL_NOT_SUPPORTED')
  })

  test('the context exposes the project root and dry-run flag', async () => {
    const seen: unknown[] = []
    const probe = defineInstaller({
      name: 'probe',
      async install(ctx) {
        seen.push(ctx.projectRoot, ctx.dryRun, ctx.answers)
      },
    })
    await runInstaller(probe, { projectRoot, dryRun: true })
    expect(seen).toEqual([projectRoot, true, {}])
    expect(await readFile(projectRoot, '.env')).toBeUndefined()
  })
})

describe('defineInstaller', () => {
  test('returns a frozen installer', () => {
    expect(Object.isFrozen(sampleInstaller)).toBe(true)
  })

  test.each([
    ['not an object', null],
    ['a bad name', { name: 'Bad Name', install: async () => {} }],
    ['a missing name', { install: async () => {} }],
    ['no install', { name: 'x' }],
    ['a non-function uninstall', { name: 'x', install: async () => {}, uninstall: 'nope' }],
    ['a non-list enhances', { name: 'x', install: async () => {}, enhances: '@strutvane/ui' }],
    ['non-string enhances', { name: 'x', install: async () => {}, enhances: [1] }],
  ])('rejects %s', (_, value) => {
    expect(() => defineInstaller(value as unknown as DevkitInstaller)).toThrow(
      expect.objectContaining({ code: 'INVALID_INSTALLER' }),
    )
  })
})
