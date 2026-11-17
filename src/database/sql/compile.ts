/**
 * The compiler: AST in, parameterised fragment out.
 *
 * Rules every function here follows:
 * - Values only ever become `value(...)` parts (bound parameters). Never text.
 * - Identifiers only ever become `identifier(...)` parts (validated, then quoted per dialect).
 * - The only dialect-specific choice the compiler makes is asked of the {@link Grammar}.
 *
 * NULL semantics (ADR-0008, applied to the developer-facing builder):
 * - `where(col, null)` is `IS NULL`, like Laravel.
 * - `where(col, '!=', x)` is NULL-safe: rows where `col` is NULL **match**, exactly like
 *   JavaScript's `row.col !== x`. Plain SQL `<>` would silently drop them. This is a deliberate
 *   difference from Laravel, documented in the design.
 * - `whereNotIn` likewise includes NULL rows (`NOT COALESCE(col IN (…), FALSE)`).
 * - `=` and ordering use plain operators so indexes stay usable. Inside AND/OR (the builder has
 *   no NOT around arbitrary groups) an unknown comparison behaves exactly like false, so this is
 *   still two-valued at the level the caller sees.
 */
import { compileFilterSql } from '../../query/compile-sql.ts'
import type {
  ColumnRef,
  CompareOperator,
  OrderNode,
  SelectAst,
  SelectItem,
  WhereNode,
} from './ast.ts'
import { concat, identifier, type SqlFragment, sql, text, value } from './fragment.ts'
import { type Grammar, isMysqlFamily } from './grammar.ts'

/**
 * A qualified column: `"posts"."title"`.
 *
 * @example
 * columnSql({ alias: 'posts', column: 'title' })
 */
export function columnSql(ref: ColumnRef): SqlFragment {
  return concat(identifier(ref.alias), text('.'), identifier(ref.column))
}

/**
 * Compile a `SELECT`.
 *
 * @example
 * compileSelect(ast, postgresGrammar)
 */
export function compileSelect(ast: SelectAst, grammar: Grammar): SqlFragment {
  const parts: SqlFragment[] = [
    text('SELECT '),
    sql.join(
      ast.select.map((item) => selectItemSql(item, grammar)),
      ', ',
    ),
    text(' FROM '),
    tableSql(ast.table, ast.alias),
  ]
  for (const join of ast.joins) {
    parts.push(
      text(' INNER JOIN '),
      tableSql(join.table, join.alias),
      text(' ON '),
      columnSql(join.left),
      text(' = '),
      columnSql(join.right),
    )
  }
  const where = compileWhere(ast.where, grammar)
  if (where !== undefined) parts.push(text(' WHERE '), where)
  if (ast.orderBy.length > 0)
    parts.push(text(' ORDER BY '), sql.join(ast.orderBy.map(orderSql), ', '))
  parts.push(...pagingSql(ast, grammar))
  return concat(...parts)
}

/**
 * `LIMIT ? OFFSET ?`. MySQL and SQLite refuse an OFFSET without a LIMIT, so the grammar supplies
 * its "no limit" spelling (a constant written by us, never input).
 */
function pagingSql(ast: SelectAst, grammar: Grammar): SqlFragment[] {
  const parts: SqlFragment[] = []
  if (ast.limit !== undefined) parts.push(text(' LIMIT '), value(ast.limit))
  else if (ast.offset !== undefined && grammar.limitForOffsetOnly !== undefined)
    parts.push(text(` LIMIT ${grammar.limitForOffsetOnly}`))
  if (ast.offset !== undefined) parts.push(text(' OFFSET '), value(ast.offset))
  return parts
}

function tableSql(table: string, alias: string): SqlFragment {
  // `posts` when the alias is the table itself, `posts AS posts__tags` in subqueries.
  return table === alias
    ? identifier(table)
    : concat(identifier(table), text(' AS '), identifier(alias))
}

function selectItemSql(item: SelectItem, grammar: Grammar): SqlFragment {
  switch (item.kind) {
    case 'all':
      return concat(identifier(item.alias), text('.*'))
    case 'column':
      return concat(columnSql(item.column), text(' AS '), identifier(item.as))
    case 'count':
      return concat(text('COUNT(*) AS '), identifier(item.as))
    case 'subquery':
      return concat(
        text('('),
        compileSelect(item.query, grammar),
        text(') AS '),
        identifier(item.as),
      )
  }
}

function orderSql(order: OrderNode): SqlFragment {
  return concat(columnSql(order.column), text(order.direction === 'desc' ? ' DESC' : ' ASC'))
}

/**
 * Compile a list of conditions joined by their conjunctions. Returns `undefined` for "no
 * conditions" so callers can omit `WHERE` entirely.
 *
 * @example
 * compileWhere([{ kind: 'boolean', conjunction: 'and', value: true }], sqliteGrammar)
 */
export function compileWhere(
  nodes: readonly WhereNode[],
  grammar: Grammar,
): SqlFragment | undefined {
  if (nodes.length === 0) return undefined
  const parts: SqlFragment[] = []
  nodes.forEach((node, index) => {
    // The first condition's conjunction is meaningless (`WHERE AND …`), so it is skipped.
    if (index > 0) parts.push(text(node.conjunction === 'or' ? ' OR ' : ' AND '))
    parts.push(whereNodeSql(node, grammar))
  })
  return concat(...parts)
}

function whereNodeSql(node: WhereNode, grammar: Grammar): SqlFragment {
  switch (node.kind) {
    case 'compare':
      return compareSql(node.column, node.operator, node.value, grammar)
    case 'null':
      return concat(columnSql(node.column), text(node.negated ? ' IS NOT NULL' : ' IS NULL'))
    case 'in':
      return inSql(node.column, node.values, node.negated)
    case 'group': {
      const inner = compileWhere(node.nodes, grammar)
      return inner === undefined ? text('1 = 1') : concat(text('('), inner, text(')'))
    }
    case 'raw':
      return concat(text('('), node.fragment, text(')'))
    case 'columns':
      return concat(columnSql(node.left), text(' = '), columnSql(node.right))
    case 'exists':
      return concat(
        text(node.negated ? 'NOT EXISTS (' : 'EXISTS ('),
        compileSelect(node.query, grammar),
        text(')'),
      )
    case 'boolean':
      return text(node.value ? '1 = 1' : '1 = 0')
    case 'filter':
      return compileFilterSql(node.filter, grammar, node.alias)
  }
}

function compareSql(
  column: ColumnRef,
  operator: CompareOperator,
  bound: unknown,
  grammar: Grammar,
): SqlFragment {
  const isNotEqual = operator === '!=' || operator === '<>'
  if (bound === null) {
    // Laravel turns where(col, null) into IS NULL; we do the same, and its negation into IS NOT NULL.
    if (operator === '=') return concat(columnSql(column), text(' IS NULL'))
    if (isNotEqual) return concat(columnSql(column), text(' IS NOT NULL'))
    // Ordering against NULL is never true, on both paths: say so explicitly instead of sending NULL.
    return text('1 = 0')
  }
  if (isNotEqual) return grammar.nullSafeNotEqual(columnSql(column), value(bound))
  return concat(columnSql(column), text(` ${operator} `), value(bound))
}

function inSql(column: ColumnRef, values: readonly unknown[], negated: boolean): SqlFragment {
  // An empty IN list is invalid SQL; it means "nothing matches" (or "everything" when negated).
  if (values.length === 0) return text(negated ? '1 = 1' : '1 = 0')
  const list = sql.join(
    values.map((item) => value(item)),
    ', ',
  )
  const membership = concat(columnSql(column), text(' IN ('), list, text(')'))
  // NOT IN is NULL-safe here: a NULL column is "not in the list", like JavaScript's !list.includes(x).
  return negated ? concat(text('NOT COALESCE('), membership, text(', FALSE)')) : membership
}

/**
 * Compile an `INSERT` for one row, with `RETURNING *` where the engine supports it (on MySQL the
 * caller re-selects the row by its key instead).
 *
 * @example
 * compileInsert('tags', { name: 'news' }, mysqlGrammar)
 */
export function compileInsert(
  table: string,
  record: Readonly<Record<string, unknown>>,
  grammar: Grammar,
): SqlFragment {
  const columns = Object.keys(record)
  const returning = text(grammar.supportsReturning ? ' RETURNING *' : '')
  // An all-defaults row: standard SQL says DEFAULT VALUES, MySQL says () VALUES ().
  if (columns.length === 0)
    return concat(
      text('INSERT INTO '),
      identifier(table),
      text(isMysqlFamily(grammar.dialect) ? ' () VALUES ()' : ' DEFAULT VALUES'),
      returning,
    )
  const names = sql.join(
    columns.map((column) => identifier(column)),
    ', ',
  )
  const values = sql.join(
    columns.map((column) => value(record[column])),
    ', ',
  )
  return concat(
    text('INSERT INTO '),
    identifier(table),
    text(' ('),
    names,
    text(') VALUES ('),
    values,
    text(')'),
    returning,
  )
}

/**
 * Compile an `UPDATE`. `returning` adds `RETURNING *` (single-model saves want the fresh row);
 * engines without `UPDATE … RETURNING` (MySQL, MariaDB) ignore it and the caller re-selects.
 *
 * @example
 * compileUpdate('posts', { title: 'New' }, where, sqliteGrammar, true)
 */
export function compileUpdate(
  table: string,
  changes: Readonly<Record<string, unknown>>,
  where: readonly WhereNode[],
  grammar: Grammar,
  returning: boolean,
): SqlFragment {
  const assignments = sql.join(
    Object.keys(changes).map((column) =>
      concat(identifier(column), text(' = '), value(changes[column])),
    ),
    ', ',
  )
  const parts = [text('UPDATE '), identifier(table), text(' SET '), assignments]
  const condition = compileWhere(where, grammar)
  if (condition !== undefined) parts.push(text(' WHERE '), condition)
  if (returning && grammar.supportsUpdateReturning) parts.push(text(' RETURNING *'))
  return concat(...parts)
}

/**
 * Compile a `DELETE`.
 *
 * @example
 * compileDelete('posts', where, postgresGrammar)
 */
export function compileDelete(
  table: string,
  where: readonly WhereNode[],
  grammar: Grammar,
): SqlFragment {
  const condition = compileWhere(where, grammar)
  return condition === undefined
    ? concat(text('DELETE FROM '), identifier(table))
    : concat(text('DELETE FROM '), identifier(table), text(' WHERE '), condition)
}
