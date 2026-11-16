/**
 * Pagination results and the cursor format.
 *
 * Offset pagination (`paginate`) is what admin tables want: page numbers and a total. Cursor
 * pagination (`cursorPaginate`) is what APIs and infinite scroll want: stable under inserts and
 * as fast on page 10,000 as on page 1, because it seeks (`WHERE (created_at, id) < (…)`) instead
 * of skipping rows.
 *
 * Cursors are opaque base64url JSON: the last row's sort values plus a fingerprint of the sort.
 * Decoding trusts nothing: shape, sizes and value types are checked, and a cursor made for one
 * sort can't be replayed against another (it would silently skip or repeat rows).
 */
import { OrmUsageError } from './errors.ts'

/**
 * One page of an offset-paginated query (Laravel's `LengthAwarePaginator`, as plain data).
 *
 * @example
 * const page = await Post.query().paginate(25, 2) // page.total, page.lastPage, page.data
 */
export interface Page<TResult> {
  readonly data: TResult[]
  readonly total: number
  readonly perPage: number
  readonly currentPage: number
  readonly lastPage: number
}

/**
 * One page of a cursor-paginated query.
 *
 * @example
 * const next = await Post.query().cursorPaginate(25, page.nextCursor ?? undefined)
 */
export interface CursorPage<TResult> {
  readonly data: TResult[]
  readonly perPage: number
  /** Pass this to get the following page; `null` on the last page. */
  readonly nextCursor: string | null
}

/** The values a cursor may hold (dates travel as ISO strings). */
export type CursorValue = string | number | boolean

const MAX_CURSOR_LENGTH = 2048

/**
 * Encode the last row's sort values.
 *
 * @example
 * encodeCursor('posts:created_at:desc,id:desc', ['2026-11-14T10:00:00.000Z', 42])
 */
export function encodeCursor(fingerprint: string, values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify({ f: fingerprint, v: values }), 'utf8').toString('base64url')
}

/**
 * Decode and validate a cursor for the given sort. Throws a friendly error for anything
 * malformed, tampered with, or made for a different sort.
 *
 * @example
 * decodeCursor(cursor, 'posts:id:asc', 1) // [42]
 */
export function decodeCursor(cursor: string, fingerprint: string, size: number): CursorValue[] {
  const invalid = (): OrmUsageError =>
    new OrmUsageError(
      'INVALID_CURSOR',
      'That page cursor is invalid or was made for a different sort order. Start again from the first page.',
    )
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (typeof parsed !== 'object' || parsed === null || !('f' in parsed) || !('v' in parsed))
    throw invalid()
  const { f, v } = parsed
  if (f !== fingerprint || !Array.isArray(v) || v.length !== size) throw invalid()
  const values: CursorValue[] = []
  for (const item of v) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean')
      throw invalid()
    values.push(item)
  }
  return values
}
