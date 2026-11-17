import { migration } from '../../../../../../src/entries/schema.ts'

export default migration({
  up(schema) {
    schema.create('posts', (t) => {
      t.id()
      t.string('title', 200)
      t.slug('slug').from('title')
      t.text('body').nullable()
      t.string('excerpt', 500).nullable()
      t.decimal('price', 12, 2).default(0)
      t.enum('status', ['draft', 'published']).default('draft')
      t.foreignId('author_id').constrained('users').cascadeOnDelete()
      t.boolean('featured').default(false)
      t.date('published_on').nullable()
      t.json('meta').nullable()
      t.timestamps()
      t.softDeletes()
    })
  },
  down(schema) {
    schema.dropIfExists('posts')
  },
})
