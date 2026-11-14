import { definePolicy } from '@strutvane/framework'

export default definePolicy('invoice', ({ allow }) => {
  allow('read')
  allow('approve')
})
