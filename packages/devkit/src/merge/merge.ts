/**
 * Three-way merge for ejected (user-owned) generated files (ADR-0012, proven in spike 06).
 *
 *   base   = what Strutvane generated when the user ejected (template version N)
 *   ours   = the user's file today (possibly edited)
 *   theirs = what the new template version generates (template version N+1)
 *
 * Safety contract, enforced by the golden corpus and property-based tests:
 *   1. Every line that exists only in `ours` appears in the output, either merged or inside a
 *      conflict block. **User edits are never silently dropped.**
 *   2. Changes made by only one side are applied without a conflict.
 *   3. Identical changes on both sides do not conflict.
 *   4. Overlapping different changes produce standard diff3 markers AND a structured
 *      {@link Conflict} entry.
 *   5. The user's line endings, BOM and final newline are preserved, merged three-way.
 *
 * Diffing is line-based (diff3 via node-diff3) on *comparison keys* (see `lineKey`), while the
 * output is always built from original lines, preferring the user's version of any line both
 * sides consider unchanged.
 *
 * @module
 */
import { diff3MergeRegions, diffIndices } from 'node-diff3'
import {
  type Eol,
  fromLines,
  lineKey,
  mergeShapes,
  shapeOf,
  type TextShape,
  toLines,
} from '../text.ts'

/** How a conflict came about. */
export type ConflictKind =
  | 'both-modified' // both sides changed the same lines differently
  | 'both-added' // both sides inserted different lines at the same place
  | 'deleted-by-you' // you deleted lines the template changed
  | 'deleted-by-template' // the template deleted lines you changed

/** A structured description of one conflict, for CLI reports and `--json` output. */
export interface Conflict {
  readonly kind: ConflictKind
  /** 1-based line of the `<<<<<<<` marker in the merged output. */
  readonly outputLine: number
  /** The user's lines in the conflicting region. */
  readonly ours: readonly string[]
  /** The original template lines, or `null` when the base was unavailable (two-way mode). */
  readonly base: readonly string[] | null
  /** The new template's lines in the conflicting region. */
  readonly theirs: readonly string[]
}

/** Labels written next to the conflict markers. */
export interface MergeLabels {
  readonly ours: string
  readonly base: string
  readonly theirs: string
}

/** Merge options. */
export interface MergeOptions {
  /** Treat lines differing only in trailing spaces/tabs as unchanged. Default `true`. */
  readonly ignoreTrailingWhitespace?: boolean
  /** Marker labels. Defaults: `yours`, `original template`, `new template`. */
  readonly labels?: Partial<MergeLabels>
}

/** The outcome of a merge. */
export interface MergeResult {
  readonly status: 'clean' | 'conflicted'
  /** `three-way` normally; `two-way` when the base was unavailable (see {@link mergeTwoWay}). */
  readonly mode: 'three-way' | 'two-way'
  /** The merged file, in the user's line-ending style. */
  readonly text: string
  readonly conflicts: readonly Conflict[]
  /** The line ending used for the output. */
  readonly eol: Eol
  /** Human-readable notes (e.g. "mixed line endings normalised to CRLF"). */
  readonly notes: readonly string[]
}

const DEFAULT_LABELS: MergeLabels = {
  ours: 'yours',
  base: 'original template',
  theirs: 'new template',
}

const MARKER = /^(<{7}|\|{7}|={7}|>{7})(?: |$)/m

/**
 * True if the text contains conflict markers. A file with unresolved markers must not be merged
 * again: the markers would nest, and the user's resolution work would be lost.
 */
export function hasConflictMarkers(text: string): boolean {
  return MARKER.test(text)
}

/** Three-way merge. Pure function: no I/O. */
export function mergeThreeWay(
  input: { readonly base: string; readonly ours: string; readonly theirs: string },
  options: MergeOptions = {},
): MergeResult {
  const ignoreWs = options.ignoreTrailingWhitespace ?? true
  const labels = { ...DEFAULT_LABELS, ...options.labels }
  const shape = mergeShapes(shapeOf(input.base), shapeOf(input.ours), shapeOf(input.theirs))
  const notes = shapeNotes(shape)

  const o = toLines(input.base)
  const a = toLines(input.ours)
  const b = toLines(input.theirs)
  const key = (l: string) => lineKey(l, ignoreWs)
  const oK = o.map(key)
  const aK = a.map(key)
  const bK = b.map(key)

  // o→a offset mapping, used to emit the USER's version of regions both sides left unchanged.
  const oToA = offsetMapper(
    diffIndices(oK, aK).map((h) => ({
      oStart: h.buffer1[0],
      oLength: h.buffer1[1],
      xLength: h.buffer2[1],
    })),
  )

  const out: string[] = []
  const conflicts: Conflict[] = []

  for (const region of diff3MergeRegions(aK, oK, bK)) {
    if (region.stable) {
      const { buffer, bufferStart: s, bufferLength: n } = region
      if (buffer === 'a') out.push(...a.slice(s, s + n))
      else if (buffer === 'b') out.push(...b.slice(s, s + n))
      else {
        // Unchanged by both sides (by key). Emit the user's lines: they may differ from the base
        // in ignored whitespace, and those bytes belong to the user.
        const as = oToA(s)
        const userLines = a.slice(as, as + n)
        if (userLines.length === n && userLines.every((l, i) => key(l) === oK[s + i]))
          out.push(...userLines)
        else out.push(...o.slice(s, s + n)) // defensive: a mapping mismatch should be impossible
      }
      continue
    }

    const aLines = a.slice(region.aStart, region.aStart + region.aLength)
    const oLines = o.slice(region.oStart, region.oStart + region.oLength)
    const bLines = b.slice(region.bStart, region.bStart + region.bLength)
    const aKeys = aLines.map(key)
    const oKeys = oLines.map(key)
    const bKeys = bLines.map(key)

    if (sameKeys(aKeys, bKeys))
      out.push(...aLines) // identical change on both sides
    else if (sameKeys(aKeys, oKeys))
      out.push(...bLines) // only the template changed
    else if (sameKeys(bKeys, oKeys))
      out.push(...aLines) // only the user changed
    else {
      conflicts.push({
        kind: conflictKind(aLines.length, oLines.length, bLines.length),
        outputLine: out.length + 1,
        ours: aLines,
        base: oLines,
        theirs: bLines,
      })
      out.push(
        `<<<<<<< ${labels.ours}`,
        ...aLines,
        `||||||| ${labels.base}`,
        ...oLines,
        '=======',
        ...bLines,
        `>>>>>>> ${labels.theirs}`,
      )
    }
  }

  return {
    status: conflicts.length > 0 ? 'conflicted' : 'clean',
    mode: 'three-way',
    text: fromLines(out, shape),
    conflicts,
    eol: shape.eol,
    notes,
  }
}

/**
 * Two-way fallback for when the base is missing or corrupt. Without a base nobody can know who
 * changed what, so EVERY difference between `ours` and `theirs` becomes a conflict: nothing is
 * applied silently. The notes say so explicitly.
 */
export function mergeTwoWay(
  input: { readonly ours: string; readonly theirs: string },
  options: MergeOptions = {},
): MergeResult {
  const ignoreWs = options.ignoreTrailingWhitespace ?? true
  const labels = { ...DEFAULT_LABELS, ...options.labels }
  const shape = shapeOf(input.ours)
  const notes = [
    ...shapeNotes(shape),
    'base unavailable: every difference is reported as a conflict',
  ]
  const a = toLines(input.ours)
  const b = toLines(input.theirs)
  const key = (l: string) => lineKey(l, ignoreWs)

  const out: string[] = []
  const conflicts: Conflict[] = []
  let ai = 0
  for (const h of diffIndices(a.map(key), b.map(key))) {
    const [aStart, aLength] = h.buffer1
    const [bStart, bLength] = h.buffer2
    out.push(...a.slice(ai, aStart))
    const aLines = a.slice(aStart, aStart + aLength)
    const bLines = b.slice(bStart, bStart + bLength)
    conflicts.push({
      kind: aLines.length === 0 || bLines.length === 0 ? 'both-added' : 'both-modified',
      outputLine: out.length + 1,
      ours: aLines,
      base: null,
      theirs: bLines,
    })
    out.push(
      `<<<<<<< ${labels.ours}`,
      ...aLines,
      `||||||| ${labels.base} (unavailable)`,
      '=======',
      ...bLines,
      `>>>>>>> ${labels.theirs}`,
    )
    ai = aStart + aLength
  }
  out.push(...a.slice(ai))

  return {
    status: conflicts.length > 0 ? 'conflicted' : 'clean',
    mode: 'two-way',
    text: fromLines(out, shape),
    conflicts,
    eol: shape.eol,
    notes,
  }
}

function conflictKind(aLen: number, oLen: number, bLen: number): ConflictKind {
  if (oLen === 0) return 'both-added'
  if (aLen === 0) return 'deleted-by-you'
  if (bLen === 0) return 'deleted-by-template'
  return 'both-modified'
}

function sameKeys(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function shapeNotes(shape: TextShape): string[] {
  return shape.mixedEol
    ? [`mixed line endings normalised to ${shape.eol === '\r\n' ? 'CRLF' : 'LF'}`]
    : []
}

/**
 * Build a function mapping an index in the base (o) to the corresponding index in a derived
 * buffer (x), valid for indices outside any changed hunk.
 */
function offsetMapper(
  hunks: readonly { oStart: number; oLength: number; xLength: number }[],
): (i: number) => number {
  const sorted = [...hunks].sort((p, q) => p.oStart - q.oStart)
  return (i) => {
    let shift = 0
    for (const h of sorted) {
      if (h.oStart + h.oLength <= i) shift += h.xLength - h.oLength
      else break
    }
    return i + shift
  }
}
