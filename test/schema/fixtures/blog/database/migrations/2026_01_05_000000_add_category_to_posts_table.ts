import { migration } from '../../../../../../src/entries/schema.ts'

export default migration({
  up(schema) {
    schema.table('posts', (t) => {
      // No table name: Laravel-style, `category_id` points to `categories`.
      t.foreignId('category_id').nullable().constrained().nullOnDelete()
    })
  },
  down(schema) {
    schema.table('posts', (t) => {
      t.dropConstrainedForeignId('category_id')
    })
  },
})
