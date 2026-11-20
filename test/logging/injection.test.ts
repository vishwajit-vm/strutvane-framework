/**
 * Attack-style tests for the logging surface (ADR-0022, docs/13 §14), each for the whole class:
 * - **log injection:** a value that carries a newline, a carriage return, an ANSI escape, a C1
 *   control, a line separator or a bidirectional override can never forge a second record, colour
 *   a terminal or reorder what a reader sees: one record is always one line, in both formats, in
 *   core's fallback logger, and in `log:tail` output;
 * - **secrets** in messages and context never reach a line (keys at any depth, patterns in text),
 *   whichever logger wrote it, and the error page hides at least what the logs hide;
 * - **path traversal** in `LOG_PATH`, a channel's `path` or `Log.build` can't move logs (or
 *   `log:clear`) outside the project.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vitest'
import { createLogger } from '../../src/core/logger/logger.ts'
import { redactString } from '../../src/core/logger/redact-patterns.ts'
import { toLoggable } from '../../src/core/logger/serialize.ts'
import { redactText } from '../../src/exceptions/error-report.ts'
import { formatTailEntry } from '../../src/logging/commands/tail.ts'
import {
  LoggingConfigError,
  logDirectory,
  resolveChannelConfig,
  resolveLoggingConfig,
} from '../../src/logging/config.ts'
import { createFormatter } from '../../src/logging/format/formatter.ts'
import { parseLogLine } from '../../src/logging/format/parse.ts'
import { createLogManager } from '../../src/logging/manager.ts'
import {
  checkLiteralTarget,
  HttpClientError,
  parseAllowList,
} from '../../src/security/http-client.ts'
import { tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const ch = (code: number): string => String.fromCharCode(code)
/** Every character class that could break a line or a terminal display. */
const HOSTILE: readonly string[] = [
  '\n',
  '\r',
  '\r\n',
  ch(0x0b),
  ch(0x0c),
  ch(0x00),
  ch(0x1b), // ESC: starts ANSI sequences
  ch(0x7f),
  ch(0x85), // NEL
  ch(0x9b), // CSI (8-bit)
  ch(0x2028),
  ch(0x2029),
  ch(0x061c), // Arabic letter mark
  ch(0x200e),
  ch(0x200f),
  ch(0x202a),
  ch(0x202b),
  ch(0x202c),
  ch(0x202d),
  ch(0x202e), // RIGHT-TO-LEFT OVERRIDE (Trojan Source)
  ch(0x2066),
  ch(0x2067),
  ch(0x2068),
  ch(0x2069),
]
const RAW = new RegExp(
  `[${['\\n', '\\r', '\\u000b', '\\u000c', '\\u0000', '\\u001b', '\\u007f-\\u009f', '\\u061c', '\\u200e', '\\u200f', '\\u2028', '\\u2029', '\\u202a-\\u202e', '\\u2066-\\u2069'].join('')}]`,
)

/** A line as written (without its final newline) must hold none of the hostile characters raw. */
function assertOneSafeLine(text: string): void {
  expect(text.endsWith('\n')).toBe(true)
  const body = text.slice(0, -1)
  expect(RAW.test(body), JSON.stringify(body)).toBe(false)
}

const T = '2026-11-15T10:22:01.123Z'

describe('log injection: one record is one line', () => {
  test.each(['line', 'json'] as const)(
    '%s: every hostile character, in the message and in fields, is escaped and round-trips',
    (format) => {
      const write = createFormatter(format, { env: 'local' })
      for (const bad of HOSTILE) {
        const msg = `user${bad}[2026-11-15 10:22:01.123] local.ERROR: forged {"admin":true}`
        const record = { time: T, level: 'info', msg, fields: { name: `a${bad}b`, [`k${bad}`]: 1 } }
        const text = write(record, 32_768)
        assertOneSafeLine(text)
        const parsed = parseLogLine(text.slice(0, -1))
        expect(parsed?.msg).toBe(msg)
        expect((parsed?.['fields'] ?? parsed) as Record<string, unknown>).toMatchObject({
          name: `a${bad}b`,
        })
      }
    },
  )

  test.each(['line', 'json'] as const)('%s: property test over arbitrary unicode', (format) => {
    const write = createFormatter(format)
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (msg) => {
        const text = write({ time: T, level: 'error', msg, fields: { v: msg } }, 32_768)
        assertOneSafeLine(text)
        expect(parseLogLine(text.slice(0, -1))?.msg).toBe(msg)
      }),
      { numRuns: 300 },
    )
  })

  test('through the manager, files hold one line per record', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    const log = createLogManager({ env: { LOG_PATH: t.dir, LOG_CHANNEL: 'single' }, root: t.dir })
    for (const bad of HOSTILE) log.info(`a${bad}b`, { v: `c${bad}d` })
    await log.close()
    const text = readFileSync(join(t.dir, 'strutvane.log'), 'utf8')
    const lines = text.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(HOSTILE.length)
    for (const l of lines) assertOneSafeLine(`${l}\n`)
  })

  test("core's fallback logger escapes the same characters", () => {
    const lines: string[] = []
    const log = createLogger({ sink: (l) => void lines.push(l) })
    for (const bad of HOSTILE) log.info(`a${bad}b`, { v: `c${bad}d` })
    expect(lines).toHaveLength(HOSTILE.length)
    for (const l of lines) assertOneSafeLine(`${l}\n`)
  })

  test('log:tail output re-escapes a hostile record read back from a file', () => {
    for (const bad of HOSTILE) {
      const out = formatTailEntry({
        dir: '/x',
        file: 'strutvane.log',
        record: { time: T, level: 'info', msg: `a${bad}b`, env: `e${bad}` },
      })
      assertOneSafeLine(`${out}\n`)
    }
  })
})

describe('secrets never reach a line', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl' // trufflehog:ignore
  const cases: readonly string[] = [
    `token ${JWT}`,
    'Authorization: Bearer abcdefghijklmnop0123',
    'connect postgres://app:hunter2@db:5432/x failed', // trufflehog:ignore
    'redis://:hunter2@cache:6379', // trufflehog:ignore
    'GET /reset?token=hunter2hunter2',
    'host=db password=hunter2 user=app',
    'card 4111 1111 1111 1111',
    'key sk_live_hunter2hunter2abcd',
  ]

  test('in messages and in context values, in the pipeline', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    const log = createLogManager({ env: { LOG_PATH: t.dir, LOG_CHANNEL: 'single' }, root: t.dir })
    for (const text of cases) log.error(text, { detail: text, nested: { deeper: [text] } })
    log.info('keys', { password: 'hunter2', apiKey: 'hunter2', user: { pin: '1234', ssn: 'x' } })
    await log.close()
    const written = readFileSync(join(t.dir, 'strutvane.log'), 'utf8')
    expect(written).not.toMatch(/hunter2|4111 1111/)
    expect(written).toContain('"pin":"[REDACTED]"')
    expect(written).toContain('[REDACTED')
  })

  test("in core's fallback logger: keys and, now, patterns in messages and values", () => {
    const lines: string[] = []
    const log = createLogger({ sink: (l) => void lines.push(l) })
    for (const text of cases) log.error(text, { detail: text })
    log.info('keys', { password: 'hunter2', nested: { token: 'hunter2' } })
    expect(lines.join('\n')).not.toMatch(/hunter2|4111 1111/)
    const note = 'postgres://a:hunter2@db' // trufflehog:ignore
    expect(toLoggable({ note })).toEqual({ note: 'postgres://a:[REDACTED]@db' })
  })

  test('the error page hides at least what the logs hide', () => {
    for (const text of cases) {
      expect(redactText(text)).not.toMatch(/hunter2|4111 1111/)
    }
    // Its own rules are unchanged (the debug page tests pin their output).
    expect(redactText(`a ${JWT} b`)).toBe('a [REDACTED] b')
    expect(redactString('nothing secret here')).toBe('nothing secret here')
  })
})

describe('path traversal in log directories', () => {
  const ROOT = resolve('/srv/app')

  test('logDirectory: relative paths stay inside the project; roots and NUL are refused', () => {
    expect(logDirectory('storage/logs', ROOT)).toEqual({ dir: join(ROOT, 'storage', 'logs') })
    expect(logDirectory('./storage/../storage/logs', ROOT)).toEqual({
      dir: join(ROOT, 'storage', 'logs'),
    })
    expect(logDirectory('..storage', ROOT)).toEqual({ dir: join(ROOT, '..storage') })
    for (const bad of ['..', '../x', '../../etc', 'storage/../../x', 'a/b/../../../c'])
      expect(logDirectory(bad, ROOT).problem, bad).toMatch(/climbs out/)
    expect(logDirectory(resolve('/'), ROOT).problem).toMatch(/filesystem root/)
    expect(logDirectory(`storage${ch(0)}x`, ROOT).problem).toMatch(/NUL/)
    // An absolute folder elsewhere is the operator's choice.
    const elsewhere = resolve('/var/log/app')
    expect(logDirectory(elsewhere, ROOT)).toEqual({ dir: elsewhere })
  })

  test.runIf(process.platform === 'win32')(
    'Windows: drive roots, other drives and UNC paths',
    () => {
      const root = 'C:\\srv\\app'
      expect(logDirectory('storage\\logs', root)).toEqual({ dir: 'C:\\srv\\app\\storage\\logs' })
      expect(logDirectory('..\\..\\Windows', root).problem).toMatch(/climbs out/)
      expect(logDirectory('C:\\', root).problem).toMatch(/filesystem root/)
      expect(logDirectory('D:\\logs', root)).toEqual({ dir: 'D:\\logs' })
      expect(logDirectory('\\\\server\\share\\logs', root)).toEqual({
        dir: '\\\\server\\share\\logs',
      })
    },
  )

  test('LOG_PATH that climbs out only warns, and the default folder is used', () => {
    const { config, issues } = resolveLoggingConfig(
      {},
      { env: { LOG_PATH: '../../etc' }, root: ROOT },
    )
    expect(config.path).toBe(join(ROOT, 'storage', 'logs'))
    expect(issues).toEqual([
      {
        key: 'LOG_PATH',
        message: expect.stringMatching(/climbs out of the project root.*; using storage\/logs$/),
      },
    ])
    expect(
      resolveLoggingConfig({}, { env: { LOGS_PATH: '../x' }, root: ROOT }).issues.map((i) => i.key),
    ).toContain('LOGS_PATH')
  })

  test('a channel path or the default path in config/logging that climbs out is a config error', () => {
    for (const input of [
      { channels: { x: { driver: 'daily' as const, path: '../../etc' } } },
      { path: '../outside' },
    ]) {
      expect(() => resolveLoggingConfig(input, { env: {}, root: ROOT })).toThrow(/climbs out/)
    }
    expect(() =>
      resolveChannelConfig(
        { driver: 'single', path: '../../etc' },
        { path: ROOT, env: 'production', level: 'info', format: 'line' },
        { root: ROOT },
      ),
    ).toThrow(LoggingConfigError)
    // A base name can never carry a path either.
    expect(() =>
      resolveLoggingConfig(
        { channels: { x: { driver: 'single', name: '../../evil' } } },
        { env: {}, root: ROOT },
      ),
    ).toThrow(/can't be a file name/)
  })
})

describe('the SSRF guard keeps the stricter rule of the logs client', () => {
  test('the 6to4 relay anycast range is refused', () => {
    const error = (() => {
      try {
        checkLiteralTarget(new URL('https://192.88.99.1/hook'), parseAllowList([]))
        return undefined
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(HttpClientError)
    expect((error as HttpClientError).code).toBe('ssrf_blocked')
  })
})
