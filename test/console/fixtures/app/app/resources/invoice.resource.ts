import { defineResource } from '@strutvane/framework'
import Invoice from '../models/invoice.model.ts'

export default defineResource(Invoice, {
  actions: {
    approve: { permission: 'invoice.approve', label: 'Approve' },
    send: { label: 'Send to customer' },
  },
})
