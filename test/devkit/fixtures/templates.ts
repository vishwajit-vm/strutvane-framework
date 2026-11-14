/**
 * Realistic template outputs, as Strutvane would generate them on `sv eject`.
 * v1.0.0 is the merge base; v1.1.0 is a plausible next template release.
 */

export const CONTROLLER_V1 = `// @strutvane-template framework/controller@1.0.0 (ejected: this file is yours to edit)
import { defineController } from '@strutvane/framework/http'
import { z } from 'zod'
import Invoice from '../models/invoice.model.ts'

export const InvoiceInput = z.object({
  number: z.string().min(1),
  amount: z.number().min(0),
  status: z.enum(['draft', 'sent', 'paid']),
})

export default defineController(Invoice, {
  async list(ctx) {
    const page = await ctx.query.paginate(ctx.request.listQuery)
    return ctx.json(page)
  },

  async show(ctx) {
    const record = await ctx.query.findOrFail(ctx.params.id)
    return ctx.json(record)
  },

  async create(ctx) {
    const input = await ctx.validate(InvoiceInput)
    const record = await ctx.query.create(input)
    return ctx.json(record, 201)
  },

  async update(ctx) {
    const input = await ctx.validate(InvoiceInput.partial())
    const record = await ctx.query.update(ctx.params.id, input)
    return ctx.json(record)
  },

  async remove(ctx) {
    await ctx.query.delete(ctx.params.id)
    return ctx.noContent()
  },
})
`

/** v1.1.0: optimistic locking on update, and a new `restore` action after `remove`. */
export const CONTROLLER_V2 = `// @strutvane-template framework/controller@1.1.0 (ejected: this file is yours to edit)
import { defineController } from '@strutvane/framework/http'
import { z } from 'zod'
import Invoice from '../models/invoice.model.ts'

export const InvoiceInput = z.object({
  number: z.string().min(1),
  amount: z.number().min(0),
  status: z.enum(['draft', 'sent', 'paid']),
})

export default defineController(Invoice, {
  async list(ctx) {
    const page = await ctx.query.paginate(ctx.request.listQuery)
    return ctx.json(page)
  },

  async show(ctx) {
    const record = await ctx.query.findOrFail(ctx.params.id)
    return ctx.json(record)
  },

  async create(ctx) {
    const input = await ctx.validate(InvoiceInput)
    const record = await ctx.query.create(input)
    return ctx.json(record, 201)
  },

  async update(ctx) {
    const input = await ctx.validate(InvoiceInput.partial())
    const record = await ctx.query.update(ctx.params.id, input, { expectedVersion: ctx.request.ifMatch })
    return ctx.json(record)
  },

  async remove(ctx) {
    await ctx.query.delete(ctx.params.id)
    return ctx.noContent()
  },

  async restore(ctx) {
    const record = await ctx.query.restore(ctx.params.id)
    return ctx.json(record)
  },
})
`

/** v1.1.0 variant that drops the deprecated `remove` action (for delete-vs-modify cases). */
export const CONTROLLER_V2_NO_REMOVE: string = CONTROLLER_V1.replace('@1.0.0', '@1.1.0').replace(
  `
  async remove(ctx) {
    await ctx.query.delete(ctx.params.id)
    return ctx.noContent()
  },
`,
  '\n',
)

export const FORM_V1 = `// @strutvane-template ui/form-page@1.0.0 (ejected: this file is yours to edit)
import { ResourceForm, useResource } from '@strutvane/ui/react'

export default function InvoiceFormPage() {
  const resource = useResource('Invoice')
  return (
    <ResourceForm
      resource={resource}
      fields={['number', 'customer', 'amount', 'status', 'dueDate']}
      submitLabel="Save invoice"
      onSuccess={(record) => resource.navigate.show(record.id)}
    />
  )
}
`

/** v1.1.0: draft autosave and a cancel button. */
export const FORM_V2 = `// @strutvane-template ui/form-page@1.1.0 (ejected: this file is yours to edit)
import { ResourceForm, useResource } from '@strutvane/ui/react'

export default function InvoiceFormPage() {
  const resource = useResource('Invoice')
  return (
    <ResourceForm
      resource={resource}
      fields={['number', 'customer', 'amount', 'status', 'dueDate']}
      submitLabel="Save invoice"
      cancelLabel="Cancel"
      onSuccess={(record) => resource.navigate.show(record.id)}
      autosaveDraft
    />
  )
}
`

// ---- small, explicit edit helpers (so every case states exactly what the user did) ----------

/** Replace exactly one occurrence of `find` (throws if absent or ambiguous, to keep cases honest). */
export function replaceOnce(text: string, find: string, replacement: string): string {
  const first = text.indexOf(find)
  if (first < 0) throw new Error(`fixture edit: "${find.slice(0, 40)}" not found`)
  if (text.indexOf(find, first + 1) >= 0)
    throw new Error(`fixture edit: "${find.slice(0, 40)}" is ambiguous`)
  return text.slice(0, first) + replacement + text.slice(first + find.length)
}

/** Insert `lines` after the (unique) line containing `anchor`. */
export function insertAfterLine(text: string, anchor: string, lines: string): string {
  const lineStart = text.indexOf(anchor)
  if (lineStart < 0) throw new Error(`fixture edit: anchor "${anchor}" not found`)
  const lineEnd = text.indexOf('\n', lineStart)
  return `${text.slice(0, lineEnd + 1)}${lines}\n${text.slice(lineEnd + 1)}`
}
