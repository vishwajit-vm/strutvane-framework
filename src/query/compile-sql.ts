/**
 * Bound filter → SQL for every engine, through the ORM's grammar (ADR-0008).
 *
 * This is the one policy→SQL compiler. The v1 `compileFilter` (Postgres/SQLite, `?` fragments) is
 * now a thin adapter over it, so the property-based equivalence suite that proves "SQL agrees with
 * the in-memory evaluator" covers both. The guarantees are those of ADR-0008:
 * - **No value is ever SQL text.** Values are bound parameters; identifiers come from the schema
 *   and are validated and quoted by the grammar.
 * - **Two-valued.** Every leaf is wrapped so it is never NULL (`COALESCE(…, FALSE)`), so `NOT (…)`
 *   behaves exactly like JavaScript `!`, and `ne`/`nin` are exact negations of `eq`/`in`.
 * - **Literal, exact text matching.** No `LIKE`: substring tests use `strpos` / `instr` / `LOCATE`,
 *   so `%` and `_` are plain characters. Case-insensitive matching folds **ASCII letters only** on
 *   every path, so the engines can't disagree on Unicode case rules.
 * - **MySQL and MariaDB** compare text under a binary collation (`utf8mb4_0900_bin`,
 *   `utf8mb4_nopad_bin`): their default collations fold case and accents (`'résumé' = 'Resume'`),
 *   which would make a policy match rows the in-memory check refuses. Timestamps are sent in
 *   `DATETIME(3)` form (UTC, no zone).
 *
 * @module
 */
import { concat, identifier, type SqlFragment, sql, text, value } from '../database/sql/fragment.ts'
import type { Dialect, Grammar } from '../database/sql/grammar.ts'
import type { BoundField, BoundFilter } from './bind.ts'

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const SYMBOL = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

/** The grammar facts the compiler needs: just the dialect (quoting happens at render time). */
export type FilterGrammar = Pick<Grammar, 'dialect'>

const isMysql = (dialect: Dialect): boolean => dialect === 'mysql' || dialect === 'mariadb'

const isTextual = (kind: BoundField['kind']): boolean =>
  kind === 'string' || kind === 'text' || kind === 'email' || kind === 'url' || kind === 'enum'

/** The binary collation MySQL-family engines compare text under. */
function binaryCollation(dialect: Dialect): string {
  return dialect === 'mariadb' ? 'utf8mb4_nopad_bin' : 'utf8mb4_0900_bin'
}

/**
 * A column reference, qualified by `alias` when given.
 *
 * @example
 * filterColumn({ column: 'status' }, 'posts') // "posts"."status" once rendered
 */
export function filterColumn(field: Pick<BoundField, 'column'>, alias?: string): SqlFragment {
  return alias === undefined
    ? identifier(field.column)
    : concat(identifier(alias), text('.'), identifier(field.column))
}

/** The column as compared for equality and membership (binary text on MySQL). */
function equalityExpr(field: BoundField, dialect: Dialect, alias?: string): SqlFragment {
  const column = filterColumn(field, alias)
  if (isMysql(dialect) && isTextual(field.kind))
    return concat(column, text(` COLLATE ${binaryCollation(dialect)}`))
  return column
}

/**
 * The expression used to *order* a field: decimals compare numerically on SQLite (stored as
 * REAL/text there), text compares by code point (`COLLATE "C"`, binary collations on MySQL).
 *
 * @example
 * filterOrderExpr({ column: 'total', kind: 'decimal' }, 'sqlite') // CAST("total" AS REAL)
 */
export function filterOrderExpr(
  field: Pick<BoundField, 'column' | 'kind'>,
  dialect: Dialect,
  alias?: string,
): SqlFragment {
  const column = filterColumn(field, alias)
  if (dialect === 'sqlite' && field.kind === 'decimal')
    return concat(text('CAST('), column, text(' AS REAL)'))
  if (dialect === 'postgres' && isTextual(field.kind)) return concat(column, text(' COLLATE "C"'))
  if (isMysql(dialect) && isTextual(field.kind))
    return concat(column, text(` COLLATE ${binaryCollation(dialect)}`))
  return column
}

/** A bound value as the engine compares it (timestamps without a zone on MySQL). */
function parameter(field: Pick<BoundField, 'kind'>, bound: unknown, dialect: Dialect): unknown {
  if (field.kind === 'datetime' && isMysql(dialect) && typeof bound === 'string') {
    const date = new Date(bound)
    if (!Number.isNaN(date.getTime())) {
      const iso = date.toISOString()
      return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
    }
  }
  return bound
}

/**
 * The placeholder for a value compared with {@link filterOrderExpr}.
 *
 * @example
 * filterOrderParam({ kind: 'decimal' }, '12.50', 'sqlite') // CAST(? AS REAL)
 */
export function filterOrderParam(
  field: Pick<BoundField, 'kind'>,
  bound: unknown,
  dialect: Dialect,
): SqlFragment {
  const param = value(parameter(field, bound, dialect))
  if (dialect === 'sqlite' && field.kind === 'decimal')
    return concat(text('CAST('), param, text(' AS REAL)'))
  if (dialect === 'postgres' && isTextual(field.kind)) return concat(param, text(' COLLATE "C"'))
  return param
}

/** A text parameter (Postgres can't infer a parameter's type inside string functions). */
function textParam(bound: string, dialect: Dialect): SqlFragment {
  return dialect === 'postgres'
    ? concat(text('CAST('), value(bound), text(' AS text)'))
    : value(bound)
}

/**
 * ASCII-only case folding. Postgres has `translate`; SQLite's built-in `lower()` folds only A-Z
 * (the ORM's SQLite driver registers its Unicode fold under another name, `sv_lower`); MySQL's
 * `LOWER()` is Unicode, so MySQL folds with nested `REPLACE` calls, exact under the binary
 * collation. A Unicode fold would match letters the in-memory evaluator leaves alone.
 */
function fold(expr: SqlFragment, dialect: Dialect): SqlFragment {
  if (dialect === 'sqlite') return concat(text('lower('), expr, text(')'))
  if (dialect === 'postgres')
    return concat(text('translate('), expr, text(`, '${UPPER}', '${LOWER}')`))
  let out = expr
  for (let i = 0; i < UPPER.length; i++) {
    out = concat(text('REPLACE('), out, text(`, '${UPPER[i]}', '${LOWER[i]}')`))
  }
  return out
}

const TRUE = text('(1 = 1)')
const FALSE = text('(1 = 0)')

/**
 * Compile a bound filter to a never-NULL SQL condition for `grammar`'s engine.
 *
 * @example
 * const where = compileFilterSql(bound, grammarFor('mysql'), 'posts')
 * await connection.run(sql`SELECT * FROM ${sql.id('posts')} AS ${sql.id('posts')} WHERE ${where}`)
 */
export function compileFilterSql(
  filter: BoundFilter,
  grammar: FilterGrammar,
  alias?: string,
): SqlFragment {
  const dialect = grammar.dialect
  const col = (f: BoundField): SqlFragment => filterColumn(f, alias)
  const coalesce = (inner: SqlFragment): SqlFragment =>
    concat(text('COALESCE('), inner, text(', FALSE)'))

  const visit = (f: BoundFilter): SqlFragment => {
    switch (f.op) {
      case 'true':
        return TRUE
      case 'false':
        return FALSE
      case 'and':
      case 'or': {
        if (f.filters.length === 0) return f.op === 'and' ? TRUE : FALSE
        return concat(
          text('('),
          sql.join(f.filters.map(visit), f.op === 'and' ? ' AND ' : ' OR '),
          text(')'),
        )
      }
      case 'not':
        return concat(text('(NOT '), visit(f.filter), text(')'))
      case 'isNull':
        return concat(text('('), col(f.field), text(' IS NULL)'))
      case 'isNotNull':
        return concat(text('('), col(f.field), text(' IS NOT NULL)'))
      case 'eq':
      case 'ne': {
        const leaf = coalesce(
          concat(
            equalityExpr(f.field, dialect, alias),
            text(' = '),
            value(parameter(f.field, f.value, dialect)),
          ),
        )
        return f.op === 'eq' ? leaf : concat(text('(NOT '), leaf, text(')'))
      }
      case 'in':
      case 'nin': {
        if (f.values.length === 0) return f.op === 'in' ? FALSE : TRUE
        const list = sql.join(
          f.values.map((v) => value(parameter(f.field, v, dialect))),
          ', ',
        )
        const leaf = coalesce(
          concat(equalityExpr(f.field, dialect, alias), text(' IN ('), list, text(')')),
        )
        return f.op === 'in' ? leaf : concat(text('(NOT '), leaf, text(')'))
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return coalesce(
          concat(
            filterOrderExpr(f.field, dialect, alias),
            text(` ${SYMBOL[f.op]} `),
            filterOrderParam(f.field, f.value, dialect),
          ),
        )
      case 'between': {
        const expr = filterOrderExpr(f.field, dialect, alias)
        return coalesce(
          concat(
            expr,
            text(' >= '),
            filterOrderParam(f.field, f.from, dialect),
            text(' AND '),
            expr,
            text(' <= '),
            filterOrderParam(f.field, f.to, dialect),
          ),
        )
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith':
        return coalesce(textMatch(f.op, equalityExpr(f.field, dialect, alias), f, dialect))
    }
  }
  return visit(filter)
}

function textMatch(
  op: 'contains' | 'startsWith' | 'endsWith',
  column: SqlFragment,
  f: { readonly value: string; readonly caseSensitive: boolean },
  dialect: Dialect,
): SqlFragment {
  const haystack = f.caseSensitive ? column : fold(column, dialect)
  const needle = f.caseSensitive
    ? textParam(f.value, dialect)
    : fold(textParam(f.value, dialect), dialect)
  const length = (fn: string): SqlFragment =>
    concat(text(`${fn}(`), textParam(f.value, dialect), text(')'))
  switch (dialect) {
    case 'postgres':
      if (op === 'contains')
        return concat(text('strpos('), haystack, text(', '), needle, text(') > 0'))
      return concat(
        text(op === 'startsWith' ? 'left(' : 'right('),
        haystack,
        text(', '),
        length('char_length'),
        text(') = '),
        needle,
      )
    case 'sqlite':
      if (op === 'contains')
        return concat(text('instr('), haystack, text(', '), needle, text(') > 0'))
      if (op === 'startsWith')
        return concat(
          text('substr('),
          haystack,
          text(', 1, '),
          length('length'),
          text(') = '),
          needle,
        )
      return concat(text('substr('), haystack, text(', -'), length('length'), text(') = '), needle)
    case 'mysql':
    case 'mariadb': {
      const collated = concat(needle, text(` COLLATE ${binaryCollation(dialect)}`))
      if (op === 'contains')
        return concat(text('LOCATE('), collated, text(', '), haystack, text(') > 0'))
      return concat(
        text(op === 'startsWith' ? 'LEFT(' : 'RIGHT('),
        haystack,
        text(', '),
        length('CHAR_LENGTH'),
        text(') = '),
        collated,
      )
    }
  }
}
