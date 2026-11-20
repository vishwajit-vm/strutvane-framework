/**
 * `node strut log:tail`, `log:list` and `log:clear` (ADR-0022 §8), run through the real CLI
 * runner against an in-process app: flags, safe output, the channel filter, confirmation before
 * deleting, and `--follow` stopping on Ctrl+C. The commands read `config/logging.ts` and `.env`
 * without booting the app.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { Prompter } from '../../src/console/framework/prompter.ts'
import { Application } from '../../src/foundation/application.ts'
import { type ConfigFiles, defineConfig } from '../../src/foundation/config.ts'
import { createFormatter } from '../../src/logging/format/formatter.ts'
import { formatLine } from '../../src/logging/format/line.ts'
import {
  appFolder,
  builtinsWith,
  cleanupFolders,
  NOW,
  testConfig,
  testEnv,
} from '../commands/helpers.ts'
import { type CliResult, cli } from '../console/helpers.ts'

afterEach(cleanupFolders)

const ESC = String.fromCharCode(0x1b)
const json = createFormatter('json')
const line = createFormatter('line', { env: 'local' })
const rec = (time: string, level: string, msg: string, fields?: Record<string, unknown>) => ({
  time: `2026-11-15T${time}Z`,
  level,
  msg,
  ...(fields ? { fields } : {}),
})

const loggingConfig: ConfigFiles = {
  ...testConfig,
  logging: defineConfig(() => ({
    channels: {
      payments: { driver: 'daily' as const, name: 'payments' },
    },
  })),
}

interface Run {
  readonly root: string
  readonly logs: string
  run(
    argv: readonly string[],
    options?: { readonly prompter?: Prompter; readonly signal?: AbortSignal },
  ): Promise<CliResult>
}

/** An app folder with storage/logs, and a runner for `node strut` command lines in it. */
function project(env: Readonly<Record<string, string>> = {}): Run {
  const root = appFolder()
  const logs = join(root, 'storage', 'logs')
  mkdirSync(logs, { recursive: true })
  const make = (): Application =>
    Application.configure({ basePath: root, env: { ...testEnv, ...env } })
      .withConfig(loggingConfig)
      .create()
  return {
    root,
    logs,
    run: (argv, options = {}) =>
      cli(argv, {
        cwd: root,
        builtins: builtinsWith(make),
        env: { APP_ENV: 'testing' },
        now: NOW,
        ...(options.prompter === undefined ? {} : { prompter: options.prompter }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
  }
}

/** A prompter that answers every confirmation with `answer` and records the questions. */
function answering(answer: boolean | Error): Prompter & { readonly questions: string[] } {
  const questions: string[] = []
  return {
    interactive: true,
    questions,
    async confirm(message) {
      questions.push(message)
      if (answer instanceof Error) throw answer
      return answer
    },
    async text() {
      throw new Error('not asked')
    },
    async select() {
      throw new Error('not asked')
    },
  }
}

describe('log:tail', () => {
  test('prints safe lines; filters by level, text, channel and time', async () => {
    const p = project()
    writeFileSync(
      join(p.logs, 'strutvane-2026-11-15.log'),
      line(rec('08:00:00.000', 'info', 'early payment ok'), 4096) +
        line(rec('10:00:01.000', 'info', 'hello'), 4096) +
        json(rec('10:00:02.000', 'error', `bad${ESC}[31m payment failed`), 4096),
    )
    writeFileSync(
      join(p.logs, 'payments-2026-11-15.log'),
      line(rec('10:00:03.000', 'warning', 'card declined'), 4096),
    )
    const errors = await p.run(['log:tail', '-n', '5', '--level=warn', '--no-follow'])
    expect(errors.code).toBe(0)
    // ANSI from a record is escaped, never sent to the terminal.
    expect(errors.stdout).toContain('production.ERROR: bad\\u001b[31m payment failed {}')
    expect(errors.stdout).not.toContain(ESC)
    expect(errors.stdout).toContain('local.WARNING: card declined')
    expect(errors.stdout).not.toContain('hello')

    const grep = await p.run(['log:tail', '--grep', 'HELLO', '--channel', 'daily', '--no-follow'])
    expect(grep.stdout).toContain('local.INFO: hello')
    expect(grep.stdout).not.toContain('card declined')

    const payments = await p.run(['log:tail', '--channel=payments', '--no-follow'])
    expect(payments.stdout.trim().split('\n')).toHaveLength(1)

    const since = await p.run([
      'log:tail',
      '--grep=PAYMENT',
      '--since=2026-11-15T09:00:00Z',
      '--no-follow',
    ])
    expect(since.stdout).toContain('payment failed')
    expect(since.stdout).not.toContain('early payment ok')

    const asJson = await p.run(['log:tail', '--level=error', '--json'])
    expect(asJson.code).toBe(0)
    expect(asJson.json().data).toEqual({
      records: [expect.objectContaining({ level: 'error', msg: `bad${ESC}[31m payment failed` })],
    })
  })

  test('bad flags exit with a usage error and a hint', async () => {
    const p = project()
    const level = await p.run(['log:tail', '--level=loud', '--no-follow'])
    expect(level.code).toBe(2)
    expect(level.stderr).toContain('"loud" is not a log level')
    const since = await p.run(['log:tail', '--since=soon', '--no-follow'])
    expect(since.code).toBe(2)
    expect(since.stderr).toContain('--since="soon" is not a duration or a date')
    const lines = await p.run(['log:tail', '-n', 'many', '--no-follow'])
    expect(lines.code).toBe(2)
    expect(lines.stderr).toContain('--lines="many" is not a whole number')
    // --filter is not a flag (the blueprint calls it --grep).
    expect((await p.run(['log:tail', '--filter=x', '--no-follow'])).code).toBe(2)
    const stderr = await p.run(['log:tail', '--channel=stderr', '--no-follow'])
    expect(stderr.code).toBe(2)
    expect(stderr.stderr).toContain(`channel "stderr" writes no files`)
    const unknown = await p.run(['log:tail', '--channel=nope', '--no-follow'])
    expect(unknown.stderr).toContain('channel "nope" is not defined')
  })

  test('follow is the default: it keeps running until Ctrl+C', async () => {
    const p = project()
    const controller = new AbortController()
    let finished = false
    const running = p.run(['log:tail', '-n', '0'], { signal: controller.signal }).then((r) => {
      finished = true
      return r
    })
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(
      join(p.logs, 'strutvane-2026-11-15.log'),
      formatLine(rec('10:00:00.000', 'notice', 'live'), 'production', 4096),
    )
    // The command prints through the CLI's buffered streams: wait for it to see the file, then stop.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(finished).toBe(false)
    controller.abort()
    const result = await running
    expect(result.stdout).toContain('NOTICE: live')
  })

  test('works when the app can not boot (the config is read, nothing is booted)', async () => {
    const p = project({ APP_KEY: 'too-short' })
    writeFileSync(
      join(p.logs, 'strutvane-2026-11-15.log'),
      line(rec('10:00:01.000', 'error', 'boot failed'), 4096),
    )
    const result = await p.run(['log:tail', '--no-follow'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('boot failed')
  })
})

describe('log:list', () => {
  test('lists the files of the file channels', async () => {
    const p = project()
    writeFileSync(join(p.logs, 'strutvane-2026-11-01.log'), 'x\n')
    writeFileSync(join(p.logs, 'payments-2026-11-02.log'), 'xy\n')
    writeFileSync(join(p.logs, 'other.log'), 'not ours\n')
    const all = await p.run(['log:list'])
    expect(all.code).toBe(0)
    expect(all.stdout).toContain('strutvane-2026-11-01.log')
    expect(all.stdout).toContain('payments-2026-11-02.log')
    expect(all.stdout).not.toContain('other.log')
    const payments = await p.run(['log:list', '--channel=payments', '--json'])
    const data = payments.json().data as { files: { name: string }[] }
    expect(data.files.map((f) => f.name)).toEqual(['payments-2026-11-02.log'])
    expect((await p.run(['log:list', '--channel=nope'])).code).toBe(2)
  })
})

describe('log:clear', () => {
  function seeded(): Run & { readonly old: string } {
    const p = project()
    writeFileSync(join(p.logs, 'strutvane-2026-11-01.log'), 'x\n')
    writeFileSync(join(p.logs, 'strutvane-2026-11-02.log'), 'x\n')
    return { ...p, old: join(p.logs, 'strutvane-2026-11-01.log') }
  }

  test('without a terminal and without --force it refuses and deletes nothing', async () => {
    const p = seeded()
    const result = await p.run(['log:clear'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Delete the log files?')
    expect(existsSync(p.old)).toBe(true)
  })

  test('a "no" answer deletes nothing; a "yes" deletes (never the live file)', async () => {
    const p = seeded()
    const no = answering(false)
    const refused = await p.run(['log:clear', '--days=3', '--channel=daily'], { prompter: no })
    expect(refused.code).toBe(1)
    expect(no.questions).toEqual([
      'Delete the "daily" log files older than the last 3 day(s)? Files still being written are kept.',
    ])
    expect(refused.stdout).toContain('Cancelled; nothing was deleted.')
    expect(existsSync(p.old)).toBe(true)
    const yes = await p.run(['log:clear'], { prompter: answering(true) })
    expect(yes.code).toBe(0)
    expect(yes.stdout).toContain(
      'Deleted 1 file(s). Kept 1 file(s) still being written: strutvane-2026-11-02.log.',
    )
    expect(existsSync(p.old)).toBe(false)
  })

  test('--force and --yes skip the question; --days keeps whole days', async () => {
    const p = seeded()
    const result = await p.run(['log:clear', '--days=1', '--force'], {
      prompter: answering(new Error('must not ask')),
    })
    expect(result.code).toBe(0)
    expect(existsSync(p.old)).toBe(false)
    const again = await p.run(['log:clear', '--yes', '--json'])
    expect(again.json().data).toEqual({ deleted: [], live: ['strutvane-2026-11-02.log'] })
    expect((await p.run(['log:clear', '--days=x', '--force'])).code).toBe(2)
  })

  test('an empty or missing log folder is fine', async () => {
    const p = project({ LOG_PATH: 'storage/none' })
    const result = await p.run(['log:clear', '--force'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Deleted 0 file(s).')
  })
})

describe('help', () => {
  test('the three commands are listed with their flags', async () => {
    const p = project()
    const list = await p.run(['list'])
    for (const name of ['log:tail', 'log:list', 'log:clear']) expect(list.stdout).toContain(name)
    const help = await p.run(['help', 'log:tail'])
    expect(help.stdout).toContain('--no-follow')
  })
})
