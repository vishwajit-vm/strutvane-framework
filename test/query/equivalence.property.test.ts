/**
 * The SQL compiler and the in-memory evaluator must agree on every filter (ADR-0008), on both
 * engines. fast-check generates filter trees over every comparable kind, NULLs, wildcard and
 * case-tricky text, and actor references; each is run as SQL and in memory and compared.
 */
import type { Actor, QueryFilter } from '@strutvane/contracts'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DataRecord, Repository } from '../../src/data/repository.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { bindFilter } from '../../src/query/bind.ts'
import { evaluateFilter } from '../../src/query/evaluate.ts'
import { queryFields } from '../../src/query/fields.ts'
import { DIALECTS } from '../helpers/engines.ts'
import { type Fixture, setupDatabase } from '../helpers/setup.ts'

const Sample = defineModel('Sample', {
  name: field.string(40).optional().filterable(),
  qty: field.integer().optional().filterable(),
  price: field.decimal(8, 2).optional().filterable(),
  big: field.bigInteger().optional().filterable(),
  flag: field.boolean().optional().filterable(),
  kind: field.enum(['a', 'b', 'c']).optional().filterable(),
  day: field.date().optional().filterable(),
  at: field.datetime().optional().filterable(),
  ratio: field.float().optional().filterable(),
})

const TEXT = [
  '',
  'a',
  'A',
  'ab',
  'AB',
  'Ab%',
  'a_b',
  'a%b',
  '50%',
  'é',
  'É',
  'café',
  'CAFÉ',
  'x y',
  "o'brien",
  'abc',
]
const QTY = [-3, -1, 0, 1, 2, 3, 10]
const PRICE = ['-1.50', '0', '0.10', '1', '1.5', '2.25', '100']
const BIG = ['-9007199254740993', '0', '1', '9007199254740993']
const DAY = ['2024-01-01', '2024-02-29', '2025-12-31']
const AT = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z', '2026-06-30T12:00:00+02:00']
const RATIO = [-0.5, 0, 0.25, 1.5]

const maybe = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null> =>
  fc.option(arb, { nil: null, freq: 4 })

const rowArb = fc.record({
  name: maybe(fc.constantFrom(...TEXT)),
  qty: maybe(fc.constantFrom(...QTY)),
  price: maybe(fc.constantFrom(...PRICE)),
  big: maybe(fc.constantFrom(...BIG)),
  flag: maybe(fc.boolean()),
  kind: maybe(fc.constantFrom('a', 'b', 'c')),
  day: maybe(fc.constantFrom(...DAY)),
  at: maybe(fc.constantFrom(...AT)),
  ratio: maybe(fc.constantFrom(...RATIO)),
})

const actorRef = (name: string) => ({ $actor: `attrs.${name}` as const })

/** Values per field, sometimes as an actor reference. */
const valueFor: Record<string, fc.Arbitrary<unknown>> = {
  name: fc.oneof(fc.constantFrom(...TEXT.filter((t) => t !== '')), fc.constant(actorRef('name'))),
  qty: fc.oneof(fc.constantFrom(...QTY), fc.constant(actorRef('qty'))),
  price: fc.constantFrom(...PRICE, '1.50', '1.505'),
  big: fc.constantFrom(...BIG),
  flag: fc.oneof(fc.boolean(), fc.constant(actorRef('flag'))),
  kind: fc.constantFrom('a', 'b', 'c', 'z'),
  day: fc.constantFrom(...DAY),
  at: fc.constantFrom(...AT),
  ratio: fc.constantFrom(...RATIO),
}
const ORDERED = ['qty', 'price', 'big', 'day', 'at', 'ratio']
const EQUATABLE = ['name', 'qty', 'price', 'big', 'flag', 'kind', 'day']
const LISTABLE = ['name', 'qty', 'big', 'kind']
const ALL = Object.keys(valueFor)

const leafArb: fc.Arbitrary<QueryFilter> = fc.oneof(
  fc.constantFrom(...EQUATABLE).chain((f) =>
    fc.record({
      op: fc.constantFrom('eq' as const, 'ne' as const),
      field: fc.constant(f),
      value: valueFor[f] as fc.Arbitrary<never>,
    }),
  ),
  fc.constantFrom(...ORDERED).chain((f) =>
    fc.record({
      op: fc.constantFrom('gt' as const, 'gte' as const, 'lt' as const, 'lte' as const),
      field: fc.constant(f),
      value: valueFor[f] as fc.Arbitrary<never>,
    }),
  ),
  fc.constantFrom(...ORDERED).chain((f) =>
    fc.record({
      op: fc.constant('between' as const),
      field: fc.constant(f),
      from: valueFor[f] as fc.Arbitrary<never>,
      to: valueFor[f] as fc.Arbitrary<never>,
    }),
  ),
  fc.constantFrom(...LISTABLE).chain((f) =>
    fc.record({
      op: fc.constantFrom('in' as const, 'nin' as const),
      field: fc.constant(f),
      values: fc.array(valueFor[f] as fc.Arbitrary<never>, { maxLength: 4 }),
    }),
  ),
  fc.record({
    op: fc.constantFrom('isNull' as const, 'isNotNull' as const),
    field: fc.constantFrom(...ALL),
  }),
  fc.record({
    op: fc.constantFrom('contains' as const, 'startsWith' as const, 'endsWith' as const),
    field: fc.constant('name'),
    value: fc.constantFrom(...TEXT),
    caseSensitive: fc.boolean(),
  }),
  fc.constantFrom({ op: 'true' as const }, { op: 'false' as const }),
)

const filterArb: fc.Arbitrary<QueryFilter> = fc.letrec<{ f: QueryFilter }>((tie) => ({
  f: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leafArb,
    fc.record({
      op: fc.constantFrom('and' as const, 'or' as const),
      filters: fc.array(tie('f'), { maxLength: 3 }),
    }),
    fc.record({ op: fc.constant('not' as const), filter: tie('f') }),
  ),
})).f

const actorArb: fc.Arbitrary<Actor> = fc.record({
  id: fc.constant('u1'),
  type: fc.constant('user' as const),
  roles: fc.constant([]),
  attrs: fc.record({
    name: maybe(fc.constantFrom(...TEXT.filter((t) => t !== ''))),
    qty: maybe(fc.constantFrom(...QTY)),
    flag: maybe(fc.boolean()),
  }),
})

describe.each(DIALECTS)('SQL ↔ memory equivalence on %s', (dialect) => {
  let fx: Fixture
  let repo: Repository
  let records: DataRecord[]
  const fields = queryFields(Sample.definition)

  beforeAll(async () => {
    fx = await setupDatabase(dialect, [Sample.definition])
    repo = fx.repo('Sample')
    const rows = fc.sample(rowArb, { numRuns: 60, seed: 42 })
    records = []
    for (const r of rows) records.push(await repo.create(r))
  })
  afterAll(async () => {
    await fx.db.close()
  })

  it('agrees on every generated filter', async () => {
    await fc.assert(
      fc.asyncProperty(filterArb, actorArb, async (filter, actor) => {
        const bound = bindFilter(filter, { fields, operators: 'any', actor })
        const sql = await repo.list({
          filter: bound,
          page: { kind: 'offset', size: 1000, number: 1 },
        })
        const expected = records
          .filter((r) => evaluateFilter(bound, r))
          .map((r) => r.id)
          .sort()
        expect(sql.data.map((r) => r.id).sort()).toEqual(expected)
      }),
      { numRuns: dialect === 'postgres' ? 250 : 400, seed: 7 },
    )
  })
})
