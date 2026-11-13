/**
 * Type-level tests: model inference is exact, and misuse fails to compile.
 */
import { describe, expectTypeOf, it } from 'vitest'
import {
  type CreateInput,
  defineModel,
  type InferModel,
  type UpdateInput,
} from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'

const Invoice = defineModel(
  'Invoice',
  {
    number: field.string(32).unique(),
    amount: field.decimal(12, 2),
    status: field.enum(['draft', 'paid']).default('draft'),
    notes: field.text().optional(),
    total: field.integer().readOnly(),
    customer: field.belongsTo('Customer'),
    meta: field.json<{ tags: string[] }>().optional(),
    flag: field.boolean(),
    lines: field.hasMany('Line'),
  },
  { softDeletes: true },
)

const Plain = defineModel('Plain', { name: field.string() }, { timestamps: false })

describe('InferModel', () => {
  it('infers the record type with system fields', () => {
    type R = InferModel<typeof Invoice>
    expectTypeOf<R>().toEqualTypeOf<{
      readonly id: string
      readonly number: string
      readonly amount: string
      readonly status: 'draft' | 'paid'
      readonly notes: string | null
      readonly total: number
      readonly customer: string
      readonly meta: { tags: string[] } | null
      readonly flag: boolean
      readonly createdAt: string
      readonly updatedAt: string
      readonly deletedAt: string | null
    }>()
  })

  it('omits timestamps when disabled and relations always', () => {
    type P = InferModel<typeof Plain>
    expectTypeOf<P>().toEqualTypeOf<{ readonly id: string; readonly name: string }>()
    // @ts-expect-error hasMany relations are not columns
    expectTypeOf<InferModel<typeof Invoice>['lines']>().toBeNever()
  })
})

describe('CreateInput', () => {
  type C = CreateInput<typeof Invoice>
  it('requires required fields without defaults, makes the rest optional, excludes readOnly', () => {
    expectTypeOf<C>().toEqualTypeOf<{
      number: string
      amount: string
      customer: string
      flag: boolean
      status?: 'draft' | 'paid' | null
      notes?: string | null
      meta?: { tags: string[] } | null
    }>()
  })
  it('rejects misuse', () => {
    // @ts-expect-error missing required fields
    const a: C = { number: 'x' }
    // @ts-expect-error wrong enum value
    const b: C = { number: 'x', amount: '1', customer: 'c', flag: true, status: 'void' }
    // @ts-expect-error readOnly fields are not writable
    const c: C = { number: 'x', amount: '1', customer: 'c', flag: true, total: 1 }
    void [a, b, c]
  })
})

describe('UpdateInput', () => {
  type U = UpdateInput<typeof Invoice>
  it('makes every writable field optional and forbids null for required fields', () => {
    expectTypeOf<Record<never, never>>().toExtend<U>()
    expectTypeOf<{ notes: null }>().toExtend<U>()
    // @ts-expect-error required fields cannot be nulled
    const a: U = { number: null }
    // @ts-expect-error unknown fields are rejected
    const b: U = { nope: 1 }
    void [a, b]
  })
})
