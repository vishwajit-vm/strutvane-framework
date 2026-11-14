/**
 * Regression tests for the sensitive-key lists shared by core's fallback logger and
 * `@strutvane/logs`: every built-in fragment and word is a canary, checked at any depth, in every
 * spelling, and against the false positives the word rules exist to avoid.
 */
import { describe, expect, test } from 'vitest'
import {
  createLogger,
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_SENSITIVE_WORDS,
  normalizeSensitiveKey,
  REDACTED,
  registerSensitiveKeys,
  sensitiveKeyMatcher,
  toLoggable,
} from '../src/index.ts'

const CANARY = 'canary-value-0001'

/** Spellings a real payload might use for one key. */
function spellings(words: readonly string[]): string[] {
  const camel = words.map((w, i) => (i === 0 ? w : w[0]?.toUpperCase() + w.slice(1))).join('')
  return [
    camel,
    words.join('_'),
    words.join('-').toUpperCase(),
    `user${camel[0]?.toUpperCase()}${camel.slice(1)}`,
  ]
}

describe('built-in sensitive keys', () => {
  const required: Array<readonly string[]> = [
    ['salt'],
    ['otp'],
    ['totp', 'secret'],
    ['mfa', 'code'],
    ['recovery', 'codes'],
    ['backup', 'code'],
    ['pin'],
    ['ssn'],
    ['iban'],
    ['cvv'],
    ['cvc'],
    ['card', 'number'],
    ['access', 'key'],
    ['signing', 'key'],
    ['encryption', 'key'],
    ['jwt'],
    ['bearer'],
    ['session'],
    ['passphrase'],
    ['signature'],
    ['sig'],
    ['sid'],
    ['app', 'key'],
    ['pwd'],
    ['password'],
    ['api', 'key'],
    ['session', 'id'],
  ]

  test.each(required.map((w) => [w.join(' '), w]))(
    '%s is redacted in every spelling, at any depth',
    (_name, words) => {
      const m = sensitiveKeyMatcher()
      for (const key of spellings(words)) {
        expect(m(key), key).toBe(true)
        const nested = toLoggable({ a: { b: [{ [key]: CANARY }] }, [key]: 4111 })
        expect(JSON.stringify(nested), key).not.toContain(CANARY)
        expect((nested as Record<string, unknown>)[key], key).toBe(REDACTED)
      }
    },
  )

  test('numbers and objects under a sensitive key are redacted whole', () => {
    const out = toLoggable({ pin: 1234, mfa: { secret: 'x', digits: 6 }, ssn: 123456789 })
    expect(out).toEqual({ pin: REDACTED, mfa: REDACTED, ssn: REDACTED })
  })

  test('short words do not match inside unrelated words', () => {
    const m = sensitiveKeyMatcher()
    for (const key of [
      'shipping',
      'shippingAddress',
      'inside',
      'consider',
      'className',
      'design',
      'signal',
      'footprint',
      'company',
      'spinner',
      'amount',
      'user',
    ])
      expect(m(key), key).toBe(false)
  })

  test('the word list is short and every word is a single lowercase word', () => {
    for (const w of DEFAULT_SENSITIVE_WORDS) expect(w).toMatch(/^[a-z0-9]+$/)
    for (const f of DEFAULT_SENSITIVE_KEYS) expect(normalizeSensitiveKey(f)).toBe(f)
  })

  test('custom words and disabling the registry are honoured', () => {
    const m = sensitiveKeyMatcher([], { words: ['tan'], registered: false })
    expect(m('tan')).toBe(true)
    expect(m('bankTan')).toBe(true)
    expect(m('tangent')).toBe(false)
    expect(m('password')).toBe(false)
    expect(m('---')).toBe(false)
  })
})

describe('registerSensitiveKeys', () => {
  test('existing loggers and matchers hide newly registered keys', () => {
    const lines: string[] = []
    const log = createLogger({ sink: (l) => void lines.push(l) })
    const m = sensitiveKeyMatcher()
    log.info('before', { taxNumber: CANARY })
    expect(m('taxNumber')).toBe(false)
    expect(lines[0]).toContain(CANARY)

    registerSensitiveKeys(['taxNumber'])
    log.info('after', { taxNumber: CANARY, customer: { tax_number: CANARY, TAXNUMBER: CANARY } })
    expect(lines[1]).not.toContain(CANARY)
    expect(m('customerTaxNumber')).toBe(true)
    expect(m('syntaxNumber')).toBe(false)
    expect(m('tax')).toBe(false)
  })

  test('registering the same keys again is a no-op', () => {
    registerSensitiveKeys(['dateOfBirth'])
    registerSensitiveKeys(['dateOfBirth', 'date_of_birth'])
    expect(sensitiveKeyMatcher()('date-of-birth')).toBe(true)
  })

  test('the registry can be ignored per matcher', () => {
    registerSensitiveKeys(['nationalIdent'])
    expect(
      sensitiveKeyMatcher(DEFAULT_SENSITIVE_KEYS, { registered: false })('nationalIdent'),
    ).toBe(false)
    expect(sensitiveKeyMatcher()('nationalIdent')).toBe(true)
  })

  test('symbol-only keys match by their exact form', () => {
    registerSensitiveKeys(['$$'])
    const m = sensitiveKeyMatcher()
    expect(m('$$')).toBe(true)
    expect(m('$')).toBe(false)
  })

  test('invalid keys are rejected', () => {
    for (const bad of ['', '   ', 'x'.repeat(201), 42 as unknown as string])
      expect(() => registerSensitiveKeys([bad])).toThrow(TypeError)
  })

  test('the registry is bounded', () => {
    const many = Array.from({ length: 6_000 }, (_, i) => `bulkKey${i}`)
    expect(() => registerSensitiveKeys(many)).toThrow(RangeError)
  })
})
