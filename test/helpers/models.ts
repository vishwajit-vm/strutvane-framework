/** Shared model fixtures. */
import { type AnyModel, defineModel, type ModelDefinition } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'

export const Customer: AnyModel = defineModel(
  'Customer',
  {
    name: field.string(120).searchable().sortable().filterable(),
    email: field.email().unique().filterable('eq', 'contains'),
    invoices: field.hasMany('Invoice'),
  },
  { tenant: true },
)

export const Invoice: AnyModel = defineModel(
  'Invoice',
  {
    number: field.string(32).unique().searchable().sortable().filterable(),
    amount: field.decimal(12, 2).sortable().filterable(),
    status: field.enum(['draft', 'sent', 'paid']).default('draft').filterable().sortable(),
    issuedOn: field.date().optional().sortable().filterable(),
    customer: field.belongsTo('Customer').filterable(),
    notes: field.text().optional(),
  },
  { tenant: true, softDeletes: true },
)

export const models: readonly ModelDefinition[] = [Customer.definition, Invoice.definition]
