/**
 * Bound filter → parameterised SQL, for Postgres and SQLite (ADR-0008).
 *
 * Guarantees:
 * - **No value is ever concatenated into SQL.** Values are bound parameters; identifiers come
 *   from the model and are quoted after validation.
 * - **Two-valued.** Every leaf compiles to an expression that is never NULL, so `NOT (…)` behaves
 *   exactly like JavaScript `!`:
 *   `eq` → `COALESCE(col = ?, FALSE)`; `ne` → `NOT COALESCE(col = ?, FALSE)` (matches NULL rows);
 *   ordering → `COALESCE(col > ?, FALSE)`; `in` → `COALESCE(col IN (…), FALSE)`.
 * - **Literal text matching.** `contains` uses `strpos`/`instr`, never `LIKE`, so `%` and `_` in
 *   user input are not wildcards. Case-insensitive matching folds **ASCII letters only** on every
 *   path (Postgres `translate`, SQLite `lower`, JS) so the engines cannot disagree on Unicode
 *   case rules; non-ASCII letters match exactly.
 * - **Engine-independent ordering.** SQLite stores decimals as exact text, so ordering casts them
 *   to REAL; Postgres compares `numeric` exactly. Both agree for the precisions fields allow.
 *
 * @module
 */
import type { SqlFragment as OrmFragment } from '../database/sql/fragment.ts'
import { frag, ident, type SqlFragment } from '../database/sql.ts'
import type { Dialect } from '../database/types.ts'
import type { BoundField, BoundFilter } from './bind.ts'
import { compileFilterSql } from './compile-sql.ts'

/** Options for {@link compileFilter}. */
export interface CompileFilterOptions {
  readonly dialect: Dialect
  /** Table alias to qualify columns with (`t` → `"t"."status"`). */
  readonly alias?: string
}

/** The column reference, qualified by the alias. */
export function columnRef(field: Pick<BoundField, 'column'>, alias?: string): string {
  return alias ? `${ident(alias)}.${ident(field.column)}` : ident(field.column)
}

/** The expression used to *order* a field (decimals on SQLite compare numerically). */
export function orderExpr(
  field: Pick<BoundField, 'column' | 'kind'>,
  dialect: Dialect,
  alias?: string,
): string {
  const col = columnRef(field, alias)
  if (dialect === 'sqlite' && field.kind === 'decimal') return `CAST(${col} AS REAL)`
  if (dialect === 'postgres' && isTextual(field.kind)) return `${col} COLLATE "C"`
  return col
}

/** The placeholder for a value compared with {@link orderExpr}. */
export function orderParam(field: Pick<BoundField, 'kind'>, dialect: Dialect): string {
  if (dialect === 'sqlite' && field.kind === 'decimal') return 'CAST(? AS REAL)'
  if (dialect === 'postgres' && isTextual(field.kind)) return '? COLLATE "C"'
  return '?'
}

const isTextual = (kind: BoundField['kind']): boolean =>
  kind === 'string' || kind === 'text' || kind === 'email' || kind === 'url' || kind === 'enum'

/**
 * Compile a bound filter to a WHERE fragment with `?` placeholders (see `render`).
 *
 * Kept for v1 callers (the repository and list queries on Postgres and SQLite). It delegates to
 * {@link compileFilterSql}, the one ADR-0008 compiler shared with the ORM, and only re-renders
 * its result in v1's fragment form, so both paths are covered by the same equivalence suite.
 *
 * @example
 * const where = compileFilter(bound, { dialect: 'postgres', alias: 't' })
 */
export function compileFilter(filter: BoundFilter, options: CompileFilterOptions): SqlFragment {
  return toLegacyFragment(compileFilterSql(filter, { dialect: options.dialect }, options.alias))
}

/** An ORM fragment as a v1 `{ text, params }` fragment (`"quoted"` identifiers, `?` values). */
function toLegacyFragment(fragment: OrmFragment): SqlFragment {
  let text = ''
  const params: unknown[] = []
  for (const part of fragment.parts) {
    if (part.kind === 'text') text += part.text
    else if (part.kind === 'identifier') text += ident(part.name)
    else {
      text += '?'
      params.push(part.value)
    }
  }
  return frag(text, params)
}
