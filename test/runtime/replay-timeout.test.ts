/**
 * The migration replay sandbox's timeout is configurable (found by the skeleton's gate run on
 * 2026-11-18: on a heavily loaded machine `migrate:status` stopped at the fixed 10 s). Default
 * unchanged; `--replay-timeout` beats `DB_MIGRATION_REPLAY_TIMEOUT`; both are bounded (1 s to
 * 10 min) and a bad value is refused naming the flag or key, before any process starts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../src/commands.ts'
import { EnvValidationError, ValidationError } from '../../src/core/index.ts'
import {
  assertSandboxTimeout,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  replayInSandbox,
  SANDBOX_TIMEOUT_BOUNDS_MS,
} from '../../src/migrations/sandbox.ts'
import { migrationReplayTimeoutMs } from '../../src/runtime/migrations.ts'

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

describe('migrationReplayTimeoutMs', () => {
  test('defaults to 10 s, unchanged', () => {
    expect(DEFAULT_SANDBOX_TIMEOUT_MS).toBe(10_000)
    expect(migrationReplayTimeoutMs({})).toBe(10_000)
    expect(migrationReplayTimeoutMs({ DB_MIGRATION_REPLAY_TIMEOUT: '  ' })).toBe(10_000)
  })

  test.each([
    ['30s', 30_000],
    ['30000', 30_000],
    ['2min', 120_000],
    ['1500ms', 1_500],
    ['10min', 600_000],
    ['1s', 1_000],
  ])('DB_MIGRATION_REPLAY_TIMEOUT=%s → %d ms', (raw, ms) => {
    expect(migrationReplayTimeoutMs({ DB_MIGRATION_REPLAY_TIMEOUT: raw })).toBe(ms)
  })

  test('the flag wins over .env', () => {
    expect(migrationReplayTimeoutMs({ DB_MIGRATION_REPLAY_TIMEOUT: '20s' }, '45s')).toBe(45_000)
    expect(migrationReplayTimeoutMs({ DB_MIGRATION_REPLAY_TIMEOUT: '20s' }, undefined)).toBe(20_000)
  })

  test.each(['0', '999ms', '11min', '-5s', '5h', 'soon', '1e4', '30 s'])(
    'refuses %s in .env, naming the key',
    (raw) => {
      expect(() => migrationReplayTimeoutMs({ DB_MIGRATION_REPLAY_TIMEOUT: raw })).toThrow(
        EnvValidationError,
      )
      try {
        migrationReplayTimeoutMs({ DB_MIGRATION_REPLAY_TIMEOUT: raw })
      } catch (error) {
        expect(error).toMatchObject({ problems: [{ key: 'DB_MIGRATION_REPLAY_TIMEOUT' }] })
      }
    },
  )

  test.each(['0', 'forever', true])('refuses --replay-timeout=%s, naming the flag', (flag) => {
    expect(() => migrationReplayTimeoutMs({}, flag)).toThrow(ValidationError)
    try {
      migrationReplayTimeoutMs({}, flag)
    } catch (error) {
      expect(error).toMatchObject({ issues: [{ path: ['--replay-timeout'] }] })
    }
  })
})

describe('the sandbox enforces the bounds itself (programmatic callers)', () => {
  test('bounds are 1 s to 10 min', () => {
    expect(SANDBOX_TIMEOUT_BOUNDS_MS).toEqual({ min: 1_000, max: 600_000 })
    expect(() => assertSandboxTimeout(1_000)).not.toThrow()
    expect(() => assertSandboxTimeout(600_000)).not.toThrow()
  })

  test.each([0, 999, 600_001, 1.5e3 + 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'replayInSandbox refuses timeoutMs %s before starting anything',
    async (timeoutMs) => {
      const dir = mkdtempSync(join(tmpdir(), 'sv-replay-timeout-'))
      folders.push(dir)
      await expect(replayInSandbox(dir, { timeoutMs })).rejects.toThrow(RangeError)
    },
  )
})

describe('the commands take --replay-timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'sv-replay-flag-'))
  folders.push(root)
  mkdirSync(join(root, 'database', 'migrations'), { recursive: true })
  writeFileSync(
    join(root, 'database', 'migrations', '2026_01_01_000000_create_notes_table.ts'),
    `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) { schema.create('notes', (t) => { t.id(); t.string('body') }, { global: true }) },
  down(schema) { schema.dropIfExists('notes') },
})
`,
  )

  const context = (flags: CommandContextLike['flags'], env: Record<string, string> = {}) => {
    const lines: string[] = []
    const ctx: CommandContextLike = {
      flags,
      appEnv: 'local',
      services: { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', ...env } },
      requireProject: () => ({ root }),
      out: {
        line: (t = '') => lines.push(t),
        success: (t) => lines.push(`ok ${t}`),
        info: (t) => lines.push(`info ${t}`),
        warn: (t) => lines.push(`warn ${t}`),
        table: (_h, rows) => lines.push(...rows.map((r) => r.join(' | '))),
      },
    }
    return { ctx, lines }
  }
  const command = (name: string) => {
    const found = commands.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(name)
    return found
  }

  test.each(['migrate', 'migrate:status', 'db:seed', 'sync', 'migrate:rollback', 'migrate:fresh'])(
    '%s declares the flag',
    (name) => {
      expect(command(name).flags?.['replay-timeout']).toMatchObject({ type: 'string' })
    },
  )

  test('a valid flag replays with it; an invalid one is refused before replaying', async () => {
    const ok = context({ 'replay-timeout': '60s' })
    await command('sync').run(ok.ctx)
    expect(ok.lines).toContain('ok Updated .strutvane/schema.json')
    await expect(command('sync').run(context({ 'replay-timeout': '0' }).ctx)).rejects.toThrow(
      ValidationError,
    )
    await expect(
      command('migrate:status').run(context({}, { DB_MIGRATION_REPLAY_TIMEOUT: 'nope' }).ctx),
    ).rejects.toThrow(EnvValidationError)
  })
})
