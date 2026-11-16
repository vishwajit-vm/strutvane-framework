/**
 * The query AST: what the query builder records before anything becomes SQL.
 *
 * Keeping queries as data until the last moment is what lets the ORM do Eloquent's tricks
 * safely: clone a query to count its rows for pagination, drop a global scope by name, wrap a
 * related query into `EXISTS (…)` for `whereHas`, or into `(SELECT COUNT(*) …)` for `withCount`.
 * Every node holds column *references* (alias + column), never SQL text.
 */
import type { SqlFragment } from './fragment.ts'

/**
 * A column of a table in the current query, qualified by that table's alias.
 *
 * @example
 * const ref: ColumnRef = { alias: 'posts', column: 'title' }
 */
export interface ColumnRef {
  readonly alias: string
  readonly column: string
}

/** Comparison operators the builder accepts. `!=` and `<>` are NULL-safe (ADR-0008). */
export type CompareOperator = '=' | '!=' | '<>' | '<' | '<=' | '>' | '>='

/** How a condition joins the one before it. */
export type Conjunction = 'and' | 'or'

/**
 * One condition in a `WHERE` clause.
 *
 * @example
 * const node: WhereNode = { kind: 'compare', conjunction: 'and', column: ref, operator: '=', value: 'published' }
 */
export type WhereNode =
  | { readonly kind: 'compare'; readonly conjunction: Conjunction; readonly column: ColumnRef; readonly operator: CompareOperator; readonly value: unknown }
  | { readonly kind: 'null'; readonly conjunction: Conjunction; readonly column: ColumnRef; readonly negated: boolean }
  | { readonly kind: 'in'; readonly conjunction: Conjunction; readonly column: ColumnRef; readonly values: readonly unknown[]; readonly negated: boolean }
  | { readonly kind: 'group'; readonly conjunction: Conjunction; readonly nodes: readonly WhereNode[] }
  | { readonly kind: 'raw'; readonly conjunction: Conjunction; readonly fragment: SqlFragment }
  | { readonly kind: 'columns'; readonly conjunction: Conjunction; readonly left: ColumnRef; readonly right: ColumnRef }
  | { readonly kind: 'exists'; readonly conjunction: Conjunction; readonly query: SelectAst; readonly negated: boolean }
  | { readonly kind: 'boolean'; readonly conjunction: Conjunction; readonly value: boolean }

/**
 * One item in the `SELECT` list.
 *
 * @example
 * const all: SelectItem = { kind: 'all', alias: 'posts' }
 */
export type SelectItem =
  | { readonly kind: 'all'; readonly alias: string }
  | { readonly kind: 'column'; readonly column: ColumnRef; readonly as: string }
  | { readonly kind: 'count'; readonly as: string }
  | { readonly kind: 'subquery'; readonly query: SelectAst; readonly as: string }

/**
 * An inner join on one equality (all the ORM's relations need).
 *
 * @example
 * const join: JoinNode = { table: 'post_tag', alias: 'post_tag', left: tagId, right: pivotTagId }
 */
export interface JoinNode {
  readonly table: string
  readonly alias: string
  readonly left: ColumnRef
  readonly right: ColumnRef
}

/**
 * One `ORDER BY` term.
 *
 * @example
 * const order: OrderNode = { column: ref, direction: 'desc' }
 */
export interface OrderNode {
  readonly column: ColumnRef
  readonly direction: 'asc' | 'desc'
}

/**
 * A complete `SELECT`.
 *
 * @example
 * const ast: SelectAst = { table: 'posts', alias: 'posts', select: [{ kind: 'all', alias: 'posts' }], joins: [], where: [], orderBy: [] }
 */
export interface SelectAst {
  readonly table: string
  readonly alias: string
  readonly select: readonly SelectItem[]
  readonly joins: readonly JoinNode[]
  readonly where: readonly WhereNode[]
  readonly orderBy: readonly OrderNode[]
  readonly limit?: number
  readonly offset?: number
}
