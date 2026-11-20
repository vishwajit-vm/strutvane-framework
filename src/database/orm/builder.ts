/**
 * The query builder: Laravel's fluent Eloquent builder, fully typed.
 *
 * ```ts
 * const page = await Post.query()
 *   .where('status', 'published')
 *   .with('author')
 *   .withCount('tags')
 *   .orderBy('created_at', 'desc')
 *   .paginate(25)
 * ```
 *
 * How it stays safe:
 * - Every column name is checked against the schema snapshot (and quoted), every value is
 *   bound. Strings never become SQL; raw SQL needs a `sql` tagged template.
 * - Global scopes (tenant, soft deletes, the model's own) are applied when the query runs, not
 *   when it is built, and the developer's conditions are wrapped in parentheses first. So
 *   `where(a).orWhere(b)` on a tenant table becomes `(a OR b) AND tenant_id = ?`, never
 *   `a OR b AND tenant_id = ?` (which would leak other tenants' rows).
 * - Relations are loaded with one query per relation level (`WHERE fk IN (…)`), never per row.
 *
 * The builder is mutable, like Laravel's: each method changes it and returns it. Use `clone()`
 * to branch a query.
 */
import type { Actor, QueryFilter } from '../../contracts/index.ts'
import { bindFilter } from '../../query/bind.ts'
import { tableQueryFields } from '../../query/table-fields.ts'
import type { Row } from '../db/driver.ts'
import type { ColumnOf } from '../schema/registry.ts'
import { tableState } from '../schema/registry.ts'
import type { ColumnDef } from '../schema/snapshot.ts'
import type {
  ColumnRef,
  CompareOperator,
  Conjunction,
  JoinNode,
  OrderNode,
  SelectAst,
  SelectItem,
  WhereNode,
} from '../sql/ast.ts'
import { columnSql, compileSelect } from '../sql/compile.ts'
import { concat, SqlFragment, text, value } from '../sql/fragment.ts'
import type { RenderedSql } from '../sql/grammar.ts'
import { applyCast, toDatabase } from './casts.ts'
import { ormConfig } from './config.ts'
import { CastError, ModelNotFoundError, OrmUsageError } from './errors.ts'
import type { ModelBase } from './model.ts'
import {
  type CursorPage,
  type CursorValue,
  decodeCursor,
  encodeCursor,
  type Page,
} from './pagination.ts'
import { type ModelRuntime, type StoredCallback, setLoaded } from './runtime.ts'
import { closest } from './suggest.ts'
import { currentTenant } from './tenancy.ts'
import {
  assertReason,
  assertSelectScoped,
  markScoped,
  tenantCondition,
  tenantMode,
} from './tenant-scope.ts'
import type {
  AnyModelClass,
  ColumnValue,
  InstanceOf,
  KeyOf,
  QueryBuilder,
  RelatedQuery,
  RelationNames,
  RelationPath,
  TableOf,
  WithCounts,
  WithRelations,
} from './types.ts'

/** One node of the eager-loading tree: `with('posts.tags')` → posts → tags. */
interface EagerNode {
  constrain: StoredCallback | undefined
  readonly children: Map<string, EagerNode>
}

/** The eager-loading tree, keyed by relation name. */
export type EagerTree = Map<string, EagerNode>

const OPERATORS: ReadonlySet<string> = new Set(['=', '!=', '<>', '<', '<=', '>', '>='])
const MAX_SEARCH_LENGTH = 200
/** The most columns one request-style `sort()` may name (each adds an ORDER BY term). */
const MAX_SORT_TERMS = 8

/**
 * The filter operators resources.json advertises (spike 10), as the builder understands them.
 *
 * @example
 * const operator: FilterOperator = 'startsWith'
 */
export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'contains'
  | 'startsWith'
  | 'null'

const FILTER_SYMBOL = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

/**
 * A query over one model. Get one with `Post.query()` (or `Post.where(…)`, `Post.with(…)`).
 *
 * `TClass` is the model class (it carries the table, options and scopes); `TResult` is what one
 * row turns into, including relations loaded with `with()` and counts from `withCount()`.
 *
 * @example
 * const posts = await Post.query().where('status', 'published').get()
 */
export class Builder<TClass extends AnyModelClass, TResult> {
  readonly #model: ModelRuntime
  readonly #alias: string
  #where: WhereNode[] = []
  /**
   * Conditions the framework adds that the developer's own conditions must never widen: a
   * relation's parent key, its correlation in `whereHas`/`withCount`, eager-load keys and the
   * cursor seek. They are AND-ed outside the developer's parentheses, like the scopes, so
   * `user.posts().where(a).orWhere(b)` stays `author_id = ? AND (a OR b)`.
   */
  #fixed: WhereNode[] = []
  #orderBy: OrderNode[] = []
  #joins: JoinNode[] = []
  #extraSelect: SelectItem[] = []
  #limit: number | undefined
  #offset: number | undefined
  #eager: EagerTree = new Map()
  #counts: { readonly name: string; readonly constrain: StoredCallback | undefined }[] = []
  #withoutScopes = new Set<string>()
  #trashed: 'without' | 'with' | 'only' = 'without'
  #tenancy: 'scoped' | 'bypassed' = 'scoped'

  /**
   * Create a builder for a model. App code calls `Post.query()` instead.
   *
   * @example
   * new Builder(Post) // what Post.query() does
   */
  constructor(model: ModelRuntime, alias: string = model.table) {
    this.#model = model
    this.#alias = alias
    this.#installScopes()
  }

  /** The table alias columns are qualified with (used by relations building subqueries). */
  get alias(): string {
    return this.#alias
  }

  // -------------------------------------------------------------------------------------------
  // Conditions
  // -------------------------------------------------------------------------------------------

  /**
   * Add a condition. Two arguments mean `=`; three take an operator. A function groups
   * conditions in parentheses. `null` means `IS NULL`; `!=` is NULL-safe (NULL rows match).
   *
   * @example
   * Post.query().where('status', 'published').where('created_at', '>', lastWeek)
   * Post.query().where((q) => q.where('status', 'draft').orWhere('author_id', me.id))
   */
  where<TColumn extends ColumnOf<TableOf<TClass>>>(
    column: TColumn,
    value: ColumnValue<TableOf<TClass>, TColumn>,
  ): this
  where<TColumn extends ColumnOf<TableOf<TClass>>>(
    column: TColumn,
    operator: CompareOperator,
    value: ColumnValue<TableOf<TClass>, TColumn>,
  ): this
  where(group: (query: this) => void): this
  where(...args: readonly unknown[]): this {
    this.#where.push(this.#conditionFrom('and', args))
    return this
  }

  /**
   * Like {@link where}, joined with OR.
   *
   * @example
   * Post.query().where('status', 'published').orWhere('author_id', me.id)
   */
  orWhere<TColumn extends ColumnOf<TableOf<TClass>>>(
    column: TColumn,
    value: ColumnValue<TableOf<TClass>, TColumn>,
  ): this
  orWhere<TColumn extends ColumnOf<TableOf<TClass>>>(
    column: TColumn,
    operator: CompareOperator,
    value: ColumnValue<TableOf<TClass>, TColumn>,
  ): this
  orWhere(group: (query: this) => void): this
  orWhere(...args: readonly unknown[]): this {
    this.#where.push(this.#conditionFrom('or', args))
    return this
  }

  /**
   * The column's value is one of `values`. An empty list matches nothing.
   *
   * @example
   * Post.query().whereIn('status', ['draft', 'published'])
   */
  whereIn<TColumn extends ColumnOf<TableOf<TClass>>>(
    column: TColumn,
    values: readonly NonNullable<ColumnValue<TableOf<TClass>, TColumn>>[],
  ): this {
    assertInSize(column, values.length)
    const ref = this.#column(column)
    this.#where.push({
      kind: 'in',
      conjunction: 'and',
      column: ref,
      values: values.map((item) => this.#bind(ref, item)),
      negated: false,
    })
    return this
  }

  /**
   * The column's value is not one of `values`. NULL rows match (they are "not in the list").
   *
   * @example
   * Post.query().whereNotIn('status', ['draft'])
   */
  whereNotIn<TColumn extends ColumnOf<TableOf<TClass>>>(
    column: TColumn,
    values: readonly NonNullable<ColumnValue<TableOf<TClass>, TColumn>>[],
  ): this {
    assertInSize(column, values.length)
    const ref = this.#column(column)
    this.#where.push({
      kind: 'in',
      conjunction: 'and',
      column: ref,
      values: values.map((item) => this.#bind(ref, item)),
      negated: true,
    })
    return this
  }

  /**
   * The column is NULL.
   *
   * @example
   * Post.query().whereNull('published_on')
   */
  whereNull(column: ColumnOf<TableOf<TClass>>): this {
    this.#where.push({
      kind: 'null',
      conjunction: 'and',
      column: this.#column(column),
      negated: false,
    })
    return this
  }

  /**
   * The column is not NULL.
   *
   * @example
   * Post.query().whereNotNull('published_on')
   */
  whereNotNull(column: ColumnOf<TableOf<TClass>>): this {
    this.#where.push({
      kind: 'null',
      conjunction: 'and',
      column: this.#column(column),
      negated: true,
    })
    return this
  }

  /**
   * A raw condition, written with the `sql` tag so values are bound. Plain strings are refused.
   *
   * @example
   * Post.query().whereRaw(sql`length(${sql.id('title')}) > ${10}`)
   */
  whereRaw(fragment: SqlFragment): this {
    if (!SqlFragment.is(fragment)) {
      throw new OrmUsageError(
        'raw_sql_not_fragment',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the message shows the sql tag syntax
        'whereRaw() needs a sql`…` fragment, not a string. Strings would let user input become SQL; put values in ${…} inside the sql tag.',
      )
    }
    this.#where.push({ kind: 'raw', conjunction: 'and', fragment })
    return this
  }

  /**
   * Keep only rows a policy filter allows (ADR-0008/0017): the same portable `QueryFilter` the
   * in-memory check uses, bound against this table's columns (`$actor` references resolved from
   * `actor`), then compiled with two-valued, NULL-safe semantics for this engine. A `null` actor
   * value never matches, and a missing actor attribute throws before any SQL runs.
   *
   * @example
   * Invoice.query().wherePolicy({ field: 'owner_id', op: 'eq', value: { $actor: 'id' } }, { actor })
   */
  wherePolicy(filter: QueryFilter, options: { readonly actor: Actor | null }): this {
    const bound = bindFilter(filter, {
      fields: tableQueryFields(tableState(this.#model.table), { includeHidden: true }),
      operators: 'any',
      actor: options.actor,
    })
    this.#where.push({ kind: 'filter', conjunction: 'and', alias: this.#alias, filter: bound })
    return this
  }

  /**
   * Keep rows that have at least one related row (optionally matching extra conditions).
   * Compiles to `EXISTS (…)`, so it never loads the related rows.
   *
   * @example
   * User.query().whereHas('posts', (q) => q.where('status', 'published'))
   */
  whereHas<TName extends RelationNames<InstanceOf<TClass>>>(
    name: TName,
    constrain?: (query: RelatedQuery<InstanceOf<TClass>, TName>) => void,
  ): this {
    const relation = this.#model.relation(name)
    const query = relation.subquery(this.#alias, `${this.#alias}__${name}`, constrain, 'exists')
    this.#where.push({ kind: 'exists', conjunction: 'and', query, negated: false })
    return this
  }

  // -------------------------------------------------------------------------------------------
  // Request-driven queries (what a ResourceController calls with ?search=, ?filter=, ?sort=)
  //
  // These take column names as plain strings because they come from the request. Every name is
  // checked against the schema snapshot (unknown → OrmUsageError 'unknown_column', a 400), and
  // the controller must also check them against the resource's allow-lists (searchable,
  // sortable, filterable in resources.json): existing is not the same as allowed.
  // -------------------------------------------------------------------------------------------

  /**
   * Case-insensitive, literal "contains": `%` and `_` in the text are not wildcards.
   *
   * @example
   * Post.query().whereContains('title', '100%')
   */
  whereContains(column: string, needle: string): this {
    assertSearchText(needle)
    assertWellFormed(this.#model.table, column, needle)
    this.#where.push({
      kind: 'raw',
      conjunction: 'and',
      fragment: this.#containsFragment(this.#requestColumn(column), needle),
    })
    return this
  }

  /**
   * Case-insensitive, literal "starts with".
   *
   * @example
   * Post.query().whereStartsWith('slug', 'how-to')
   */
  whereStartsWith(column: string, prefix: string): this {
    assertSearchText(prefix)
    const grammar = this.#model.connection().grammar
    const ref = this.#requestColumn(column)
    assertWellFormed(this.#model.table, column, prefix)
    const folded = prefix.toLowerCase()
    // substr counts characters on every engine, so compare against the character count.
    // Built by the ORM from a checked column of this query: marked so the raw-condition guard
    // (which refuses raw SQL naming tenant tables) doesn't mistake the alias for a raw reference.
    const fragment = markScoped(
      concat(
        text(`substr(${grammar.lowerFunction}(`),
        columnSql(ref),
        text('), 1, '),
        value([...folded].length),
        text(') = '),
        grammar.textParameter(folded),
      ),
    )
    this.#where.push({ kind: 'raw', conjunction: 'and', fragment })
    return this
  }

  /**
   * Free-text search: rows where any of `columns` contains `term`, or any of `exactColumns`
   * (ids, numbers) equals it. An exact column is only compared when the term is a valid value for
   * it (`12` for an id, never `abc`), so a text search never becomes a cast error. Blank terms
   * are ignored.
   *
   * @example
   * Post.query().search(request.query.search, ['title', 'body'], ['id'])
   */
  search(term: string, columns: readonly string[], exactColumns: readonly string[] = []): this {
    const trimmed = term.trim()
    if (trimmed === '' || columns.length + exactColumns.length === 0) return this
    assertSearchText(trimmed)
    assertWellFormed(this.#model.table, 'search', trimmed)
    const nodes: WhereNode[] = columns.map((column) => ({
      kind: 'raw',
      conjunction: 'or',
      fragment: this.#containsFragment(this.#requestColumn(column), trimmed),
    }))
    for (const column of exactColumns) {
      const ref = this.#requestColumn(column)
      const bound = this.#bindIfValid(ref, trimmed)
      if (bound !== undefined)
        nodes.push({ kind: 'compare', conjunction: 'or', column: ref, operator: '=', value: bound })
    }
    // Only numeric columns, and the term is a word: nothing can match.
    if (nodes.length === 0) nodes.push({ kind: 'boolean', conjunction: 'and', value: false })
    this.#where.push({ kind: 'group', conjunction: 'and', nodes })
    return this
  }

  /**
   * One filter from the resource vocabulary (the `filterOperators` in resources.json).
   *
   * @example
   * query.filter('status', 'in', ['draft', 'published']).filter('published_on', 'null', false)
   */
  filter(column: string, operator: FilterOperator, operand: unknown): this {
    const ref = this.#requestColumn(column)
    switch (operator) {
      case 'eq':
      case 'ne':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        this.#where.push({
          kind: 'compare',
          conjunction: 'and',
          column: ref,
          operator: FILTER_SYMBOL[operator],
          value: operand === null ? null : this.#bind(ref, operand),
        })
        return this
      case 'in':
        if (!Array.isArray(operand))
          throw new OrmUsageError(
            'invalid_filter',
            `The "in" filter on "${column}" needs a list of values.`,
          )
        assertInSize(column, operand.length)
        this.#where.push({
          kind: 'in',
          conjunction: 'and',
          column: ref,
          values: operand.map((item: unknown) => this.#bind(ref, item)),
          negated: false,
        })
        return this
      case 'contains':
        return this.whereContains(column, String(operand))
      case 'startsWith':
        return this.whereStartsWith(column, String(operand))
      case 'null':
        this.#where.push({
          kind: 'null',
          conjunction: 'and',
          column: ref,
          negated: operand === false,
        })
        return this
      default:
        throw new OrmUsageError(
          'invalid_filter',
          `"${String(operator)}" is not a filter operator. Use one of: ${Object.keys(FILTER_SYMBOL).join(', ')}, in, contains, startsWith, null.`,
        )
    }
  }

  /**
   * Sort from a request-style spec: comma-separated columns, `-` for descending.
   *
   * @example
   * Post.query().sort('-created_at,title')
   */
  sort(spec: string): this {
    const parts = spec.split(',')
    if (parts.length > MAX_SORT_TERMS)
      throw new OrmUsageError('sort_too_long', `A sort may name at most ${MAX_SORT_TERMS} columns.`)
    for (const part of parts) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const descending = trimmed.startsWith('-')
      const ref = this.#requestColumn(descending ? trimmed.slice(1) : trimmed)
      this.#orderBy.push({ column: ref, direction: descending ? 'desc' : 'asc' })
    }
    return this
  }

  // -------------------------------------------------------------------------------------------
  // Ordering and limits
  // -------------------------------------------------------------------------------------------

  /**
   * Sort by a column. The direction is checked at runtime too, because it often comes from a
   * query string.
   *
   * @example
   * Post.query().orderBy('created_at', 'desc')
   */
  orderBy(column: ColumnOf<TableOf<TClass>>, direction: 'asc' | 'desc' = 'asc'): this {
    if (direction !== 'asc' && direction !== 'desc') {
      throw new OrmUsageError(
        'invalid_direction',
        `Sort direction must be "asc" or "desc", not ${JSON.stringify(direction)}.`,
      )
    }
    this.#orderBy.push({ column: this.#column(column), direction })
    return this
  }

  /**
   * Newest first (by `created_at` unless another column is given).
   *
   * @example
   * Post.query().latest().first()
   */
  latest(column: ColumnOf<TableOf<TClass>> = this.#defaultTimestamp()): this {
    return this.orderBy(column, 'desc')
  }

  /**
   * At most `count` rows.
   *
   * @example
   * Post.query().limit(10)
   */
  limit(count: number): this {
    this.#limit = assertCount('limit', count)
    return this
  }

  /**
   * Skip the first `count` rows.
   *
   * @example
   * Post.query().offset(20).limit(10)
   */
  offset(count: number): this {
    this.#offset = assertCount('offset', count)
    return this
  }

  // -------------------------------------------------------------------------------------------
  // Relations
  // -------------------------------------------------------------------------------------------

  /**
   * Eager-load relations: one extra query per relation level, whatever the number of rows.
   * Paths nest with dots. Pass an object to constrain what is loaded.
   *
   * @example
   * Post.query().with('author', 'tags')
   * User.query().with('posts.tags')
   * User.query().with({ posts: (q) => q.where('status', 'published') })
   */
  with<TPath extends RelationPath<TResult>>(
    ...paths: TPath[]
  ): QueryBuilder<TClass, WithRelations<TResult, TPath>>
  with<TName extends RelationNames<TResult>>(
    constraints: { readonly [TKey in TName]: (query: RelatedQuery<TResult, TKey>) => void },
  ): QueryBuilder<TClass, WithRelations<TResult, TName>>
  with(...args: readonly unknown[]): unknown {
    const [first] = args
    if (typeof first === 'object' && first !== null) {
      for (const [name, constrain] of Object.entries(first)) {
        if (typeof constrain !== 'function')
          throw new OrmUsageError(
            'invalid_constraint',
            `The constraint for "${name}" must be a function (query) => …`,
          )
        this.#addEagerPath(name, (query: never) => Reflect.apply(constrain, undefined, [query]))
      }
    } else {
      for (const path of args) {
        if (typeof path !== 'string')
          throw new OrmUsageError(
            'invalid_relation_path',
            'with() takes relation names such as "author" or "posts.tags".',
          )
        this.#addEagerPath(path, undefined)
      }
    }
    return this
  }

  /**
   * Add `<relation>_count` to every row, computed in the same query with a subquery.
   *
   * @example
   * const users = await User.query().withCount('posts').get() // users[0].posts_count
   */
  withCount<TName extends RelationNames<InstanceOf<TClass>>>(
    ...names: TName[]
  ): QueryBuilder<TClass, WithCounts<TResult, TName>> {
    for (const name of names) {
      // Resolve now so a typo fails here, with a suggestion, rather than at execution.
      this.#model.relation(name)
      this.#counts.push({ name, constrain: undefined })
    }
    return this.#retype<WithCounts<TResult, TName>>()
  }

  // -------------------------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------------------------

  /**
   * Include soft-deleted rows.
   *
   * @example
   * Post.query().withTrashed().find(id)
   */
  withTrashed(): this {
    this.#trashed = 'with'
    return this
  }

  /**
   * Only soft-deleted rows (the "trash").
   *
   * @example
   * Post.query().onlyTrashed().get()
   */
  onlyTrashed(): this {
    this.#trashed = 'only'
    return this
  }

  /**
   * Skip one of the model's own global scopes for this query.
   *
   * @example
   * Post.query().withoutGlobalScope('visible')
   */
  withoutGlobalScope(name: string): this {
    if (!this.#model.settings().globalScopes.has(name)) {
      throw new OrmUsageError(
        'unknown_scope',
        `${this.#model.name} has no global scope "${name}". Global scopes are listed in its static globalScopes.`,
      )
    }
    this.#withoutScopes.add(name)
    return this
  }

  /**
   * Drop the tenant filter for deliberate cross-tenant work (reports, maintenance jobs). The
   * name says what it is: on MySQL and SQLite nothing else protects the data, so it needs a
   * reason, and every use is reported to `onUnsafeTenancy` (wire it to the audit log). On
   * PostgreSQL, row-level security still limits a request-scoped connection to its tenant.
   *
   * @example
   * await Project.query().unsafeWithoutTenancy('nightly usage report').count()
   */
  unsafeWithoutTenancy(reason: string): this {
    assertReason(reason)
    ormConfig().onUnsafeTenancy({ kind: 'query', tables: [this.#model.table], reason })
    this.#tenancy = 'bypassed'
    return this
  }

  // -------------------------------------------------------------------------------------------
  // Running the query
  // -------------------------------------------------------------------------------------------

  /**
   * Run the query and return every row as a model.
   *
   * @example
   * const posts = await Post.query().where('status', 'published').get()
   */
  async get(): Promise<TResult[]> {
    const fetched = await this.fetchWithRows()
    return this.#asResults(fetched.map((item) => item.model))
  }

  /**
   * The first row, or `undefined`.
   *
   * @example
   * const newest = await Post.query().latest().first()
   */
  async first(): Promise<TResult | undefined> {
    const [row] = await this.clone().limit(1).get()
    return row
  }

  /**
   * The first row, or a {@link ModelNotFoundError} (a 404 in the HTTP layer).
   *
   * @example
   * const post = await Post.query().where('slug', slug).firstOrFail()
   */
  async firstOrFail(): Promise<TResult> {
    const row = await this.first()
    if (row === undefined) throw new ModelNotFoundError(this.#model.table)
    return row
  }

  /**
   * The row with this primary key (within the query's scopes), or `undefined`.
   *
   * @example
   * const post = await Post.query().with('author').find(7)
   */
  async find(key: KeyOf<TClass>): Promise<TResult | undefined> {
    const primaryKey = this.#model.info().primaryKey.name
    const ref = this.#column(primaryKey)
    return this.clone()
      .#push({
        kind: 'compare',
        conjunction: 'and',
        column: ref,
        operator: '=',
        value: this.#bind(ref, key),
      })
      .first()
  }

  /**
   * The row with this primary key, or a {@link ModelNotFoundError}.
   *
   * @example
   * const post = await Post.query().findOrFail(7)
   */
  async findOrFail(key: KeyOf<TClass>): Promise<TResult> {
    const row = await this.find(key)
    if (row === undefined) throw new ModelNotFoundError(this.#model.table, key)
    return row
  }

  /**
   * How many rows match (ignores order, limit and offset).
   *
   * @example
   * const drafts = await Post.query().where('status', 'draft').count()
   */
  async count(): Promise<number> {
    const ast: SelectAst = { ...this.#ast([{ kind: 'count', as: 'aggregate' }]), orderBy: [] }
    const { rows } = await this.#model
      .connection()
      .run(this.#compile(withoutPaging(ast)), this.#runOptions())
    return Number(rows[0]?.['aggregate'] ?? 0)
  }

  /**
   * Does any row match?
   *
   * @example
   * if (await Post.query().where('slug', slug).exists()) { … }
   */
  async exists(): Promise<boolean> {
    return (await this.clone().limit(1).get()).length > 0
  }

  /**
   * One page plus the total row count (for numbered pages).
   *
   * @example
   * const page = await Post.query().latest().paginate(25, 2)
   */
  async paginate(
    perPage: number = this.#model.settings().perPage,
    page = 1,
  ): Promise<Page<TResult>> {
    assertPageSize(perPage)
    if (!Number.isSafeInteger(page) || page < 1)
      throw new OrmUsageError('invalid_page', `Page numbers start at 1; got ${String(page)}.`)
    const total = await this.count()
    const data = await this.clone()
      .limit(perPage)
      .offset((page - 1) * perPage)
      .get()
    return {
      data,
      total,
      perPage,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(total / perPage)),
    }
  }

  /**
   * One page by cursor: fast and stable at any depth. Sort columns must be NOT NULL (a NULL
   * would make "rows after this one" ambiguous); the primary key is added as a tie-breaker.
   *
   * @example
   * const first = await Post.query().orderBy('created_at', 'desc').cursorPaginate(20)
   * const second = await Post.query().orderBy('created_at', 'desc').cursorPaginate(20, first.nextCursor ?? undefined)
   */
  async cursorPaginate(
    perPage: number = this.#model.settings().perPage,
    cursor?: string,
  ): Promise<CursorPage<TResult>> {
    assertPageSize(perPage)
    const orders = this.#cursorOrders()
    const fingerprint = `${this.#model.table}:${orders.map((order) => `${order.column.column}:${order.direction}`).join(',')}`
    const query = this.clone()
    query.#orderBy = orders
    if (cursor !== undefined) {
      const values = decodeCursor(cursor, fingerprint, orders.length)
      query.#fixed.push(this.#seekCondition(orders, values))
    }
    const rows = await query.limit(perPage + 1).get()
    const hasMore = rows.length > perPage
    const data = hasMore ? rows.slice(0, perPage) : rows
    const last = data.at(-1)
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor(
            fingerprint,
            orders.map((order) => cursorValue(last, order.column.column)),
          )
        : null
    return { data, perPage, nextCursor }
  }

  /**
   * The SQL this query would run, for debugging. Values stay separate (never inlined).
   *
   * @example
   * Post.query().where('status', 'draft').toSql() // { sql: 'SELECT … WHERE "posts"."status" = $1 …', params: ['draft'] }
   */
  toSql(): RenderedSql {
    const connection = this.#model.connection()
    return connection.grammar.render(this.#compile(this.#ast()))
  }

  /**
   * An independent copy of this query (scopes, relations and all).
   *
   * @example
   * const published = base.clone().where('status', 'published')
   */
  clone(): Builder<TClass, TResult> {
    const copy = new Builder<TClass, TResult>(this.#model, this.#alias)
    copy.#where = [...this.#where]
    copy.#fixed = [...this.#fixed]
    copy.#orderBy = [...this.#orderBy]
    copy.#joins = [...this.#joins]
    copy.#extraSelect = [...this.#extraSelect]
    copy.#limit = this.#limit
    copy.#offset = this.#offset
    copy.#eager = this.#eager
    copy.#counts = [...this.#counts]
    copy.#withoutScopes = new Set(this.#withoutScopes)
    copy.#trashed = this.#trashed
    copy.#tenancy = this.#tenancy
    return copy
  }

  // -------------------------------------------------------------------------------------------
  // For relations (internal API: not part of what app code is meant to call)
  // -------------------------------------------------------------------------------------------

  /** @internal Add a prepared condition node that the query's own conditions can't OR away. */
  addCondition(node: WhereNode): void {
    this.#fixed.push(node)
  }

  /** @internal Add an inner join (belongsToMany's pivot table). */
  addJoin(join: JoinNode): void {
    this.#joins.push(join)
  }

  /** @internal Select an extra column alongside the model's own (the pivot key). */
  addSelect(item: SelectItem): void {
    this.#extraSelect.push(item)
  }

  /** @internal Run a stored constraint callback against this builder. */
  applyConstraint(constrain: StoredCallback | undefined): void {
    if (constrain !== undefined) Reflect.apply(constrain, undefined, [this])
  }

  /** @internal This query as a correlated subquery (scopes applied, no paging or ordering). */
  subqueryAst(select: readonly SelectItem[]): SelectAst {
    return withoutPaging({ ...this.#ast(select), orderBy: [] })
  }

  /** @internal Run the query and keep each raw row next to its model (for pivot keys). */
  async fetchWithRows(): Promise<{ readonly model: ModelBase; readonly row: Row }[]> {
    const connection = this.#model.connection()
    const { rows } = await connection.run(this.#compile(this.#ast()), this.#runOptions())
    // Models that arrive together are remembered as "from a list", for lazy-loading detection.
    const fromList = rows.length > 1
    const fetched = rows.map((row) => ({ model: this.#hydrate(row, fromList), row }))
    await loadRelations(
      fetched.map((item) => item.model),
      this.#eager,
    )
    return fetched
  }

  // -------------------------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------------------------

  #hydrate(row: Row, fromList: boolean): ModelBase {
    const model = this.#model.hydrate(row, fromList)
    for (const { name } of this.#counts) {
      // COUNT(*) comes back as number, bigint or numeric string depending on the engine.
      setLoaded(model, `${name}_count`, Number(row[`${name}_count`] ?? 0))
    }
    return model
  }

  #push(node: WhereNode): this {
    this.#where.push(node)
    return this
  }

  /** The one place runtime models meet the static result type (the types describe these objects). */
  #asResults(models: readonly ModelBase[]): TResult[] {
    return models as unknown as TResult[]
  }

  /** Change the result type after `with`/`withCount` (same object, richer rows). */
  #retype<TNext>(): QueryBuilder<TClass, TNext> {
    return this as unknown as QueryBuilder<TClass, TNext>
  }

  #conditionFrom(conjunction: Conjunction, args: readonly unknown[]): WhereNode {
    const [first, second, third] = args
    if (typeof first === 'function') {
      const group = new Builder<TClass, TResult>(this.#model, this.#alias)
      Reflect.apply(first, undefined, [group])
      return { kind: 'group', conjunction, nodes: group.#where }
    }
    if (typeof first !== 'string')
      throw new OrmUsageError(
        'invalid_where',
        'where() takes a column name, or a function that groups conditions.',
      )
    const ref = this.#column(first)
    const operator = args.length >= 3 ? parseOperator(second) : '='
    const raw = args.length >= 3 ? third : second
    return {
      kind: 'compare',
      conjunction,
      column: ref,
      operator,
      value: raw === null ? null : this.#bind(ref, raw),
    }
  }

  /** Check a column name against the snapshot and qualify it with this query's alias. */
  #column(name: string): ColumnRef {
    if (!this.#model.info().columns.has(name))
      throw unknownColumn(this.#model.table, name, this.#visibleColumns())
    return { alias: this.#alias, column: name }
  }

  /**
   * A column named by a request (`search`, `filter`, `sort`): a hidden column answers exactly like
   * one that doesn't exist. Filtering, sorting or searching on it is an oracle even when it is never
   * returned (`filter[password][startsWith]=a`, one character at a time; security review F-03/F-13).
   */
  #requestColumn(name: string): ColumnRef {
    if (this.#model.settings().hidden.has(name))
      throw unknownColumn(this.#model.table, name, this.#visibleColumns())
    return this.#column(name)
  }

  /** Column names that may appear in hints: never a hidden one. */
  #visibleColumns(): string[] {
    const hidden = this.#model.settings().hidden
    return [...this.#model.info().columns.keys()].filter((column) => !hidden.has(column))
  }

  /** Convert a value to its stored form (booleans, dates, decimals…), so comparisons match. */
  #bind(ref: ColumnRef, value: unknown): unknown {
    const column = this.#definition(ref.column)
    // Compare in the stored form: a model cast (e.g. email normalisation) applies to the value
    // too, so 'ADMIN@x' finds the row stored as 'admin@x' and never a look-alike.
    const cast = this.#model.settings().casts.get(ref.column)
    const stored =
      cast === undefined ? value : applyCast(this.#model.table, ref.column, cast, value)
    // `nullable: true` here: a NULL comparison was handled before binding; never fail on it.
    return toDatabase(
      this.#model.table,
      { ...column, nullable: true },
      stored,
      this.#model.connection().grammar.dialect,
    )
  }

  /** {@link #bind}, or `undefined` when the value doesn't fit the column (a word for an id). */
  #bindIfValid(ref: ColumnRef, value: unknown): unknown {
    try {
      return this.#bind(ref, value)
    } catch (error) {
      if (error instanceof CastError) return undefined
      throw error
    }
  }

  #definition(name: string): ColumnDef {
    const column = this.#model.info().columns.get(name)
    if (column === undefined) throw unknownColumn(this.#model.table, name, this.#visibleColumns())
    return column
  }

  #containsFragment(ref: ColumnRef, needle: string): SqlFragment {
    const grammar = this.#model.connection().grammar
    // Fold both sides to lower case so matching is case-insensitive on every engine and collation.
    const haystack = concat(text(`${grammar.lowerFunction}(`), columnSql(ref), text(')'))
    return markScoped(
      concat(grammar.position(haystack, grammar.textParameter(needle.toLowerCase())), text(' > 0')),
    )
  }

  #defaultTimestamp(): ColumnOf<TableOf<TClass>> {
    const info = this.#model.info()
    if (!info.columns.has('created_at')) {
      throw new OrmUsageError(
        'no_timestamps',
        `"${this.#model.table}" has no created_at column; pass the column to sort by, e.g. latest('id').`,
      )
    }
    return toColumnName<TClass>('created_at')
  }

  #addEagerPath(path: string, constrain: StoredCallback | undefined): void {
    const names = path.split('.')
    // Resolve the first level now, so a typo fails at with() with a suggestion.
    const [head] = names
    if (head === undefined || head === '')
      throw new OrmUsageError('invalid_relation_path', `"${path}" is not a relation path.`)
    this.#model.relation(head)
    let level = this.#eager
    names.forEach((name, index) => {
      let node = level.get(name)
      if (node === undefined) {
        node = { constrain: undefined, children: new Map() }
        level.set(name, node)
      }
      // A constraint applies to the last relation in the path.
      if (index === names.length - 1 && constrain !== undefined) node.constrain = constrain
      level = node.children
    })
  }

  #installScopes(): void {
    for (const [name, scope] of this.#model.settings().scopes) {
      Object.defineProperty(this, name, {
        enumerable: false,
        value: (...args: readonly unknown[]) => {
          Reflect.apply(scope, undefined, [this, ...args])
          return this
        },
      })
    }
  }

  /** Conditions the model always adds: tenant, soft deletes, its own global scopes. */
  #scopeConditions(): WhereNode[] {
    const info = this.#model.info()
    const conditions: WhereNode[] = []
    if (this.#tenancy === 'scoped') {
      // Throws for "no active tenant" and for tables tenancy cannot protect (fail closed).
      const tenant = tenantCondition(this.#model.table, this.#alias)
      if (tenant !== undefined) conditions.push(tenant)
    }
    if (info.softDeletes && this.#trashed !== 'with') {
      conditions.push({
        kind: 'null',
        conjunction: 'and',
        column: { alias: this.#alias, column: 'deleted_at' },
        negated: this.#trashed === 'only',
      })
    }
    for (const [name, scope] of this.#model.settings().globalScopes) {
      if (this.#withoutScopes.has(name)) continue
      const group = new Builder<TClass, TResult>(this.#model, this.#alias)
      Reflect.apply(scope, undefined, [group])
      conditions.push({ kind: 'group', conjunction: 'and', nodes: group.#where })
    }
    return conditions
  }

  #ast(select?: readonly SelectItem[]): SelectAst {
    const scopes = this.#scopeConditions()
    // The developer's conditions go in parentheses before the framework's own conditions and the
    // scopes are AND-ed on (see the header).
    const own: WhereNode[] =
      this.#where.length > 0 && scopes.length + this.#fixed.length > 0
        ? [{ kind: 'group', conjunction: 'and', nodes: this.#where }]
        : this.#where
    const counts: SelectItem[] = this.#counts.map(({ name, constrain }) => ({
      kind: 'subquery',
      query: this.#model
        .relation(name)
        .subquery(this.#alias, `${this.#alias}__${name}_count`, constrain, 'count'),
      as: `${name}_count`,
    }))
    return {
      table: this.#model.table,
      alias: this.#alias,
      select: select ?? [{ kind: 'all', alias: this.#alias }, ...this.#extraSelect, ...counts],
      joins: this.#joins,
      where: [...this.#fixed, ...own, ...scopes],
      orderBy: this.#orderBy,
      ...(this.#limit === undefined ? {} : { limit: this.#limit }),
      ...(this.#offset === undefined ? {} : { offset: this.#offset }),
    }
  }

  /** Tenant statements tell the connection their tenant, so Postgres can set it for RLS. */
  #runOptions(): { readonly tenantId?: string } {
    const tenant = currentTenant()
    return tenantMode(this.#model.table) === 'scoped' && tenant !== undefined
      ? { tenantId: tenant }
      : {}
  }

  /** The single exit to SQL: check every tenant reference in the tree, then compile. */
  #compile(ast: SelectAst): SqlFragment {
    assertSelectScoped(ast, this.#tenancy === 'bypassed' ? new Set([this.#alias]) : new Set())
    return markScoped(compileSelect(ast, this.#model.connection().grammar))
  }

  #cursorOrders(): OrderNode[] {
    const primaryKey = this.#model.info().primaryKey.name
    const orders: OrderNode[] =
      this.#orderBy.length > 0
        ? [...this.#orderBy]
        : [{ column: this.#column(primaryKey), direction: 'asc' }]
    const last = orders.at(-1)
    if (!orders.some((order) => order.column.column === primaryKey)) {
      // The primary key breaks ties, so rows with equal sort values are never skipped or repeated.
      orders.push({ column: this.#column(primaryKey), direction: last?.direction ?? 'asc' })
    }
    const hidden = this.#model.settings().hidden
    for (const order of orders) {
      // The cursor carries the last row's sort values to the client: a hidden column there would
      // hand out its value (a password hash, a token) in every nextCursor.
      if (hidden.has(order.column.column)) {
        throw new OrmUsageError(
          'cursor_hidden_column',
          `cursorPaginate() can't sort by "${order.column.column}": it is hidden, and the page cursor would reveal its values. Sort by a visible column, or use paginate().`,
        )
      }
      if (this.#definition(order.column.column).nullable) {
        throw new OrmUsageError(
          'cursor_nullable_column',
          `cursorPaginate() can't sort by "${order.column.column}" because it can be NULL. Sort by a NOT NULL column, or use paginate().`,
        )
      }
    }
    return orders
  }

  /** `(a > x) OR (a = x AND b > y) OR …`: the rows after the cursor, for any mix of directions. */
  #seekCondition(orders: readonly OrderNode[], values: readonly CursorValue[]): WhereNode {
    const branches: WhereNode[] = orders.map((order, index) => {
      const equalities: WhereNode[] = orders.slice(0, index).map((previous, previousIndex) => ({
        kind: 'compare',
        conjunction: 'and',
        column: previous.column,
        operator: '=',
        value: this.#bind(previous.column, values[previousIndex]),
      }))
      const step: WhereNode = {
        kind: 'compare',
        conjunction: 'and',
        column: order.column,
        operator: order.direction === 'desc' ? '<' : '>',
        value: this.#bind(order.column, values[index]),
      }
      return { kind: 'group', conjunction: 'or', nodes: [...equalities, step] }
    })
    return { kind: 'group', conjunction: 'and', nodes: branches }
  }
}

/**
 * Load relation trees for models that are already in memory: one query per relation level.
 *
 * @example
 * await loadRelations(posts, parseRelationPaths(['author', 'tags']))
 */
export async function loadRelations(models: readonly ModelBase[], tree: EagerTree): Promise<void> {
  const [first] = models
  if (first === undefined) return
  const runtime = first.runtime()
  for (const [name, node] of tree) {
    const loaded = await runtime.relation(name).eagerLoad(models, name, node.constrain)
    if (node.children.size > 0) await loadRelations(loaded, node.children)
  }
}

/**
 * Turn `['author', 'posts.tags']` into an eager-loading tree.
 *
 * @example
 * parseRelationPaths(['posts.tags']).get('posts')?.children.has('tags') // true
 */
export function parseRelationPaths(paths: readonly string[]): EagerTree {
  const tree: EagerTree = new Map()
  for (const path of paths) {
    let level = tree
    for (const name of path.split('.')) {
      let node = level.get(name)
      if (node === undefined) {
        node = { constrain: undefined, children: new Map() }
        level.set(name, node)
      }
      level = node.children
    }
  }
  return tree
}

function parseOperator(raw: unknown): CompareOperator {
  if (typeof raw === 'string' && OPERATORS.has(raw)) return toOperator(raw)
  throw new OrmUsageError(
    'invalid_operator',
    `${JSON.stringify(raw)} is not a supported operator. Use one of: ${[...OPERATORS].join(' ')}. For text search use whereRaw with the sql tag.`,
  )
}

/** Narrow a string already checked against {@link OPERATORS}. */
function toOperator(raw: string): CompareOperator {
  switch (raw) {
    case '!=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return raw
    default:
      return '='
  }
}

/** A column name the code has checked exists, retyped for the builder's column parameter. */
function toColumnName<TClass extends AnyModelClass>(name: string): ColumnOf<TableOf<TClass>> {
  return name as ColumnOf<TableOf<TClass>>
}

function withoutPaging(ast: SelectAst): SelectAst {
  const { limit: _limit, offset: _offset, ...rest } = ast
  return rest
}

/** One statement per list: refuse lists longer than `maxInValues` before any SQL is built. */
function assertInSize(column: string, size: number): void {
  const max = ormConfig().maxInValues
  if (size > max) {
    throw new OrmUsageError(
      'too_many_values',
      `An "in" list on "${column}" may hold at most ${max} values; got ${size}. Split the work into smaller lists, or raise the limit with configureOrm({ maxInValues }).`,
    )
  }
}

/** Search and text filters bind the text as-is (not through a column cast): refuse a lone surrogate there too. */
/** Request text matched with contains / starts-with / search: bounded, like every request input. */
function assertSearchText(text: string): void {
  if (text.length > MAX_SEARCH_LENGTH)
    throw new OrmUsageError(
      'search_too_long',
      `Search text is limited to ${MAX_SEARCH_LENGTH} characters.`,
    )
}

function assertWellFormed(table: string, column: string, text: string): void {
  if (!text.isWellFormed())
    throw new CastError(table, column, 'the text contains malformed Unicode (a lone surrogate)')
}

function assertCount(what: string, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new OrmUsageError(
      'invalid_count',
      `${what}() needs a whole number of 0 or more; got ${String(count)}.`,
    )
  return count
}

function assertPageSize(perPage: number): void {
  const max = ormConfig().maxPerPage
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > max) {
    throw new OrmUsageError(
      'invalid_page_size',
      `Page size must be between 1 and ${max}; got ${String(perPage)}. Raise the limit with configureOrm({ maxPerPage }).`,
    )
  }
}

function unknownColumn(table: string, name: string, columns: Iterable<string>): OrmUsageError {
  const suggestion = closest(name, columns)
  const hint = suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`
  return new OrmUsageError(
    'unknown_column',
    `"${table}" has no column "${name}".${hint} Columns come from your migrations.`,
  )
}

/** A row's sort value in cursor form (dates as ISO strings). */
function cursorValue(model: unknown, column: string): CursorValue {
  const value: unknown =
    typeof model === 'object' && model !== null ? Reflect.get(model, column) : undefined
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value
  throw new CastError(
    'cursor',
    column,
    'only text, numbers, booleans and dates can be cursor columns',
  )
}
