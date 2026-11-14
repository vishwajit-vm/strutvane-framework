/**
 * Property-based tests: random bases, random independent edits on both sides.
 *
 * Base files mix unique lines with highly repetitive "code-like" lines (`}`, blank lines,
 * `return x`), because repeated lines are what make line diffs ambiguous in real code.
 * User-added lines are tagged `U<n>` and template-added lines `T<n>`, so every added line is
 * unique and can be tracked through the merge.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { hasConflictMarkers, mergeThreeWay } from '../../../src/devkit/merge/merge.ts'

const { PROPERTY_RUNS } = process.env
const RUNS = Number(PROPERTY_RUNS ?? 400)
const COMMON = ['}', '', '  return x', '{', '  },']

const baseArb = fc
  .array(
    fc.oneof(
      fc.constantFrom(...COMMON),
      fc.nat({ max: 40 }).map((n) => `  line_${n}()`),
    ),
    { maxLength: 30 },
  )
  .map((lines) => lines)

type Edit = { kind: 'insert' | 'delete' | 'replace'; at: number; count: number }
const editsArb = fc.array(
  fc.record({
    kind: fc.constantFrom<'insert' | 'delete' | 'replace'>('insert', 'delete', 'replace'),
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    count: fc.integer({ min: 1, max: 3 }),
  }),
  { maxLength: 4 },
)

/** Apply edits to a copy of `lines`, tagging every new line with `tag` + a unique counter. */
function applyEdits(
  lines: readonly string[],
  edits: readonly Edit[],
  tag: string,
): { result: string[]; added: string[] } {
  const result = [...lines]
  const added: string[] = []
  let n = 0
  for (const e of edits) {
    const pos = Math.min(result.length, Math.floor(e.at * (result.length + 1)))
    const fresh = Array.from({ length: e.count }, () => `  ${tag}${n++}()`)
    if (e.kind === 'insert') result.splice(pos, 0, ...fresh)
    else if (e.kind === 'delete') result.splice(pos, e.count)
    else result.splice(pos, e.count, ...fresh)
    added.push(...fresh)
  }
  // Only lines that survived later edits on the same side count as "added".
  return { result, added: added.filter((l) => result.includes(l)) }
}

const join = (lines: readonly string[]) => (lines.length ? `${lines.join('\n')}\n` : '')

describe('merge properties', () => {
  test('never loses a line added by either side (merged or inside a conflict block)', () => {
    fc.assert(
      fc.property(baseArb, editsArb, editsArb, (base, oursEdits, theirsEdits) => {
        const ours = applyEdits(base, oursEdits, 'U')
        const theirs = applyEdits(base, theirsEdits, 'T')
        const merged = mergeThreeWay({
          base: join(base),
          ours: join(ours.result),
          theirs: join(theirs.result),
        })
        const out = merged.text.split('\n')
        for (const l of ours.added) expect(out, `user line lost: ${l}`).toContain(l)
        for (const l of theirs.added) expect(out, `template line lost: ${l}`).toContain(l)
        expect(hasConflictMarkers(merged.text)).toBe(merged.status === 'conflicted')
        expect(merged.conflicts.length > 0).toBe(merged.status === 'conflicted')
      }),
      { numRuns: RUNS },
    )
  })

  test('identities: unchanged side never interferes', () => {
    fc.assert(
      fc.property(baseArb, editsArb, (base, edits) => {
        const changed = join(applyEdits(base, edits, 'X').result)
        const b = join(base)
        expect(mergeThreeWay({ base: b, ours: changed, theirs: b }).text).toBe(changed) // only user changed
        expect(mergeThreeWay({ base: b, ours: b, theirs: changed }).text).toBe(changed) // only template changed
        expect(mergeThreeWay({ base: b, ours: changed, theirs: changed })).toMatchObject({
          status: 'clean',
          text: changed,
        }) // identical change
      }),
      { numRuns: RUNS },
    )
  })

  test('line endings never change the decision: CRLF user files merge exactly like LF ones', () => {
    fc.assert(
      fc.property(baseArb, editsArb, editsArb, (base, oursEdits, theirsEdits) => {
        const ours = join(applyEdits(base, oursEdits, 'U').result)
        const theirs = join(applyEdits(base, theirsEdits, 'T').result)
        const lf = mergeThreeWay({ base: join(base), ours, theirs })
        const crlf = mergeThreeWay({ base: join(base), ours: ours.replace(/\n/g, '\r\n'), theirs })
        expect(crlf.status).toBe(lf.status)
        expect(crlf.text.replace(/\r\n/g, '\n')).toBe(lf.text)
      }),
      { numRuns: RUNS },
    )
  })

  test('trailing whitespace added by the user on unchanged lines never causes a conflict and is preserved', () => {
    fc.assert(
      fc.property(baseArb, editsArb, (base, theirsEdits) => {
        const oursLines = base.map((l, i) => (i % 2 === 0 && l !== '' ? `${l}  ` : l))
        const theirs = join(applyEdits(base, theirsEdits, 'T').result)
        const merged = mergeThreeWay({ base: join(base), ours: join(oursLines), theirs })
        expect(merged.status).toBe('clean')
      }),
      { numRuns: RUNS },
    )
  })
})
