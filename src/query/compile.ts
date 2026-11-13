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
import { frag, ident, join, type SqlFragment } from '../database/sql.ts'
import type { Dialect } from '../database/types.ts'
import type { BoundField, BoundFilter } from './bind.ts'

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const SYMBOL = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

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

function fold(expr: string, dialect: Dialect): string {
  return dialect === 'postgres' ? `translate(${expr}, '${UPPER}', '${LOWER}')` : `lower(${expr})`
}

/** Compile a bound filter to a WHERE fragment (with `?` placeholders; see `render`). */
export function compileFilter(filter: BoundFilter, options: CompileFilterOptions): SqlFragment {
  const { dialect, alias } = options
  const col = (f: BoundField): string => columnRef(f, alias)

  const visit = (f: BoundFilter): SqlFragment => {
    switch (f.op) {
      case 'true':
        return frag('(1 = 1)')
      case 'false':
        return frag('(1 = 0)')
      case 'and':
      case 'or': {
        if (f.filters.length === 0) return frag(f.op === 'and' ? '(1 = 1)' : '(1 = 0)')
        const inner = join(f.filters.map(visit), f.op === 'and' ? ' AND ' : ' OR ')
        return frag(`(${inner.text})`, inner.params)
      }
      case 'not': {
        const inner = visit(f.filter)
        return frag(`(NOT ${inner.text})`, inner.params)
      }
      case 'isNull':
        return frag(`(${col(f.field)} IS NULL)`)
      case 'isNotNull':
        return frag(`(${col(f.field)} IS NOT NULL)`)
      case 'eq':
        return frag(`COALESCE(${col(f.field)} = ?, FALSE)`, [f.value])
      case 'ne':
        return frag(`(NOT COALESCE(${col(f.field)} = ?, FALSE))`, [f.value])
      case 'in':
      case 'nin': {
        if (f.values.length === 0) return frag(f.op === 'in' ? '(1 = 0)' : '(1 = 1)')
        const list = f.values.map(() => '?').join(', ')
        const expr = `COALESCE(${col(f.field)} IN (${list}), FALSE)`
        return frag(f.op === 'in' ? expr : `(NOT ${expr})`, f.values)
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return frag(
          `COALESCE(${orderExpr(f.field, dialect, alias)} ${SYMBOL[f.op]} ${orderParam(f.field, dialect)}, FALSE)`,
          [f.value],
        )
      case 'between': {
        const e = orderExpr(f.field, dialect, alias)
        const p = orderParam(f.field, dialect)
        return frag(`COALESCE(${e} >= ${p} AND ${e} <= ${p}, FALSE)`, [f.from, f.to])
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        const c = f.caseSensitive ? col(f.field) : fold(col(f.field), dialect)
        // Postgres cannot infer a parameter's type inside these functions: cast to text.
        const p = dialect === 'postgres' ? 'CAST(? AS text)' : '?'
        const v = f.caseSensitive ? p : fold(p, dialect)
        if (dialect === 'postgres') {
          if (f.op === 'contains') return frag(`COALESCE(strpos(${c}, ${v}) > 0, FALSE)`, [f.value])
          if (f.op === 'startsWith')
            return frag(`COALESCE(left(${c}, char_length(${p})) = ${v}, FALSE)`, [f.value, f.value])
          return frag(`COALESCE(right(${c}, char_length(${p})) = ${v}, FALSE)`, [f.value, f.value])
        }
        if (f.op === 'contains') return frag(`COALESCE(instr(${c}, ${v}) > 0, FALSE)`, [f.value])
        if (f.op === 'startsWith')
          return frag(`COALESCE(substr(${c}, 1, length(?)) = ${v}, FALSE)`, [f.value, f.value])
        return frag(`COALESCE(substr(${c}, -length(?)) = ${v}, FALSE)`, [f.value, f.value])
      }
    }
  }
  return visit(filter)
}
