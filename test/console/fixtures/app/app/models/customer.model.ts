import { defineModel, field } from '@strutvane/framework'

export default defineModel('Customer', {
  name: field.string().required().searchable(),
  email: field.string().unique(),
  region: field.enum(['EU', 'US', 'APAC']).filterable(),
})
