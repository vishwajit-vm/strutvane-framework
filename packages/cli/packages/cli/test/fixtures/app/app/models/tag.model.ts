import { defineModel, field } from '@strutvane/framework'

export default defineModel('Tag', { label: field.string().unique() })
