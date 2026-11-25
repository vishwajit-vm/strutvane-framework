/**
 * Redaction by value, not only by key: a secret inside an error message, a stack, a cause chain,
 * a nested field or the log message itself is hidden by every logger (core's fallback logger and
 * the logging pipeline's sanitiser), whatever text surrounds it.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createLogger, serializeError, toLoggable } from '../../src/core/index.ts'
import { createSanitizer } from '../../src/logging/redact.ts'

// Built at run time so no scanner mistakes the fixtures for real credentials.
const join = (...parts: readonly string[]): string => parts.join('')
const SECRETS = [
  {
    value: join('hunter', '2-db-pass'),
    text: (s: string) => join('postgres://app:', s, '@db:5432/x'),
  },
  {
    value: join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'c2lnbmF0dXJl'),
    text: (s: string) => s,
  },
  {
    value: join('abcdEFGH', '12345678token'),
    text: (s: string) => join('Authorization: Bearer ', s),
  },
  { value: join('sk_', 'live_', 'A1b2C3d4E5f6G7h8'), text: (s: string) => join('stripe key ', s) },
  {
    value: join('4111', '1111', '1111', '1111'),
    text: (s: string) => join('card ', s, ' declined'),
  },
  { value: join('s3cr3t', '-pw-value'), text: (s: string) => join('password=', s) },
  { value: join('reset', 'tok', 'en99'), text: (s: string) => join('/reset?token=', s, '&x=1') },
] as const

/** An error whose message, stack and cause all carry `secret`. */
function leakyError(text: string): Error {
  const cause = new Error(`inner: ${text}`)
  const error = new Error(`outer failed: ${text}`, { cause })
  error.stack = `Error: outer failed: ${text}\n    at connect (db.ts:1:1)`
  ;(error as Error & { code: string }).code = 'E_CONN'
  return error
}

function capture(): { readonly lines: string[]; readonly sink: (line: string) => void } {
  const lines: string[] = []
  return { lines, sink: (line) => void lines.push(line) }
}

describe('value-based redaction (F-L1)', () => {
  test.each(SECRETS.map((secret) => [secret.text(secret.value), secret.value]))(
    'core logger hides %j in the message, err, nested errors and fields',
    (text, secret) => {
      const out = capture()
      const log = createLogger({ sink: out.sink })
      log.error(`request failed: ${text}`, {
        err: leakyError(text),
        details: { nested: [`see ${text}`], failure: leakyError(text) },
      })
      expect(out.lines).toHaveLength(1)
      expect(out.lines[0]).not.toContain(secret)
      expect(out.lines[0]).toContain('[REDACTED')
      // The error's shape survives: name, code, stack frames and the cause chain.
      const record = JSON.parse(out.lines[0] ?? '{}') as {
        err?: { code?: string; cause?: unknown; stack?: string }
      }
      expect(record.err?.code).toBe('E_CONN')
      expect(record.err?.cause).toBeDefined()
      expect(record.err?.stack).toContain('at connect (db.ts:1:1)')
    },
  )

  test('serializeError and toLoggable redact errors on their own', () => {
    for (const { value, text } of SECRETS) {
      expect(JSON.stringify(serializeError(leakyError(text(value))))).not.toContain(value)
      expect(JSON.stringify(toLoggable({ e: leakyError(text(value)) }))).not.toContain(value)
    }
  })

  test('the logging pipeline sanitiser hides the same values', () => {
    const sanitize = createSanitizer()
    for (const { value, text } of SECRETS) {
      const record = {
        msg: `x ${text(value)}`,
        err: leakyError(text(value)),
        fields: { a: [text(value)] },
      }
      expect(JSON.stringify(sanitize(record))).not.toContain(value)
    }
  })

  test('fuzz: whatever surrounds a secret, no logger writes it', () => {
    const noise = fc.string({ maxLength: 40 }).map((s) => s.replace(/[A-Za-z0-9]$/, ''))
    fc.assert(
      fc.property(fc.constantFrom(...SECRETS), noise, noise, (secret, before, after) => {
        // Separate the secret from alphanumeric noise, as real text does (a word boundary).
        const text = `${before} ${secret.text(secret.value)} ${after}`
        const out = capture()
        createLogger({ sink: out.sink }).warn(text, { err: leakyError(text), list: [text] })
        const sanitized = JSON.stringify(createSanitizer()({ msg: text, err: leakyError(text) }))
        return !(out.lines[0] ?? '').includes(secret.value) && !sanitized.includes(secret.value)
      }),
      { numRuns: 300 },
    )
  })
})
