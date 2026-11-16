import { migration } from '../../../../../../src/entries/schema.ts'

export default migration({
  up(schema) {
    schema.table('posts', (t) => {
      t.string('subtitle').nullable()
      t.renameColumn('body', 'content')
      t.dropColumn('excerpt')
      t.index('status')
    })
  },
  down(schema) {
    // Undo in reverse order, so each step sees the table the way up() left it.
    schema.table('posts', (t) => {
      t.dropIndex('posts_status_index')
      t.string('excerpt', 500).nullable()
      t.renameColumn('content', 'body')
      t.dropColumn('subtitle')
    })
  },
})
