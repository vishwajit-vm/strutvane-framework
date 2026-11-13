/**
 * Sorting and keyset (cursor) pagination.
 *
 * - Every sort gets a stable `id` tiebreaker, so pages never overlap or skip rows.
 * - NULLs sort **last** in both directions on every engine (Postgres and SQLite disagree by
 *   default, so the order is spelled out: `(col IS NULL), col`).
 * - Text sorts by code point (`COLLATE "C"` on Postgres = SQLite BINARY), so both engines and
 *   the cursor agree. Locale-aware collation is deferred.
 * - Cursors are opaque base64url JSON holding the last row's sort values plus a fingerprint of
 *   the sort, so a cursor from one sort cannot be replayed against another. Decoding never
 *   trusts input: shape, length and every value's type are checked.
 *
 * @module
 */
import type { SortDirective } from '@strutvane/contracts'
import { type FilterValue, filterValue, ValueError } from '../data/values.ts'
import { frag, join, type SqlFragment } from '../database/sql.ts'
import type { Dialect } from '../database/types.ts'
import type { BoundField } from './bind.ts'
import { columnRef, orderExpr, orderParam } from './compile.ts'
import type { QueryField } from './fields.ts'

/** One resolved sort key. */
export interface SortKey {
  readonly field: BoundField
  readonly direction: 'asc' | 'desc'
  /** Whether the column can hold NULL. */
  readonly nullable: boolean
}

/** Thrown for a sort on an unknown or non-sortable field. */
export class SortError extends Error {
  override readonly name = 'SortError'
  readonly field: string
  constructor(field: string) {
    super(`"${field}" is not sortable`)
    this.field = field
  }
}

/** Thrown for a malformed, tampered or mismatched cursor. */
export class CursorError extends Error {
  override readonly name = 'CursorError'
}

const toBound = (f: QueryField): BoundField => ({
  key: f.key,
  column: f.column,
  kind: f.def.kind,
  ...(f.def.scale !== undefined ? { scale: f.def.scale } : {}),
})

/**
 * Resolve sort directives against the queryable fields (only `sortable` ones, plus system
 * fields) and append the `id` tiebreaker. An empty sort means `id` ascending (UUIDv7 ids are
 * time-ordered, so that is creation order).
 */
export function resolveSort(
  sort: readonly SortDirective[],
  fields: ReadonlyMap<string, QueryField>,
): SortKey[] {
  const keys: SortKey[] = []
  const seen = new Set<string>()
  for (const s of sort) {
    const f = fields.get(s.field)
    if (!f?.def.sortable) throw new SortError(s.field)
    if (seen.has(f.key)) continue
    seen.add(f.key)
    keys.push({ field: toBound(f), direction: s.direction, nullable: !f.def.required })
  }
  if (!seen.has('id')) {
    const id = fields.get('id') as QueryField
    keys.push({ field: toBound(id), direction: 'asc', nullable: false })
  }
  return keys
}

/** `ORDER BY` body for the keys (no values, so no parameters). */
export function orderByClause(keys: readonly SortKey[], dialect: Dialect, alias?: string): string {
  return keys
    .flatMap((k) => {
      const parts: string[] = []
      if (k.nullable) parts.push(`(${columnRef(k.field, alias)} IS NULL) ASC`)
      parts.push(`${orderExpr(k.field, dialect, alias)} ${k.direction === 'asc' ? 'ASC' : 'DESC'}`)
      return parts
    })
    .join(', ')
}

const fingerprint = (keys: readonly SortKey[]): string =>
  keys.map((k) => `${k.field.key}:${k.direction}`).join(',')

/** Encode the cursor pointing just after `row` (a record of API values). */
export function encodeCursor(
  keys: readonly SortKey[],
  row: Readonly<Record<string, unknown>>,
): string {
  const values = keys.map((k) => {
    const v = row[k.field.key]
    return v === null || v === undefined ? null : filterValue(k.field.kind, k.field, v)
  })
  return Buffer.from(JSON.stringify({ v: 1, s: fingerprint(keys), k: values }), 'utf8').toString(
    'base64url',
  )
}

/** Decode a cursor for these keys. Throws {@link CursorError} for anything unexpected. */
export function decodeCursor(cursor: string, keys: readonly SortKey[]): (FilterValue | null)[] {
  if (cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new CursorError('malformed cursor')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new CursorError('malformed cursor')
  }
  const body = parsed as { v?: unknown; s?: unknown; k?: unknown } | null
  if (typeof body !== 'object' || body === null || body.v !== 1 || !Array.isArray(body.k)) {
    throw new CursorError('malformed cursor')
  }
  if (body.s !== fingerprint(keys)) throw new CursorError('cursor belongs to a different sort')
  if (body.k.length !== keys.length) throw new CursorError('malformed cursor')
  return keys.map((k, i) => {
    const raw = (body.k as unknown[])[i]
    if (raw === null) {
      if (!k.nullable) throw new CursorError('malformed cursor')
      return null
    }
    try {
      return filterValue(k.field.kind, k.field, raw)
    } catch (error) {
      if (error instanceof ValueError) throw new CursorError('malformed cursor')
      throw error
    }
  })
}

/**
 * The WHERE fragment selecting rows strictly after the cursor position in this order:
 * `OR_i (AND_{j<i} key_j = v_j) AND key_i "after" v_i`, honouring NULLS LAST.
 */
export function seekPredicate(
  keys: readonly SortKey[],
  values: readonly (FilterValue | null)[],
  dialect: Dialect,
  alias?: string,
): SqlFragment {
  const terms: SqlFragment[] = []
  const prefix: SqlFragment[] = []
  keys.forEach((k, i) => {
    const v = values[i] ?? null
    const col = columnRef(k.field, alias)
    if (v !== null) {
      const cmp = k.direction === 'asc' ? '>' : '<'
      const after = frag(
        `${orderExpr(k.field, dialect, alias)} ${cmp} ${orderParam(k.field, dialect)}`,
        [v],
      )
      const afterOrNull = k.nullable
        ? frag(`(${after.text} OR ${col} IS NULL)`, after.params)
        : after
      terms.push(prefix.length > 0 ? join([...prefix, afterOrNull], ' AND ') : afterOrNull)
      prefix.push(frag(`${col} = ?`, [v]))
    } else {
      // Nothing sorts after NULL on this key except rows that tie on it (NULLS LAST).
      prefix.push(frag(`${col} IS NULL`))
    }
  })
  if (terms.length === 0) return frag('(1 = 0)')
  const ored = join(
    terms.map((t) => frag(`(${t.text})`, t.params)),
    ' OR ',
  )
  return frag(`(${ored.text})`, ored.params)
}
