// Aliased import + `satisfies`: both must still be recognised statically.
import { field, type ModelDefinition, defineModel as model } from '@strutvane/framework'

export default model('Product', {
  sku: field.string().unique(),
  name: field.string().searchable(),
  active: field.boolean().default(true),
}) satisfies ModelDefinition
