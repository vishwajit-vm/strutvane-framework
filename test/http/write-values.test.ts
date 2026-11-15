/**
 * Every value the create/update schemas accept must also be storable: a value validation lets
 * through but the value canonicaliser or the database then refuses is a 500 for what is really a
 * client error. These tests pin the boundary cases (64-bit integers, datetimes whose UTC instant
 * leaves the four-digit year range, U+0000 inside JSON) on real engines, plus a property test over
 * the canonicaliser.
 */
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeValue } from '../../src/data/values.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { valueSchema } from '../../src/model/schemas.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { DIALECTS } from '../helpers/engines.ts'

const BASE = '/api/v1'

const Sample = defineModel('Sample', {
  big: field.bigInteger().optional(),
  at: field.datetime().optional().filterable(),
  day: field.date().optional().filterable(),
  data: field.json().optional(),
})

interface Problem {
  status: number
  issues?: { path: (string | number)[]; code: string }[]
}

const INVALID: readonly (readonly [string, unknown])[] = [
  ['big', '9223372036854775808'],
  ['big', '-9223372036854775809'],
  ['big', '9999999999999999999'],
  ['at', '9999-12-31T23:30:00-01:00'],
  ['at', '0001-01-01T00:30:00+01:00'],
  ['at', '0000-06-01T00:00:00Z'],
  ['day', '0000-01-01'],
  ['data', { note: 'a\u0000b' }],
  ['data', ['ok', { 'k\u0000': 1 }]],
]

describe.each(DIALECTS)('values the schemas accept are storable on %s', (dialect) => {
  let t: TestApp | undefined
  afterEach(async () => {
    await t?.close()
    t = undefined
  })

  it('out-of-range values are a 422 on the field, never a server error', async () => {
    t = await createTestApp({ dialect, resources: [Sample] })
    const created = await t.request<{ id: string }>('POST', `${BASE}/samples`, { body: {} })
    expect(created.status).toBe(201)
    for (const [key, value] of INVALID) {
      for (const [method, path] of [
        ['POST', `${BASE}/samples`],
        ['PATCH', `${BASE}/samples/${created.body.id}`],
      ] as const) {
        const res = await t.request<Problem>(method, path, { body: { [key]: value } })
        expect(res.status, `${method} ${key}=${JSON.stringify(value)}`).toBe(422)
        expect(res.body.issues).toEqual([expect.objectContaining({ path: [key] })])
      }
    }
    // The same values as filter operands are a client error too, not a database error.
    for (const query of [
      'filter[at][gt]=0000-06-01T00:00:00Z',
      'filter[day][eq]=0000-01-01',
      'filter[at][lt]=9999-12-31T23:30:00-01:00',
    ]) {
      const res = await t.request<Problem>('GET', `${BASE}/samples?${query}`)
      expect(res.status, query).toBe(422)
    }
  })

  it('the boundary values themselves are stored and read back unchanged', async () => {
    t = await createTestApp({ dialect, resources: [Sample] })
    for (const body of [
      { big: '9223372036854775807' },
      { big: '-9223372036854775808' },
      { at: '9999-12-31T23:59:59.999Z' },
      { at: '1000-01-01T00:00:00.000Z' },
      { day: '0001-01-01' },
      { day: '9999-12-31' },
      { data: { note: 'a\\u0000b', list: [1, 'x', null] } },
    ]) {
      const res = await t.request<Record<string, unknown>>('POST', `${BASE}/samples`, { body })
      expect(res.status, JSON.stringify(body)).toBe(201)
      expect(res.body).toMatchObject(body)
    }
  })
})

describe('schema and canonicaliser agree', () => {
  it('whatever a bigInteger or datetime schema accepts, encodeValue accepts', () => {
    for (const def of [field.bigInteger().def, field.datetime().def]) {
      const schema = valueSchema(def)
      const candidates =
        def.kind === 'bigInteger'
          ? fc.oneof(
              fc.bigInt({ min: -(10n ** 19n), max: 10n ** 19n }).map(String),
              fc.stringMatching(/^-?[1-9]\d{18}$/),
            )
          : fc
              .tuple(
                fc.integer({ min: 0, max: 9999 }),
                fc.integer({ min: 1, max: 12 }),
                fc.integer({ min: 1, max: 28 }),
                fc.integer({ min: 0, max: 23 }),
                fc.constantFrom('Z', '+14:00', '-12:00', '+01:00', '-01:00'),
              )
              .map(
                ([y, mo, d, h, z]) =>
                  `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:30:00${z}`,
              )
      fc.assert(
        fc.property(candidates, (value) => {
          if (!schema.safeParse(value).success) return
          expect(() => encodeValue(def, value, 'postgres')).not.toThrow()
        }),
        { numRuns: 2000 },
      )
    }
  })
})
