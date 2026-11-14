import { describe, expect, it } from 'vitest'
import type { Actor } from '../../src/contracts/index.ts'
import {
  canonicalBigInt,
  canonicalDate,
  canonicalDatetime,
  canonicalDecimal,
  canonicalUuid,
  decodeValue,
  encodeValue,
  filterValue,
  ValueError,
} from '../../src/data/values.ts'
import { frag, ident, join, render } from '../../src/database/sql.ts'
import { assertTenantId } from '../../src/database/types.ts'
import { field } from '../../src/model/field.ts'
import { actorValue, andAll, bindFilter, type FilterError } from '../../src/query/bind.ts'
import { compileFilter } from '../../src/query/compile.ts'
import { compareCodePoints, evaluateFilter, MissingFieldError } from '../../src/query/evaluate.ts'
import { queryFields } from '../../src/query/fields.ts'
import { decodeCursor, encodeCursor, resolveSort, SortError } from '../../src/query/sort.ts'
import { Invoice } from '../helpers/models.ts'

const fields = queryFields(Invoice.definition)
const actor: Actor = {
  id: 'u1',
  type: 'user',
  tenantId: 't1',
  roles: [],
  attrs: { region: 'eu', none: null },
}

describe('canonical values', () => {
  it('decimals', () => {
    expect(canonicalDecimal('10.5', 2)).toBe('10.50')
    expect(canonicalDecimal('007.100', 2)).toBe('7.10')
    expect(canonicalDecimal('-0', 2)).toBe('0.00')
    expect(canonicalDecimal('1.555', 2)).toBe('1.555')
    expect(canonicalDecimal('1.5000', 2)).toBe('1.50')
    expect(canonicalDecimal(2.25, 2)).toBe('2.25')
    expect(canonicalDecimal(0.0000001, 2)).toBe('0.0000001')
    expect(canonicalDecimal('5', 0)).toBe('5')
    expect(() => canonicalDecimal('1e5', 2)).toThrow(ValueError)
    expect(() => canonicalDecimal(Number.NaN, 2)).toThrow(ValueError)
  })
  it('big integers', () => {
    expect(canonicalBigInt('007')).toBe('7')
    expect(canonicalBigInt(42)).toBe('42')
    expect(canonicalBigInt(10n)).toBe('10')
    expect(() => canonicalBigInt('9223372036854775808')).toThrow(/64-bit/)
    expect(() => canonicalBigInt(2 ** 60)).toThrow(/exact/)
    expect(() => canonicalBigInt('1.5')).toThrow(ValueError)
  })
  it('dates and datetimes', () => {
    expect(canonicalDate('2024-02-29')).toBe('2024-02-29')
    expect(canonicalDate(new Date('2024-02-29T00:00:00Z'))).toBe('2024-02-29')
    expect(() => canonicalDate('2023-02-29')).toThrow(ValueError)
    expect(() => canonicalDate('24-1-1')).toThrow(ValueError)
    expect(() => canonicalDate(new Date('x'))).toThrow(ValueError)
    expect(canonicalDatetime('2026-11-14T13:00:00+01:00')).toBe('2026-11-14T12:00:00.000Z')
    expect(canonicalDatetime('2026-11-14 12:00:00+00')).toBe('2026-11-14T12:00:00.000Z')
    expect(canonicalDatetime(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(() => canonicalDatetime('2026-11-14T12:00:00')).toThrow(/offset/)
    expect(() => canonicalDatetime(new Date('x'))).toThrow(ValueError)
    expect(() => canonicalDatetime(new Date(Date.UTC(10000, 0, 1)))).toThrow(/0000-9999/)
  })
  it('uuids', () => {
    expect(canonicalUuid('0190A000-0000-7000-8000-0000000000AB')).toBe(
      '0190a000-0000-7000-8000-0000000000ab',
    )
    expect(() => canonicalUuid('nope')).toThrow(ValueError)
    expect(() => assertTenantId('nope')).toThrow(TypeError)
  })
  it('filter values per kind', () => {
    const d = (kind: Parameters<typeof filterValue>[0], raw: unknown) =>
      filterValue(kind, { scale: 2 }, raw)
    expect(d('integer', '42')).toBe(42)
    expect(() => d('integer', '4.2')).toThrow(/integer/)
    expect(() => d('integer', '')).toThrow(/number/)
    expect(() => d('float', 'x')).toThrow(/number/)
    expect(d('boolean', 'true')).toBe(true)
    expect(d('boolean', false)).toBe(false)
    expect(() => d('boolean', 'yes')).toThrow()
    expect(() => d('string', 1)).toThrow(/text/)
    expect(() => d('string', 'a\u0000b')).toThrow(/U\+0000/)
    expect(() => d('uuid', 1)).toThrow()
    expect(() => d('bigInteger', true)).toThrow()
    expect(() => d('decimal', true)).toThrow()
    expect(() => d('date', 1)).toThrow()
    expect(() => d('datetime', 1)).toThrow()
    expect(() => d('json', '{}')).toThrow(/cannot be compared/)
  })
  it('encode and decode per dialect', () => {
    const bool = field.boolean().def
    expect(encodeValue(bool, true, 'sqlite')).toBe(1)
    expect(encodeValue(bool, false, 'postgres')).toBe(false)
    expect(encodeValue(field.json().def, { a: 1 }, 'postgres')).toBe('{"a":1}')
    expect(encodeValue(field.string().def, undefined, 'postgres')).toBeNull()
    expect(decodeValue('boolean', {}, 1n)).toBe(true)
    expect(decodeValue('boolean', {}, 't')).toBe(true)
    expect(decodeValue('boolean', {}, 0)).toBe(false)
    expect(decodeValue('bigInteger', {}, 12n)).toBe('12')
    expect(decodeValue('bigInteger', {}, 12)).toBe('12')
    expect(decodeValue('json', {}, { a: 1 })).toEqual({ a: 1 })
    expect(decodeValue('date', {}, new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02')
    expect(decodeValue('date', {}, '2026-01-02T00:00:00')).toBe('2026-01-02')
    expect(decodeValue('text', {}, 5)).toBe('5')
    expect(decodeValue('integer', {}, null)).toBeNull()
  })
})

describe('SQL builder', () => {
  it('quotes identifiers and rejects anything else', () => {
    expect(ident('invoices')).toBe('"invoices"')
    expect(() => ident('a"b')).toThrow(/Invalid SQL identifier/)
    expect(() => ident('1abc')).toThrow()
  })
  it('checks placeholder counts and numbers them for Postgres outside literals', () => {
    expect(() => frag('a = ?', [])).toThrow(/placeholders/)
    const f = join([frag("x = ? AND y = '?'", [1]), frag('z = ?', [2])], ' AND ')
    expect(render(f, 'postgres')).toEqual({ sql: "x = $1 AND y = '?' AND z = $2", params: [1, 2] })
    expect(render(f, 'sqlite').sql).toBe("x = ? AND y = '?' AND z = ?")
  })
})

describe('bindFilter', () => {
  const bind = (f: unknown, operators: 'declared' | 'any' = 'declared', a: Actor | null = actor) =>
    bindFilter(f as never, { fields, operators, actor: a })

  it('rejects unknown fields, relation paths, unsupported operators and bad values', () => {
    const code = (f: unknown, operators: 'declared' | 'any' = 'declared') => {
      try {
        bind(f, operators)
        return 'ok'
      } catch (e) {
        return (e as FilterError).code
      }
    }
    expect(code({ op: 'eq', field: 'nope', value: 1 })).toBe('filter_not_allowed')
    expect(code({ op: 'eq', field: 'customer.name', value: 'x' })).toBe('relation_path_unsupported')
    expect(code({ op: 'eq', field: 'notes', value: 'x' })).toBe('filter_not_allowed')
    expect(code({ op: 'contains', field: 'notes', value: 'x' }, 'any')).toBe('ok')
    expect(code({ op: 'gt', field: 'number', value: 'x' })).toBe('operator_not_allowed')
    expect(code({ op: 'eq', field: 'amount', value: 'ten' })).toBe('invalid_filter_value')
    expect(code({ op: 'eq', field: 'amount', value: null })).toBe('invalid_filter_value')
    expect(code({ op: 'in', field: 'status', values: 'draft' })).toBe('invalid_filter_value')
    expect(code({ op: 'in', field: 'status', values: new Array(101).fill('draft') })).toBe(
      'invalid_filter_value',
    )
    expect(code({ op: 'contains', field: 'number', value: 'x'.repeat(201) })).toBe(
      'invalid_filter_value',
    )
    expect(code({ op: 'and', filters: 'x' })).toBe('invalid_filter')
    expect(code({ op: 'bogus', field: 'number' })).toBe('operator_not_allowed')
    expect(code({ op: 'eq', field: 1, value: 1 })).toBe('invalid_filter')
    expect(code({ op: 'and', filters: new Array(600).fill({ op: 'true' }) })).toBe(
      'filter_too_complex',
    )
  })

  it('resolves actor references with null-safe rules', () => {
    const trusted = (f: unknown, a: Actor | null = actor) => bind(f, 'any', a)
    expect(trusted({ op: 'eq', field: 'number', value: { $actor: 'attrs.none' } })).toEqual({
      op: 'false',
    })
    expect(trusted({ op: 'ne', field: 'number', value: { $actor: 'attrs.none' } })).toEqual({
      op: 'true',
    })
    expect(trusted({ op: 'gt', field: 'amount', value: { $actor: 'attrs.none' } })).toEqual({
      op: 'false',
    })
    expect(
      trusted({ op: 'between', field: 'amount', from: { $actor: 'attrs.none' }, to: '1' }),
    ).toEqual({ op: 'false' })
    expect(
      trusted({
        op: 'in',
        field: 'number',
        values: ['a', { $actor: 'attrs.none' }, { $actor: 'attrs.region' }],
      }),
    ).toMatchObject({
      values: ['a', 'eu'],
    })
    expect(trusted({ op: 'eq', field: 'number', value: { $actor: 'id' } })).toMatchObject({
      value: 'u1',
    })
    expect(trusted({ op: 'eq', field: 'number', value: { $actor: 'id' } }, null)).toEqual({
      op: 'false',
    })
    expect(() =>
      trusted({ op: 'eq', field: 'number', value: { $actor: 'attrs.missing' } }),
    ).toThrow(/not set/)
    expect(actorValue(actor, 'tenantId')).toBe('t1')
    // Client filters may not reference the actor (no probing of server-side attributes).
    expect(() => bind({ op: 'eq', field: 'number', value: { $actor: 'id' } })).toThrow(
      /actor references are not allowed/,
    )
    expect(actorValue({ ...actor, tenantId: undefined } as unknown as Actor, 'tenantId')).toBeNull()
    expect(() => actorValue({ ...actor, attrs: { u: undefined } }, 'attrs.u')).toThrow(/not set/)
  })

  it('throws for invalid actor references', () => {
    expect(() => actorValue(actor, 5)).toThrow(/must be a string/)
    expect(() => actorValue(actor, 'roles')).toThrow(/unknown actor reference/)
  })

  it('treats empty search text as isNotNull and simplifies and()', () => {
    expect(bind({ op: 'contains', field: 'number', value: '' })).toMatchObject({ op: 'isNotNull' })
    expect(andAll([])).toEqual({ op: 'true' })
    expect(andAll([{ op: 'true' }, { op: 'false' }])).toEqual({ op: 'false' })
    expect(
      andAll([{ op: 'true' }, { op: 'isNull', field: { key: 'a', column: 'a', kind: 'string' } }]),
    ).toMatchObject({ op: 'isNull' })
  })

  it('compiles empty groups and lists to constants and evaluates against records', () => {
    const empty = compileFilter({ op: 'and', filters: [] }, { dialect: 'postgres' })
    expect(empty.text).toBe('(1 = 1)')
    expect(compileFilter({ op: 'or', filters: [] }, { dialect: 'sqlite' }).text).toBe('(1 = 0)')
    const nin = bind({ op: 'nin', field: 'status', values: [] }, 'any')
    expect(compileFilter(nin, { dialect: 'sqlite' }).text).toBe('(1 = 1)')
    expect(evaluateFilter(nin, { status: null })).toBe(true)
    expect(() => evaluateFilter(bind({ op: 'isNull', field: 'notes' }, 'any'), {})).toThrow(
      MissingFieldError,
    )
    const range = bind({
      op: 'between',
      field: 'createdAt',
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    })
    expect(evaluateFilter(range, { createdAt: new Date('2026-06-01T00:00:00Z') })).toBe(true)
  })

  it('compares strings by code point', () => {
    expect(compareCodePoints('a', 'b')).toBeLessThan(0)
    expect(compareCodePoints('￿', '\u{1F600}')).toBeLessThan(0) // UTF-16 order would say otherwise
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0)
    expect(compareCodePoints('a', 'a')).toBe(0)
  })
})

describe('sort and cursors', () => {
  it('resolves sorts, appends the id tiebreak and rejects unsortable fields', () => {
    const keys = resolveSort(
      [
        { field: 'amount', direction: 'desc' },
        { field: 'amount', direction: 'asc' },
      ],
      fields,
    )
    expect(keys.map((k) => `${k.field.key}:${k.direction}`)).toEqual(['amount:desc', 'id:asc'])
    expect(resolveSort([{ field: 'id', direction: 'desc' }], fields)).toHaveLength(1)
    expect(() => resolveSort([{ field: 'notes', direction: 'asc' }], fields)).toThrow(SortError)
  })
  it('round-trips cursors including nulls', () => {
    const keys = resolveSort([{ field: 'issuedOn', direction: 'asc' }], fields)
    const id = '0190a000-0000-7000-8000-000000000001'
    expect(decodeCursor(encodeCursor(keys, { issuedOn: null, id }), keys)).toEqual([null, id])
    const nonNull = Buffer.from(
      JSON.stringify({ v: 1, s: 'issuedOn:asc,id:asc', k: ['2026-01-01', null] }),
    ).toString('base64url')
    expect(() => decodeCursor(nonNull, keys)).toThrow(/malformed/)
    const short = Buffer.from(
      JSON.stringify({ v: 1, s: 'issuedOn:asc,id:asc', k: [null] }),
    ).toString('base64url')
    expect(() => decodeCursor(short, keys)).toThrow(/malformed/)
  })
})
