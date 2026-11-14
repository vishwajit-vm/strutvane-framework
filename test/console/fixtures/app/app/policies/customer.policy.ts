import { definePolicy } from '@strutvane/framework'

export default definePolicy('customer', ({ allow }) => {
  allow('read')
})
