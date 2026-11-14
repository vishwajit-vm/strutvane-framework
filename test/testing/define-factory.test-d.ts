/**
 * Type-level tests: factory overrides reach every column (readOnly is an API rule, not a factory
 * rule) with exact value types, and misuse fails to compile.
 */
import { describe, expectTypeOf, it } from 'vitest'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import {
  type DefinedFactory,
  defineFactory,
  type FactoryAttributes,
  type FactoryTarget,
} from '../../src/testing/define-factory.ts'

const Invoice = defineModel(
  'Invoice',
  {
    number: field.string(32).unique(),
    status: field.enum(['draft', 'approved']).default('draft').readOnly(),
    approvedAt: field.datetime().optional().readOnly(),
    total: field.integer().readOnly(),
    token: field.string().hidden(),
    customer: field.belongsTo('Customer'),
    lines: field.hasMany('Line'),
  },
  { softDeletes: true },
)

declare const target: FactoryTarget
const factory = defineFactory(Invoice, ({ fake, related, sequence }) => ({
  number: `INV-${sequence}`,
  status: fake.pick(['draft', 'approved']), // a plain string from a generator is fine here
  total: 0, // readOnly columns may be set by a factory
  customer: related('Customer'),
}))

describe('FactoryAttributes', () => {
  it('has every column (readOnly and hidden included), optional and mutable, minus system columns', () => {
    expectTypeOf<FactoryAttributes<typeof Invoice>>().toEqualTypeOf<{
      number?: string
      status?: 'draft' | 'approved'
      approvedAt?: string | null
      total?: number
      token?: string
      customer?: string
    }>()
  })

  it('overrides readOnly fields with their exact types, no casts', () => {
    expectTypeOf(factory).toEqualTypeOf<DefinedFactory<typeof Invoice>>()
    void factory.create(target, {
      status: 'approved',
      approvedAt: '2026-11-14T00:00:00Z',
      total: 5,
    })
    void factory.createMany(target, 2, { status: 'draft' })
    factory.attributes({ total: 1, approvedAt: null })
  })

  it('rejects wrong value types, unknown keys and system columns', () => {
    // @ts-expect-error not one of the enum values
    void factory.create(target, { status: 'paid' })
    // @ts-expect-error total is an integer column
    void factory.create(target, { total: '5' })
    // @ts-expect-error approvedAt is nullable but not a number
    factory.attributes({ approvedAt: 1 })
    // @ts-expect-error unknown column
    void factory.create(target, { nope: 1 })
    // @ts-expect-error id is owned by the repository
    void factory.create(target, { id: 'x' })
    // @ts-expect-error timestamps are owned by the repository
    factory.attributes({ createdAt: 'x' })
    // @ts-expect-error relations to many are not columns
    factory.attributes({ lines: [] })
  })
})
