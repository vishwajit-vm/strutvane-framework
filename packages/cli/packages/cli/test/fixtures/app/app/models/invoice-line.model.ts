import { defineModel, field } from '@strutvane/framework'

export default defineModel(
  'InvoiceLine',
  {
    invoice: field.belongsTo('Invoice'),
    product: field.belongsTo('Product'),
    quantity: field.integer().min(1),
    unitPrice: field.decimal(12, 2),
  },
  { tenant: true },
)
