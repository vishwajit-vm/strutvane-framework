import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { names, pluralize, quote, words } from '../src/make/names.ts'
import { parseEnv } from '../src/project/env-file.ts'
import { compareVersions, parseRange, parseVersion, satisfies } from '../src/project/semver.ts'
import { CLI_VERSION, readPackageVersion } from '../src/version.ts'

describe('names', () => {
  test('every spelling from any input style', () => {
    for (const input of ['InvoiceLine', 'invoice-line', 'invoice_line', 'invoiceLine']) {
      expect(names(input)).toEqual({
        pascal: 'InvoiceLine',
        camel: 'invoiceLine',
        kebab: 'invoice-line',
        snake: 'invoice_line',
        kebabPlural: 'invoice-lines',
        snakePlural: 'invoice_lines',
        label: 'Invoice line',
        labelPlural: 'Invoice lines',
      })
    }
    expect(names('HTTPRequest').kebab).toBe('http-request')
  })

  test('invalid names are validation errors (exit 3)', () => {
    for (const bad of ['', '1abc', 'a b', '../x', 'a/b', 'é']) {
      expect(() => names(bad, 'Model name')).toThrow(
        expect.objectContaining({ code: 'INVALID_NAME', exitCode: 3 }),
      )
    }
  })

  test('pluralize', () => {
    expect(
      ['category', 'box', 'class', 'church', 'invoice', 'day', 'person', 'news', 'datum'].map(
        pluralize,
      ),
    ).toEqual([
      'categories',
      'boxes',
      'classes',
      'churches',
      'invoices',
      'days',
      'people',
      'news',
      'data',
    ])
    expect(words('someXMLThing_v2')).toEqual(['some', 'xml', 'thing', 'v2'])
  })

  test('quote produces a TS literal that evaluates back to the input (any string)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (s) => {
        const literal = quote(s)
        expect(literal.startsWith("'")).toBe(true)
        for (const code of [10, 13, 0x2028, 0x2029]) {
          expect(literal.includes(String.fromCharCode(code))).toBe(false)
        }
        // Evaluate the generated literal as JavaScript (test only).
        expect(new Function(`return ${literal}`)()).toBe(s)
      }),
      { numRuns: 300 },
    )
  })
})

describe('semver (strutvane.compat)', () => {
  test('parse and compare, including prereleases', () => {
    expect(parseVersion('v1.2.3-next.4+build')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['next', 4],
    })
    expect(parseVersion('1.2')).toBeUndefined()
    const order = [
      '0.1.0-0',
      '0.1.0-alpha',
      '0.1.0-alpha.1',
      '0.1.0-next.0',
      '0.1.0-next.10',
      '0.1.0',
      '0.2.0',
      '1.0.0',
    ]
    const parse = (v: string) => {
      const parsed = parseVersion(v)
      if (parsed === undefined) throw new Error(`invalid test version ${v}`)
      return parsed
    }
    for (let i = 1; i < order.length; i++) {
      const [a = '', b = ''] = [order[i - 1], order[i]]
      expect(compareVersions(parse(a), parse(b)), `${a} < ${b}`).toBeLessThan(0)
    }
    expect(compareVersions(parse('1.0.0-a.1'), parse('1.0.0-a'))).toBeGreaterThan(0)
  })

  test.each([
    ['0.1.0', '^0.1.0', true],
    ['0.1.5', '^0.1.0', true],
    ['0.2.0', '^0.1.0', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.9.9', '^1.2.0', true],
    ['2.0.0', '^1.2.0', false],
    ['2.0.0-next.0', '^1.2.0', false],
    ['1.2.9', '~1.2.0', true],
    ['1.3.0', '~1.2.0', false],
    ['0.1.0-next.3', '^0.1.0-next.0', true],
    ['0.1.0-next.0', '^0.1.0', false],
    ['0.1.0', '^0.1.0-next.0', true],
    ['0.1.0-next.0', '0.1.0-next.0', true],
    ['5.0.0', '*', true],
    ['5.0.0-rc.1', '*', false],
    ['1.5.0', '>=1.0.0 <2.0.0', true],
    ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['1.0.0', '>1.0.0', false],
    ['1.0.0', '<=1.0.0', true],
    ['3.1.0', '^1.0.0 || ^3.0.0', true],
    ['1.0.0', 'not-a-range', false],
    ['not-a-version', '*', false],
  ])('%s satisfies %s → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  test('includePrerelease (used for strutvane.compat)', () => {
    expect(satisfies('0.1.0-next.0', '*', { includePrerelease: true })).toBe(true)
    expect(satisfies('0.1.0-next.0', '>=0.1.0-0', { includePrerelease: true })).toBe(true)
    expect(satisfies('0.1.0-next.0', '^0.1.0', { includePrerelease: true })).toBe(false)
  })

  test('invalid ranges parse to undefined (fail closed)', () => {
    expect(parseRange('^x.y')).toBeUndefined()
    expect(parseRange('')).toEqual([
      [{ op: '>=', version: { major: 0, minor: 0, patch: 0, prerelease: [] } }],
    ])
  })
})

describe('env file parser', () => {
  test('dotenv dialect', () => {
    const env = parseEnv(
      [
        '\uFEFF# comment',
        '',
        'APP_NAME=Demo App',
        'export DB_URL = "postgres://u:p@h/db"',
        "QUOTED='single # not a comment'",
        'DOUBLE="line\\nbreak \\"q\\" \\t\\\\"',
        'INLINE=value # trailing comment',
        'EMPTY=',
        'APP_NAME=Again',
        'not a line',
        'UNTERMINATED="abc',
      ].join('\r\n'),
    )
    const value = (k: string): string | undefined => env.entries.get(k)?.value
    expect(value('APP_NAME')).toBe('Again')
    expect(value('DB_URL')).toBe('postgres://u:p@h/db')
    expect(value('QUOTED')).toBe('single # not a comment')
    expect(value('DOUBLE')).toBe('line\nbreak "q" \t\\')
    expect(value('INLINE')).toBe('value')
    expect(value('EMPTY')).toBe('')
    expect(value('UNTERMINATED')).toBe('abc')
    expect(env.entries.get('DB_URL')?.line).toBe(4)
    expect(env.duplicates).toEqual(['APP_NAME'])
    expect(env.invalid).toEqual([{ line: 10, text: 'not a line' }])
  })

  test('fuzz: never throws, and every entry has a line inside the file', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const env = parseEnv(text)
        const lines = text.split(/\r?\n/).length
        for (const e of env.entries.values()) expect(e.line).toBeLessThanOrEqual(lines)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('version', () => {
  test('reads the package version, falling back to 0.0.0', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(readPackageVersion(new URL('file:///definitely/missing/package.json'))).toBe('0.0.0')
    expect(readPackageVersion(new URL('../../../tsconfig.json', import.meta.url))).toBe('0.0.0')
  })
})
