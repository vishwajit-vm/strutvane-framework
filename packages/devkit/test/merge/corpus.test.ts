/**
 * Golden corpus: realistic ejected files, one scenario per case.
 *
 * Every case asserts:
 *   - the expected status and conflict kinds,
 *   - case-specific must/must-not content,
 *   - the universal invariant: every line that exists only in the user's file survives, and
 *     every line that exists only in the new template survives (merged or inside a conflict),
 *   - the output matches the reviewed golden file in __golden__/ (line endings and BOM made
 *     visible so goldens are stable under Git's LF normalisation).
 */
import { describe, expect, test } from 'vitest'
import {
  type ConflictKind,
  hasConflictMarkers,
  type MergeOptions,
  mergeThreeWay,
  mergeTwoWay,
} from '../../src/merge/merge.ts'
import {
  CONTROLLER_V1,
  CONTROLLER_V2,
  CONTROLLER_V2_NO_REMOVE,
  FORM_V1,
  FORM_V2,
  insertAfterLine,
  replaceOnce,
} from '../fixtures/templates.ts'

interface Case {
  readonly name: string
  readonly what: string
  readonly base: string | null // null = base unavailable → two-way fallback
  readonly ours: string
  readonly theirs: string
  readonly options?: MergeOptions
  readonly status: 'clean' | 'conflicted'
  readonly kinds?: readonly ConflictKind[]
  readonly mustContain?: readonly string[]
  readonly mustNotContain?: readonly string[]
  readonly exact?: string
  readonly eol?: '\n' | '\r\n'
}

const USER_HOOK = `  async beforeCreate(ctx) {\n    ctx.input.number ??= await nextInvoiceNumber(ctx.actor.tenantId)\n  },\n`
const crlf = (s: string) => s.replace(/\n/g, '\r\n')

const cases: Case[] = [
  {
    name: '01-clean-nonoverlapping',
    what: 'User adds a hook before list; template adds optimistic locking + restore elsewhere',
    base: CONTROLLER_V1,
    ours: insertAfterLine(CONTROLLER_V1, 'export default defineController', USER_HOOK),
    theirs: CONTROLLER_V2,
    status: 'clean',
    mustContain: [
      'nextInvoiceNumber',
      'expectedVersion: ctx.request.ifMatch',
      'async restore(ctx)',
      'controller@1.1.0',
    ],
  },
  {
    name: '02-template-only-change',
    what: 'User never edited the file: result is exactly the new template',
    base: CONTROLLER_V1,
    ours: CONTROLLER_V1,
    theirs: CONTROLLER_V2,
    status: 'clean',
    exact: CONTROLLER_V2,
  },
  {
    name: '03-user-only-change',
    what: 'Template unchanged: result is exactly the user file',
    base: CONTROLLER_V1,
    ours: insertAfterLine(CONTROLLER_V1, 'export default defineController', USER_HOOK),
    theirs: CONTROLLER_V1,
    status: 'clean',
    exact: insertAfterLine(CONTROLLER_V1, 'export default defineController', USER_HOOK),
  },
  {
    name: '04-identical-change-both-sides',
    what: 'User had already added the same optimistic-locking line the template now adds',
    base: CONTROLLER_V1,
    ours: replaceOnce(
      CONTROLLER_V1,
      'ctx.query.update(ctx.params.id, input)',
      'ctx.query.update(ctx.params.id, input, { expectedVersion: ctx.request.ifMatch })',
    ),
    theirs: CONTROLLER_V2,
    status: 'clean',
    mustContain: ['async restore(ctx)'],
  },
  {
    name: '05-both-modified-same-line',
    what: 'User and template change the same update line differently',
    base: CONTROLLER_V1,
    ours: replaceOnce(
      CONTROLLER_V1,
      'ctx.query.update(ctx.params.id, input)',
      'ctx.query.update(ctx.params.id, { ...input, updatedBy: ctx.actor.id })',
    ),
    theirs: CONTROLLER_V2,
    status: 'conflicted',
    kinds: ['both-modified'],
    mustContain: [
      'updatedBy: ctx.actor.id',
      'expectedVersion: ctx.request.ifMatch',
      '<<<<<<< yours',
      '>>>>>>> new template',
    ],
  },
  {
    name: '06-deleted-by-you',
    what: 'User deleted the update action; template modified it',
    base: CONTROLLER_V1,
    ours: replaceOnce(
      CONTROLLER_V1,
      `  async update(ctx) {\n    const input = await ctx.validate(InvoiceInput.partial())\n    const record = await ctx.query.update(ctx.params.id, input)\n    return ctx.json(record)\n  },\n\n`,
      '',
    ),
    theirs: CONTROLLER_V2,
    status: 'conflicted',
    kinds: ['deleted-by-you'],
    mustContain: ['expectedVersion: ctx.request.ifMatch'],
  },
  {
    name: '07-deleted-by-template',
    what: 'Template removed the remove action; user had customised it',
    base: CONTROLLER_V1,
    ours: replaceOnce(
      CONTROLLER_V1,
      '    await ctx.query.delete(ctx.params.id)',
      '    await ctx.query.softDelete(ctx.params.id, { reason: ctx.body.reason })',
    ),
    theirs: CONTROLLER_V2_NO_REMOVE,
    status: 'conflicted',
    kinds: ['deleted-by-template'],
    mustContain: ['softDelete(ctx.params.id, { reason: ctx.body.reason })'],
  },
  {
    name: '08-both-added-same-place',
    what: 'User adds an archive action right after remove; template adds restore at the same spot',
    base: CONTROLLER_V1,
    ours: replaceOnce(
      CONTROLLER_V1,
      `    return ctx.noContent()\n  },\n`,
      `    return ctx.noContent()\n  },\n\n  async archive(ctx) {\n    return ctx.json(await ctx.query.update(ctx.params.id, { archived: true }))\n  },\n`,
    ),
    theirs: CONTROLLER_V2,
    status: 'conflicted',
    kinds: ['both-added'],
    mustContain: ['async archive(ctx)', 'async restore(ctx)'],
  },
  {
    name: '09-crlf-user-file',
    what: 'User file has Windows line endings (CRLF); templates are LF',
    base: CONTROLLER_V1,
    ours: crlf(insertAfterLine(CONTROLLER_V1, 'export default defineController', USER_HOOK)),
    theirs: CONTROLLER_V2,
    status: 'clean',
    eol: '\r\n',
    mustContain: ['nextInvoiceNumber', 'async restore(ctx)'],
  },
  {
    name: '10-mixed-line-endings',
    what: 'User file mixes CRLF and LF (e.g. pasted code); output uses the majority style',
    base: CONTROLLER_V1,
    ours: (() => {
      const c = crlf(CONTROLLER_V1)
      return c.replace('  async list(ctx) {\r\n', '  async list(ctx) {\n')
    })(),
    theirs: CONTROLLER_V2,
    status: 'clean',
    eol: '\r\n',
    mustContain: ['async restore(ctx)'],
  },
  {
    name: '11-trailing-whitespace-noise',
    what: 'Editor added trailing spaces to many unchanged lines; template changes elsewhere',
    base: CONTROLLER_V1,
    ours: CONTROLLER_V1.replace(/\(ctx\) \{\n/g, '(ctx) {   \n'),
    theirs: CONTROLLER_V2,
    status: 'clean',
    mustContain: ['  async list(ctx) {   ', 'async restore(ctx)'],
  },
  {
    name: '12-trailing-whitespace-strict-mode',
    what: 'Same as 11 but with ignoreTrailingWhitespace: false and a whitespace edit on a line the template changes',
    base: CONTROLLER_V1,
    ours: replaceOnce(
      CONTROLLER_V1,
      'controller@1.0.0 (ejected: this file is yours to edit)',
      'controller@1.0.0 (ejected: this file is yours to edit)  ',
    ),
    theirs: CONTROLLER_V2,
    options: { ignoreTrailingWhitespace: false },
    status: 'conflicted',
    kinds: ['both-modified'],
  },
  {
    name: '13-form-clean',
    what: 'User adds a custom field to the form; template adds cancelLabel + autosaveDraft',
    base: FORM_V1,
    ours: replaceOnce(FORM_V1, `'status', 'dueDate']`, `'status', 'dueDate', 'notes']`),
    theirs: FORM_V2,
    status: 'clean',
    mustContain: [`'dueDate', 'notes']`, 'cancelLabel="Cancel"', 'autosaveDraft'],
  },
  {
    name: '14-form-clean-separated-edits',
    what: 'User changes the page title hook; template edits are lines away',
    base: FORM_V1,
    ours: replaceOnce(
      FORM_V1,
      `  const resource = useResource('Invoice')`,
      `  const resource = useResource('Invoice', { include: ['customer'] })`,
    ),
    theirs: FORM_V2,
    status: 'clean',
    mustContain: [`include: ['customer']`, 'autosaveDraft', 'cancelLabel="Cancel"'],
  },
  {
    name: '15-no-final-newline',
    what: 'User file has no trailing newline: output keeps that',
    base: CONTROLLER_V1,
    ours: CONTROLLER_V1.replace(/\n$/, ''),
    theirs: CONTROLLER_V2,
    status: 'clean',
  },
  {
    name: '16-byte-order-mark',
    what: 'User file starts with a UTF-8 BOM: output keeps it',
    base: CONTROLLER_V1,
    ours: `﻿${CONTROLLER_V1}`,
    theirs: CONTROLLER_V2,
    status: 'clean',
  },
  {
    name: '17-prototype-like-lines',
    what: 'Lines such as __proto__ / constructor / toString (older diff libraries crashed or mis-diffed on these)',
    base: 'const s = `\n__proto__\nconstructor\ntoString\n`\n',
    ours: 'const s = `\n__proto__\nconstructor\nhasOwnProperty\ntoString\n`\n',
    theirs: 'const s = `\n__proto__\nconstructor\ntoString\nvalueOf\n`\n',
    status: 'clean',
    exact: 'const s = `\n__proto__\nconstructor\nhasOwnProperty\ntoString\nvalueOf\n`\n',
  },
  {
    name: '18-two-way-base-missing',
    what: 'Base lost: every difference becomes a conflict, nothing is applied silently',
    base: null,
    ours: insertAfterLine(CONTROLLER_V1, 'export default defineController', USER_HOOK),
    theirs: CONTROLLER_V2,
    status: 'conflicted',
    mustContain: ['nextInvoiceNumber', 'async restore(ctx)', '(unavailable)'],
  },
  {
    name: '19-reindented-block',
    what: 'User wrapped the form in a <Card> (re-indents every line); template adds props inside: line merges cannot see through re-indentation',
    base: FORM_V1,
    ours: FORM_V1.replace(
      '  return (\n    <ResourceForm',
      '  return (\n    <Card>\n      <ResourceForm',
    )
      .replace(/\n {6}(resource=|fields=|submitLabel=|onSuccess=)/g, '\n        $1')
      .replace('\n    />\n  )', '\n      />\n    </Card>\n  )'),
    theirs: FORM_V2,
    status: 'conflicted',
    mustContain: ['<Card>', 'autosaveDraft'],
  },
  {
    name: '20-nothing-changed',
    what: 'Neither side changed anything',
    base: CONTROLLER_V1,
    ours: CONTROLLER_V1,
    theirs: CONTROLLER_V1,
    status: 'clean',
    exact: CONTROLLER_V1,
  },
]

/** Lines present in `side` but not in `base` (as LF-normalised, BOM-free lines). */
function uniqueLines(side: string, base: string | null): string[] {
  const norm = (t: string) => t.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const baseSet = new Set(base === null ? [] : norm(base).map((l) => l.replace(/[ \t]+$/, '')))
  return norm(side).filter((l) => l.trim() !== '' && !baseSet.has(l.replace(/[ \t]+$/, '')))
}

/** Make CR and BOM visible so golden files survive Git's LF normalisation byte-for-byte. */
function visible(s: string): string {
  return s.replace(/﻿/g, '<BOM>').replace(/\r/g, '<CR>')
}

describe('golden corpus', () => {
  test('has at least 15 cases with unique names', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length)
  })

  for (const c of cases) {
    test(`${c.name}: ${c.what}`, async () => {
      const result =
        c.base === null
          ? mergeTwoWay({ ours: c.ours, theirs: c.theirs }, c.options)
          : mergeThreeWay({ base: c.base, ours: c.ours, theirs: c.theirs }, c.options)

      expect(result.status).toBe(c.status)
      if (c.kinds) expect(result.conflicts.map((x) => x.kind)).toEqual(c.kinds)
      expect(hasConflictMarkers(result.text)).toBe(c.status === 'conflicted')
      for (const s of c.mustContain ?? []) expect(result.text).toContain(s)
      for (const s of c.mustNotContain ?? []) expect(result.text).not.toContain(s)
      if (c.exact !== undefined) expect(result.text).toBe(c.exact)
      if (c.eol) {
        expect(result.eol).toBe(c.eol)
        expect(result.text.replace(/\r\n/g, '')).not.toContain('\n') // every line break uses the user's style
      }

      // Universal invariants: nothing unique to either side is ever lost.
      const outLines = new Set(
        result.text
          .replace(/^﻿/, '')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((l) => l.replace(/[ \t]+$/, '')),
      )
      for (const l of uniqueLines(c.ours, c.base))
        expect(outLines.has(l.replace(/[ \t]+$/, '')), `user line lost: ${l}`).toBe(true)
      for (const l of uniqueLines(c.theirs, c.base))
        expect(outLines.has(l.replace(/[ \t]+$/, '')), `template line lost: ${l}`).toBe(true)

      // Shape preservation.
      expect(result.text.startsWith('﻿')).toBe(c.ours.startsWith('﻿'))
      expect(/\n$/.test(result.text)).toBe(/\n$/.test(c.ours))

      const report = [
        `case: ${c.name}`,
        `what: ${c.what}`,
        `status: ${result.status} (${result.mode})`,
        `conflicts: ${result.conflicts.map((x) => `${x.kind}@line${x.outputLine}`).join(', ') || 'none'}`,
        `notes: ${result.notes.join('; ') || 'none'}`,
        '----- merged output -----',
        visible(result.text),
      ].join('\n')
      await expect(report).toMatchFileSnapshot(`__golden__/${c.name}.txt`)
    })
  }
})
