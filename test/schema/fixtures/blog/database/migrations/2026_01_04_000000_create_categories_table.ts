import { migration } from '../../../../../../src/entries/schema.ts'

export default migration({
  up(schema) {
    schema.create('categories', (t) => {
      t.id()
      t.string('name', 100)
      t.slug('slug').from('name')
      t.timestamps()
    })
  },
  down(schema) {
    schema.dropIfExists('categories')
  },
})
