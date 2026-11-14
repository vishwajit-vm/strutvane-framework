import { defineModel, field } from '@strutvane/framework'

export default defineModel(
  'Invoice',
  {
    number: field.string().unique().searchable(),
    customer: field.belongsTo('Customer').filterable(),
    amount: field.decimal(12, 2).min(0).sortable(),
    status: field.enum(['draft', 'sent', 'paid']).default('draft').filterable(),
    dueDate: field.date().sortable(),
    lines: field.hasMany('InvoiceLine'),
  },
  { timestamps: true, softDeletes: true, tenant: true, audit: true },
)
