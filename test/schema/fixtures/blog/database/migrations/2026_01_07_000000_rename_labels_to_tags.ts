import { migration } from '../../../../../../src/entries/schema.ts'

export default migration({
  up(schema) {
    schema.rename('labels', 'tags')
  },
  down(schema) {
    schema.rename('tags', 'labels')
  },
})
