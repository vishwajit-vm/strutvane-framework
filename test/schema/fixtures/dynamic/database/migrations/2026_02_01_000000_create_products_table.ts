import { migration } from '../../../../../../src/entries/schema.ts'
import { addAuditColumns } from '../support/audit.ts'

const SKU_LENGTH = 40
const LOCALES = ['en', 'fr'] as const

export default migration({
  up(schema) {
    schema.create('products', (t) => {
      t.id()
      // A constant instead of a literal.
      t.string('sku', SKU_LENGTH).unique()
      // One column per locale, from a loop.
      for (const locale of LOCALES) t.string(`name_${locale}`)
      // A helper shared by many migrations.
      addAuditColumns(t)
    })
  },
  down(schema) {
    schema.dropIfExists('products')
  },
})
