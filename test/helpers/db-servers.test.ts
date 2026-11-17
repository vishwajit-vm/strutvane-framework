/**
 * The real-server global setup's decisions (`db-servers.ts`): when Docker counts as usable, when a
 * server that can't start is a skip and when it must fail the run, and that the throwaway
 * password never reaches a test title or an error.
 */
import { describe, expect, test, vi } from 'vitest'
import {
  dockerMode,
  mustStart,
  redact,
  resolveServers,
  type ServerEnvironment,
  type ServerSpec,
} from './db-servers.ts'

const spec = (key: ServerSpec['key'], image: string): ServerSpec => ({
  key,
  image,
  port: 1,
  offSwitch: `STRUTVANE_TEST_${key.toUpperCase()}`,
  env: () => [],
  url: () => `${key}://x`,
})
const SPECS = [spec('mysql', 'mysql:8.4'), spec('postgres', 'postgres:18-alpine')]

function outside(overrides: Partial<ServerEnvironment> = {}): ServerEnvironment & {
  readonly removed: string[]
} {
  const removed: string[] = []
  return {
    env: {},
    platform: 'win32',
    dockerUnusable: async () => undefined,
    start: async (server) => `${server.key}://up`,
    remove: async (name) => {
      removed.push(name)
    },
    removed,
    ...overrides,
  }
}

describe('STRUTVANE_TEST_DOCKER', () => {
  test.each([
    [undefined, 'auto'],
    ['', 'auto'],
    ['auto', 'auto'],
    ['off', 'off'],
    ['require', 'require'],
  ] as const)('%j is %s', (value, mode) => {
    expect(dockerMode(value === undefined ? {} : { STRUTVANE_TEST_DOCKER: value })).toBe(mode)
  })

  test.each(['of', 'OFF', 'true', 'required'])('refuses the unknown value %j', (value) => {
    expect(() => dockerMode({ STRUTVANE_TEST_DOCKER: value })).toThrow(/off, require or auto/)
  })
})

describe('when a server that cannot start fails the run', () => {
  test.each([
    ['require', {}, 'win32', true],
    ['require', {}, 'darwin', true],
    ['off', { CI: 'true' }, 'linux', false],
    ['auto', { CI: 'true' }, 'linux', true],
    ['auto', { CI: '1' }, 'linux', true],
    ['auto', { CI: 'false' }, 'linux', false],
    ['auto', { CI: '0' }, 'linux', false],
    ['auto', { CI: '' }, 'linux', false],
    ['auto', {}, 'linux', false],
    ['auto', { CI: 'true' }, 'win32', false],
    ['auto', { CI: 'true' }, 'darwin', false],
  ] as const)('%s with %j on %s: %s', (mode, env, platform, strict) => {
    expect(mustStart(mode, env, platform)).toBe(strict)
  })
})

describe('resolveServers', () => {
  test('off: starts nothing and does not even ask Docker', async () => {
    const dockerUnusable = vi.fn(async () => undefined)
    const start = vi.fn(async () => 'x://')
    const result = await resolveServers(
      SPECS,
      outside({
        env: { STRUTVANE_TEST_DOCKER: 'off', CI: 'true' },
        platform: 'linux',
        dockerUnusable,
        start,
      }),
      's',
    )
    expect(result.infos).toEqual([
      { skipped: 'STRUTVANE_TEST_DOCKER=off' },
      { skipped: 'STRUTVANE_TEST_DOCKER=off' },
    ])
    expect(result.started).toEqual([])
    expect(dockerUnusable).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  test('starts every server under a unique name; a per-server off switch skips one', async () => {
    const result = await resolveServers(
      SPECS,
      outside({ env: { STRUTVANE_TEST_MYSQL: 'off' } }),
      'abc',
    )
    expect(result.infos).toEqual([
      { skipped: 'STRUTVANE_TEST_MYSQL=off' },
      { url: 'postgres://up' },
    ])
    expect(result.started).toEqual(['strutvane-fw-test-postgres-abc'])
  })

  test('Docker without Linux containers (a Windows runner): every server skipped, with the reason', async () => {
    const reason = 'Docker runs windows containers here; the test servers need Linux containers'
    const start = vi.fn(async () => 'x://')
    const result = await resolveServers(
      SPECS,
      outside({ env: { CI: 'true' }, dockerUnusable: async () => reason, start }),
      's',
    )
    expect(result.infos).toEqual([
      { skipped: `${reason} (needed for mysql:8.4)` },
      { skipped: `${reason} (needed for postgres:18-alpine)` },
    ])
    expect(start).not.toHaveBeenCalled()
  })

  test.each([
    ['require', { STRUTVANE_TEST_DOCKER: 'require' }, 'win32'],
    ['Linux CI', { CI: 'true' }, 'linux'],
  ] as const)('unusable Docker fails the run under %s', async (_label, env, platform) => {
    await expect(
      resolveServers(
        SPECS,
        outside({ env, platform, dockerUnusable: async () => 'Docker is not available' }),
        's',
      ),
    ).rejects.toThrow(/Docker is not available\. The real-server suites must run here/)
  })

  test('a server that fails to start is removed and skipped; the others still run', async () => {
    const env = outside({
      start: async (server) => {
        if (server.key === 'mysql')
          throw new Error('docker run mysql:8.4: no matching manifest\nmore')
        return 'postgres://up'
      },
    })
    const result = await resolveServers(SPECS, env, 's')
    expect(result.infos).toEqual([
      { skipped: 'mysql:8.4 could not start: docker run mysql:8.4: no matching manifest' },
      { url: 'postgres://up' },
    ])
    expect(env.removed).toEqual(['strutvane-fw-test-mysql-s'])
  })

  test.each([
    ['STRUTVANE_TEST_DOCKER=require', { STRUTVANE_TEST_DOCKER: 'require' }, 'darwin'],
    ['Linux CI', { CI: 'true' }, 'linux'],
  ] as const)(
    'a failed start fails the run under %s and removes every container started',
    async (label, env, platform) => {
      let release: () => void = () => undefined
      const slow = new Promise<void>((resolve) => {
        release = resolve
      })
      const setup = outside({
        env,
        platform,
        start: async (server) => {
          if (server.key === 'mysql') {
            release()
            throw new Error('docker run mysql:8.4: pull access denied')
          }
          await slow
          return 'postgres://up'
        },
      })
      await expect(resolveServers(SPECS, setup, 's')).rejects.toThrow(
        `A test database server could not start, and the real-server suites must run here (${label}): docker run mysql:8.4: pull access denied`,
      )
      expect([...setup.removed].sort()).toEqual([
        'strutvane-fw-test-mysql-s',
        'strutvane-fw-test-postgres-s',
      ])
    },
  )

  test('an unknown STRUTVANE_TEST_DOCKER value fails before anything starts', async () => {
    const start = vi.fn(async () => 'x://')
    await expect(
      resolveServers(SPECS, outside({ env: { STRUTVANE_TEST_DOCKER: 'no' }, start }), 's'),
    ).rejects.toThrow(/not a known value/)
    expect(start).not.toHaveBeenCalled()
  })
})

test('redact hides every copy of the password', () => {
  expect(redact('-e PW=s3cr3t … s3cr3t', 's3cr3t')).toBe('-e PW=*** … ***')
  expect(redact('nothing', '')).toBe('nothing')
})
