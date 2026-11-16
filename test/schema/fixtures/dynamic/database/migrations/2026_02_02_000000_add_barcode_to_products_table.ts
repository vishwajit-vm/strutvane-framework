import { migration } from '../../../../../../src/entries/schema.ts'

export default migration({
  up(schema) {
    // Defensive, Laravel-style: only add the column if an older hotfix didn't already.
    if (!schema.hasColumn('products', 'barcode')) {
      schema.table('products', (t) => {
        t.string('barcode', 13).nullable()
      })
    }
  },
  down(schema) {
    schema.table('products', (t) => {
      t.dropColumn('barcode')
    })
  },
})
