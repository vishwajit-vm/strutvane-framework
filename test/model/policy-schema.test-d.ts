/**
 * Type-level tests: `policySchema(Model)` keeps every column and its exact policy type, so policy
 * rules over a model type-check (auth's `row.stage.eq('won')`, `row.amount.lte(100)`), and a
 * misspelt or json column does not exist.
 */
import { describe, expectTypeOf, it } from 'vitest'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { type PolicySchema, policySchema } from '../../src/model/policy-schema.ts'

const Deal = defineModel(
  'Deal',
  {
    title: field.string().searchable(),
    stage: field.enum(['lead', 'won']).default('lead').filterable(),
    amount: field.decimal(12, 2).min(0).sortable(),
    probability: field.integer().optional(),
    ownerId: field.uuid().optional().readOnly(),
    company: field.belongsTo('Company'),
    won: field.boolean().default(false),
    meta: field.json(),
    closeDate: field.date().optional(),
    notes: field.hasMany('Note'),
  },
  { tenant: true },
)

describe('policySchema types', () => {
  it('maps each field to its policy column type, with id, tenantId and timestamps', () => {
    const s = policySchema(Deal)
    expectTypeOf(s.columns.id.type).toEqualTypeOf<'uuid'>()
    expectTypeOf(s.columns.tenantId.type).toEqualTypeOf<'uuid'>()
    expectTypeOf(s.columns.createdAt.type).toEqualTypeOf<'text'>()
    expectTypeOf(s.columns.title.type).toEqualTypeOf<'text'>()
    expectTypeOf(s.columns.stage.type).toEqualTypeOf<'text'>()
    expectTypeOf(s.columns.amount.type).toEqualTypeOf<'float8'>()
    expectTypeOf(s.columns.probability.type).toEqualTypeOf<'int4'>()
    expectTypeOf(s.columns.ownerId.type).toEqualTypeOf<'uuid'>()
    expectTypeOf(s.columns.company.type).toEqualTypeOf<'uuid'>()
    expectTypeOf(s.columns.won.type).toEqualTypeOf<'bool'>()
    expectTypeOf(s.columns.closeDate.type).toEqualTypeOf<'text'>()
    // Still a plain PolicySchema for code that only needs the general shape.
    expectTypeOf(s).toExtend<PolicySchema>()
  })

  it('has no json columns, relations or misspelt fields', () => {
    const s = policySchema(Deal)
    // @ts-expect-error json fields are not comparable in policies
    void s.columns.meta
    // @ts-expect-error hasMany relations are not columns
    void s.columns.notes
    // @ts-expect-error a typo is a compile error, not a runtime surprise
    void s.columns.amout
  })

  it('a model without tenancy has no tenantId; timestamps: false drops them', () => {
    const Plain = defineModel('Plain', { a: field.string() }, { timestamps: false })
    const s = policySchema(Plain)
    expectTypeOf(s.columns.a.type).toEqualTypeOf<'text'>()
    // @ts-expect-error not a tenant model
    void s.columns.tenantId
    // @ts-expect-error timestamps are off
    void s.columns.createdAt
  })
})
