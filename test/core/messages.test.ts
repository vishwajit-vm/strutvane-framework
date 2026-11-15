import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  baseLanguage,
  canonicalLocale,
  createMessages,
  defineMessages,
  formatMessage,
  localeChain,
  negotiateLocale,
} from '../../src/core/index.ts'

describe('formatMessage', () => {
  test('substitutes params and formats numbers for the locale', () => {
    expect(formatMessage('Hi {name}, total {amount}', { name: 'Ann', amount: 1250.5 }).text).toBe(
      'Hi Ann, total 1,250.5',
    )
    expect(formatMessage('{n}', { n: 1250.5 }, 'de').text).toBe('1.250,5')
    expect(formatMessage('{ok}', { ok: true }).text).toBe('true')
  })

  test('leaves missing params visible and reports them', () => {
    expect(formatMessage('Hello {name}!')).toEqual({
      text: 'Hello {name}!',
      missing: ['name'],
      malformed: false,
    })
  })

  test('plurals: exact matches, locale categories, other, and # formatting', () => {
    const t = '{count, plural, =0 {no items} one {# item} other {# items}}'
    expect(formatMessage(t, { count: 0 }).text).toBe('no items')
    expect(formatMessage(t, { count: 1 }).text).toBe('1 item')
    expect(formatMessage(t, { count: 1234 }).text).toBe('1,234 items')
    expect(formatMessage(t, { count: '3' }).text).toBe('3 items')
  })

  test('plural branches may contain placeholders and nested plurals', () => {
    const t =
      '{n, plural, one {{who} has # file} other {{who} has # files in {d, plural, one {# day} other {# days}}}}'
    expect(formatMessage(t, { n: 2, who: 'Ann', d: 1 }).text).toBe('Ann has 2 files in 1 day')
  })

  test('uses the locale plural rules (e.g. Russian few/many)', () => {
    const t = '{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}'
    expect(formatMessage(t, { n: 3 }, 'ru').text).toBe('3 файла')
    expect(formatMessage(t, { n: 5 }, 'ru').text).toBe('5 файлов')
  })

  test('a missing plural count is reported and falls back to "other"', () => {
    const r = formatMessage('{n, plural, one {one} other {many}}')
    expect(r.text).toBe('many')
    expect(r.missing).toEqual(['n'])
  })

  test('malformed syntax renders literally and is reported, never throws', () => {
    for (const t of [
      '{',
      'a { b',
      '{bad name}',
      '{n, select, a {x}}',
      '{n, plural, one {x}}',
      '{n, plural, one {x} other',
      '}{',
    ]) {
      const r = formatMessage(t, { n: 1 })
      expect(typeof r.text).toBe('string')
    }
    expect(formatMessage('{n, plural, one {x}}', { n: 1 }).malformed).toBe(true)
    expect(formatMessage('}{').text).toBe('}{')
  })

  test('# outside a plural is literal text, and bad locales fall back to English', () => {
    expect(formatMessage('Item #{n}', { n: 5 }).text).toBe('Item #5')
    expect(formatMessage('{n}', { n: 1000 }, 'not a locale!!').text).toBe('1,000')
    expect(formatMessage('{n, plural, one {#} other {#s}}', { n: 2 }, 'not a locale!!').text).toBe(
      '2s',
    )
  })

  test('oversized templates are returned unchanged instead of parsed', () => {
    const huge = '{'.repeat(20_000)
    expect(formatMessage(huge).malformed).toBe(true)
  })

  test('PROPERTY: never throws and always returns a string, for any template and params', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(
            '{',
            '}',
            ',',
            '#',
            '=',
            'a',
            'n',
            ' ',
            'plural',
            'one',
            'other',
            '0',
          ),
        }),
        fc.dictionary(
          fc.constantFrom('a', 'n'),
          fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean()),
        ),
        (template, params) => {
          const r = formatMessage(template, params)
          return typeof r.text === 'string' && Array.isArray(r.missing)
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe('locales', () => {
  test('canonicalLocale, baseLanguage, localeChain', () => {
    expect(canonicalLocale('en-us')).toBe('en-US')
    expect(canonicalLocale('!!')).toBeUndefined()
    expect(baseLanguage('pt-BR')).toBe('pt')
    expect(localeChain('pt-br')).toEqual(['pt-BR', 'pt', 'en'])
    expect(localeChain('en')).toEqual(['en'])
    expect(localeChain('!!', 'fr')).toEqual(['fr'])
  })

  test('negotiateLocale picks by q-value, exact then base language', () => {
    const supported = ['en', 'fr', 'pt-BR']
    expect(negotiateLocale('fr-CH, fr;q=0.9, en;q=0.8', supported)).toBe('fr')
    expect(negotiateLocale('de;q=1, pt-BR;q=0.5', supported)).toBe('pt-BR')
    expect(negotiateLocale('pt-PT', supported)).toBe('pt-BR')
    expect(negotiateLocale('en;q=0.2, fr;q=0.9', supported)).toBe('fr')
    expect(negotiateLocale('fr;q=0, en;q=0.1', supported)).toBe('en')
    expect(negotiateLocale('*', supported, 'en')).toBe('en')
    expect(negotiateLocale('xx-invalid-!!, de', supported)).toBe('en')
    expect(negotiateLocale(undefined, supported)).toBe('en')
    expect(negotiateLocale('fr', [])).toBe('en')
  })

  test('negotiateLocale survives hostile headers', () => {
    expect(negotiateLocale('fr;q=abc,'.repeat(10_000), ['fr'])).toBe('fr')
    expect(negotiateLocale(',,,;;;q=,', ['fr'])).toBe('en')
  })
})

describe('catalogs and the override chain', () => {
  test('defineMessages canonicalises the locale, freezes, and validates', () => {
    const c = defineMessages('en-us', { a: 'A' })
    expect(c.locale).toBe('en-US')
    expect(Object.isFrozen(c.messages)).toBe(true)
    expect(() => defineMessages('!!', {})).toThrow(RangeError)
    expect(() => defineMessages('en', { a: 1 as unknown as string })).toThrow(TypeError)
  })

  test('precedence: field > resource > app > package > builtin', () => {
    const messages = createMessages({
      package: [defineMessages('en', { k: 'package', p: 'package-only' })],
      app: [defineMessages('en', { k: 'app' })],
    })
    expect(messages.resolve('k')).toBe('app')
    expect(messages.resolve('p')).toBe('package-only')
    expect(messages.resolve('k', { overrides: { resource: { en: { k: 'resource' } } } })).toBe(
      'resource',
    )
    expect(
      messages.resolve('k', {
        overrides: { resource: { en: { k: 'resource' } }, field: { '*': { k: 'field' } } },
      }),
    ).toBe('field')
    expect(messages.resolve('validation.required')).toBe('{attribute} is required.')
    expect(messages.resolve('nope')).toBeUndefined()
  })

  test('locale first: a Portuguese app message beats an English field override', () => {
    const messages = createMessages({ app: [defineMessages('pt', { k: 'pt-app' })] })
    expect(
      messages.resolve('k', { locale: 'pt-BR', overrides: { field: { en: { k: 'en-field' } } } }),
    ).toBe('pt-app')
    expect(
      messages.resolve('k', { locale: 'de', overrides: { field: { en: { k: 'en-field' } } } }),
    ).toBe('en-field')
  })

  test('format renders params in the locale and shows the key when missing', () => {
    const messages = createMessages({ app: [defineMessages('de', { total: 'Summe: {n}' })] })
    expect(messages.format('total', { n: 1234.5 }, { locale: 'de' })).toBe('Summe: 1.234,5')
    expect(messages.format('missing.key')).toBe('missing.key')
    expect(messages.has('total', { locale: 'de' })).toBe(true)
  })

  test('builtin can be disabled; later catalogs for a locale merge over earlier ones', () => {
    const messages = createMessages({
      builtin: false,
      app: [defineMessages('en', { a: '1', b: '1' }), defineMessages('en', { b: '2' })],
    })
    expect(messages.resolve('validation.required')).toBeUndefined()
    expect(messages.resolve('a')).toBe('1')
    expect(messages.resolve('b')).toBe('2')
  })

  test('locales() and missingKeys() power `sv lang:check`', () => {
    const messages = createMessages({
      builtin: false,
      fallbackLocale: 'en',
      app: [
        defineMessages('en', { a: 'A', b: 'B', c: 'C' }),
        defineMessages('hi', { a: 'ए' }),
        defineMessages('hi-IN', { b: 'बी' }),
      ],
    })
    expect(messages.locales()).toEqual(['en', 'hi', 'hi-IN'])
    expect(messages.missingKeys('hi')).toEqual(['b', 'c'])
    expect(messages.missingKeys('hi-IN')).toEqual(['c'])
    expect(messages.missingKeys('en')).toEqual([])
    expect(messages.missingKeys('en-GB')).toEqual([])
  })
})

describe('inherited object members are never messages or params', () => {
  const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']

  test('a key named like an Object.prototype member is missing, not a function', () => {
    const messages = createMessages({ app: [defineMessages('en', { greet: 'Hi' })] })
    const overrides = { field: { en: { other: 'x' } }, resource: { '*': { other: 'y' } } }
    for (const key of inherited) {
      expect(messages.resolve(key), key).toBeUndefined()
      expect(messages.has(key, { overrides }), key).toBe(false)
      expect(messages.format(key, {}, { overrides }), key).toBe(key)
    }
  })

  test('a placeholder named like an Object.prototype member renders as missing', () => {
    for (const name of inherited.filter((n) => n !== '__proto__')) {
      const result = formatMessage(`a {${name}} b`)
      expect(result.text, name).toBe(`a {${name}} b`)
      expect(result.missing, name).toEqual([name])
      const plural = formatMessage(`{${name}, plural, one {one} other {many}}`)
      expect(plural.missing, name).toEqual([name])
    }
    expect(formatMessage('{toString}', { toString: 'own' }).text).toBe('own')
  })
})
