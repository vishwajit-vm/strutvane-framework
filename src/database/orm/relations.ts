/**
 * Relations: `belongsTo`, `hasMany`, `belongsToMany`.
 *
 * A relation is two things at once, exactly like in Eloquent:
 * - **a query** for one parent's related rows: `await user.posts().where('status', 'draft').get()`
 *   (each relation class extends the query builder with the parent constraint applied);
 * - **a recipe** the builder uses for many parents at once: eager loading (`with`), counts
 *   (`withCount`) and existence checks (`whereHas`). These always run one query per relation, so
 *   loading authors for 1,000 posts is two queries, not 1,001.
 */
import { tableColumns } from '../schema/registry.ts'
import { toDatabase } from './casts.ts'
import type { ColumnRef, SelectAst, SelectItem, WhereNode } from '../sql/ast.ts'
import { compileDelete, compileInsert } from '../sql/compile.ts'
import { Builder } from './builder.ts'
import { ModelNotFoundError, OrmUsageError } from './errors.ts'
import type { ModelBase } from './model.ts'
import { attribute, type ModelRuntime, RELATION_BRAND, type RelationContract, type StoredCallback, setLoaded } from './runtime.ts'
import { currentTenant } from './tenancy.ts'
import { assertInsertScoped, assertWriteScoped, markScoped, requireTenant, tenantColumn, tenantCondition, tenantMode } from './tenant-scope.ts'
import { type AnyModelClass, type CreateInput, type InstanceOf, type KeyOf, type OptionsOf, RELATION_TYPES, type RelationTypes, type ScopeMethods, type TableOf } from './types.ts'

/**
 * Parent keys per eager query. Postgres allows 65,535 parameters and SQLite 32,766; 1,000 keeps
 * statements small and plans stable. Above it, a relation costs one query per 1,000 parents.
 */
const KEYS_PER_QUERY = 1000

/** `post.author()`: this row points at one row of `related`. */
export type BelongsTo<TRelated extends AnyModelClass> = BelongsToRelation<TRelated> & ScopeMethods<TRelated, InstanceOf<TRelated>>
/** `user.posts()`: rows of `related` point at this row. */
export type HasMany<TRelated extends AnyModelClass> = HasManyRelation<TRelated> & ScopeMethods<TRelated, InstanceOf<TRelated>>
/** `post.tags()`: rows linked through a pivot table. */
export type BelongsToMany<TRelated extends AnyModelClass> = BelongsToManyRelation<TRelated> & ScopeMethods<TRelated, InstanceOf<TRelated>>

/**
 * The "belongs to" side: `posts.author_id → users.id`.
 *
 * @example
 * author() { return this.belongsTo(User, 'author_id') }
 */
export class BelongsToRelation<TRelated extends AnyModelClass> extends Builder<TRelated, InstanceOf<TRelated>> implements RelationContract {
  declare readonly [RELATION_TYPES]: RelationTypes<TRelated, false>
  readonly [RELATION_BRAND] = true as const
  readonly #related: ModelRuntime
  readonly #foreignKey: string
  readonly #ownerKey: string

  constructor(parent: ModelBase, related: ModelRuntime, foreignKey: string, ownerKey: string) {
    super(related)
    assertColumn(parent.runtime().table, foreignKey)
    assertColumn(related.table, ownerKey)
    this.#related = related
    this.#foreignKey = foreignKey
    this.#ownerKey = ownerKey
    this.addCondition(matchOne({ alias: related.table, column: ownerKey }, attribute(parent, foreignKey)))
  }

  async eagerLoad(parents: readonly ModelBase[], name: string, constrain: StoredCallback | undefined): Promise<ModelBase[]> {
    const byKey = new Map<string, ModelBase>()
    for (const keys of chunks(distinctKeys(parents, this.#foreignKey))) {
      const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related)
      query.addCondition({ kind: 'in', conjunction: 'and', column: { alias: this.#related.table, column: this.#ownerKey }, values: keys, negated: false })
      query.applyConstraint(constrain)
      for (const { model } of await query.fetchWithRows()) byKey.set(keyText(attribute(model, this.#ownerKey)), model)
    }
    for (const parent of parents) setLoaded(parent, name, byKey.get(keyText(attribute(parent, this.#foreignKey))) ?? null)
    return [...byKey.values()]
  }

  subquery(parentAlias: string, alias: string, constrain: StoredCallback | undefined, kind: 'count' | 'exists'): SelectAst {
    const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related, alias)
    query.addCondition({ kind: 'columns', conjunction: 'and', left: { alias, column: this.#ownerKey }, right: { alias: parentAlias, column: this.#foreignKey } })
    query.applyConstraint(constrain)
    return query.subqueryAst(selectFor(kind, alias))
  }
}

/**
 * The "has many" side: `users.id ← posts.author_id`.
 *
 * @example
 * posts() { return this.hasMany(Post, 'author_id') }
 */
export class HasManyRelation<TRelated extends AnyModelClass> extends Builder<TRelated, InstanceOf<TRelated>> implements RelationContract {
  declare readonly [RELATION_TYPES]: RelationTypes<TRelated, true>
  readonly [RELATION_BRAND] = true as const
  readonly #parent: ModelBase
  readonly #related: ModelRuntime
  readonly #foreignKey: string
  readonly #localKey: string

  constructor(parent: ModelBase, related: ModelRuntime, foreignKey: string, localKey: string) {
    super(related)
    assertColumn(related.table, foreignKey)
    assertColumn(parent.runtime().table, localKey)
    this.#parent = parent
    this.#related = related
    this.#foreignKey = foreignKey
    this.#localKey = localKey
    this.addCondition(matchOne({ alias: related.table, column: foreignKey }, attribute(parent, localKey)))
  }

  /**
   * Create a related row pointing at this parent. The foreign key is set by the relation, so it
   * does not need to be fillable (and a client can never point the row elsewhere).
   *
   * @example
   * const post = await user.posts().create({ title: 'Hello' })
   */
  async create(input: CreateInput<TableOf<TRelated>, OptionsOf<TRelated>>): Promise<InstanceOf<TRelated>> {
    const parentKey = attribute(this.#parent, this.#localKey)
    if (parentKey === undefined || parentKey === null) {
      throw new OrmUsageError('PARENT_NOT_SAVED', `Save the ${this.#parent.runtime().name} first: it has no ${this.#localKey} yet, so the new row has nothing to point at.`)
    }
    const model = this.#related.make()
    model.fill(input)
    model.setAttribute(this.#foreignKey, parentKey)
    await model.save()
    return asInstance<TRelated>(model)
  }

  async eagerLoad(parents: readonly ModelBase[], name: string, constrain: StoredCallback | undefined): Promise<ModelBase[]> {
    const groups = new Map<string, ModelBase[]>()
    const loaded: ModelBase[] = []
    for (const keys of chunks(distinctKeys(parents, this.#localKey))) {
      const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related)
      query.addCondition({ kind: 'in', conjunction: 'and', column: { alias: this.#related.table, column: this.#foreignKey }, values: keys, negated: false })
      query.applyConstraint(constrain)
      for (const { model } of await query.fetchWithRows()) {
        addToGroup(groups, keyText(attribute(model, this.#foreignKey)), model)
        loaded.push(model)
      }
    }
    for (const parent of parents) setLoaded(parent, name, groups.get(keyText(attribute(parent, this.#localKey))) ?? [])
    return loaded
  }

  subquery(parentAlias: string, alias: string, constrain: StoredCallback | undefined, kind: 'count' | 'exists'): SelectAst {
    const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related, alias)
    query.addCondition({ kind: 'columns', conjunction: 'and', left: { alias, column: this.#foreignKey }, right: { alias: parentAlias, column: this.#localKey } })
    query.applyConstraint(constrain)
    return query.subqueryAst(selectFor(kind, alias))
  }
}

/**
 * Many-to-many through a pivot table: `posts ← post_tag → tags`.
 *
 * @example
 * tags() { return this.belongsToMany(Tag, 'post_tag') } // keys default to post_id / tag_id
 */
export class BelongsToManyRelation<TRelated extends AnyModelClass> extends Builder<TRelated, InstanceOf<TRelated>> implements RelationContract {
  declare readonly [RELATION_TYPES]: RelationTypes<TRelated, true>
  readonly [RELATION_BRAND] = true as const
  readonly #parent: ModelBase
  readonly #related: ModelRuntime
  readonly #pivot: string
  readonly #foreignPivotKey: string
  readonly #relatedPivotKey: string

  constructor(parent: ModelBase, related: ModelRuntime, pivot: string, foreignPivotKey: string, relatedPivotKey: string) {
    super(related)
    const pivotColumns = tableColumns(pivot)
    for (const column of [foreignPivotKey, relatedPivotKey]) {
      if (!pivotColumns.has(column)) {
        throw new OrmUsageError('UNKNOWN_PIVOT_COLUMN', `The pivot table "${pivot}" has no column "${column}". Pass the key names: belongsToMany(${related.name}, '${pivot}', 'parent_key', 'related_key').`)
      }
    }
    this.#parent = parent
    this.#related = related
    this.#pivot = pivot
    this.#foreignPivotKey = foreignPivotKey
    this.#relatedPivotKey = relatedPivotKey
    this.addJoin(this.#pivotJoin(related.table, pivot))
    this.addCondition(matchOne({ alias: pivot, column: foreignPivotKey }, attribute(parent, 'id')))
    // A pivot between tenant tables carries the tenant column; scope it too. Outside a tenant
    // context nothing is added here, and the scope check refuses the query when it runs.
    if (tenantMode(pivot) === 'scoped' && currentTenant() !== undefined) this.#addPivotScope(this, pivot)
  }

  /**
   * Link related rows (insert pivot rows). Already-linked ids are skipped, so retries are safe.
   *
   * Every id must name a row the caller can see (same tenant, not filtered out by scopes): it is
   * checked with a scoped query in the same transaction. Otherwise tenant A could link tenant B's
   * rows and then use counts and `whereHas` as an oracle about them (security review F-05).
   * An id that is not visible fails as "not found", exactly like a missing one.
   *
   * @example
   * await post.tags().attach([news.id, tech.id])
   */
  async attach(rawIds: readonly KeyOf<TRelated>[]): Promise<void> {
    const ids = this.#keys(rawIds)
    const connection = this.#related.connection()
    await connection.transaction(async () => {
      const parentKey = this.#parentKey()
      await this.#assertVisible(ids)
      const existing = new Set((await this.#linkedIds(parentKey)).map(keyText))
      for (const id of ids) {
        if (existing.has(keyText(id))) continue
        await this.#insertPivot(parentKey, id)
        existing.add(keyText(id))
      }
    })
  }

  /**
   * Unlink related rows (delete pivot rows); with no ids, unlink all of them.
   *
   * @example
   * await post.tags().detach([news.id])
   */
  async detach(rawIds?: readonly KeyOf<TRelated>[]): Promise<number> {
    const ids = rawIds === undefined ? undefined : this.#keys(rawIds)
    const parentKey = this.#parentKey()
    const connection = this.#related.connection()
    const where: WhereNode[] = [{ kind: 'compare', conjunction: 'and', column: { alias: this.#pivot, column: this.#foreignPivotKey }, operator: '=', value: parentKey }]
    if (ids !== undefined) where.push({ kind: 'in', conjunction: 'and', column: { alias: this.#pivot, column: this.#relatedPivotKey }, values: ids, negated: false })
    const scope = this.#pivotCondition(this.#pivot)
    if (scope !== undefined) where.push(scope)
    assertWriteScoped(this.#pivot, where)
    const { rowsAffected } = await connection.run(markScoped(compileDelete(this.#pivot, where, connection.grammar)), this.#runOptions())
    return rowsAffected
  }

  /**
   * Make the links exactly `ids`: attach the missing ones, detach the rest, in one transaction.
   *
   * @example
   * await post.tags().sync([news.id])
   */
  async sync(rawIds: readonly KeyOf<TRelated>[]): Promise<{ readonly attached: number; readonly detached: number }> {
    const ids = this.#keys(rawIds)
    const connection = this.#related.connection()
    return connection.transaction(async () => {
      const wanted = new Set(ids.map(keyText))
      const current = await this.#linkedIds(this.#parentKey())
      const toDetach = current.filter((id) => !wanted.has(keyText(id)))
      const currentText = new Set(current.map(keyText))
      const toAttach = ids.filter((id) => !currentText.has(keyText(id)))
      if (toDetach.length > 0) await this.detach(asKeys<TRelated>(toDetach))
      await this.attach(toAttach)
      return { attached: toAttach.length, detached: toDetach.length }
    })
  }

  async eagerLoad(parents: readonly ModelBase[], name: string, constrain: StoredCallback | undefined): Promise<ModelBase[]> {
    const groups = new Map<string, ModelBase[]>()
    const loaded: ModelBase[] = []
    for (const keys of chunks(distinctKeys(parents, 'id'))) {
      const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related)
      query.addJoin(this.#pivotJoin(this.#related.table, this.#pivot))
      query.addCondition({ kind: 'in', conjunction: 'and', column: { alias: this.#pivot, column: this.#foreignPivotKey }, values: keys, negated: false })
      // The pivot key tells us which parent each related row belongs to.
      query.addSelect({ kind: 'column', column: { alias: this.#pivot, column: this.#foreignPivotKey }, as: 'sv_pivot_parent' })
      this.#addPivotScope(query, this.#pivot)
      query.applyConstraint(constrain)
      for (const { model, row } of await query.fetchWithRows()) {
        addToGroup(groups, keyText(row['sv_pivot_parent']), model)
        loaded.push(model)
      }
    }
    for (const parent of parents) setLoaded(parent, name, groups.get(keyText(attribute(parent, 'id'))) ?? [])
    return loaded
  }

  subquery(parentAlias: string, alias: string, constrain: StoredCallback | undefined, kind: 'count' | 'exists'): SelectAst {
    const pivotAlias = `${alias}_pivot`
    const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related, alias)
    query.addJoin({ table: this.#pivot, alias: pivotAlias, left: { alias, column: 'id' }, right: { alias: pivotAlias, column: this.#relatedPivotKey } })
    query.addCondition({ kind: 'columns', conjunction: 'and', left: { alias: pivotAlias, column: this.#foreignPivotKey }, right: { alias: parentAlias, column: 'id' } })
    this.#addPivotScope(query, pivotAlias)
    query.applyConstraint(constrain)
    return query.subqueryAst(selectFor(kind, alias))
  }

  /**
   * Check and convert ids against the related primary key's type, before any SQL (the same typed
   * binds as everywhere else, security review F-08). Without it, MySQL compared '7abc' = 7 and
   * detached the wrong row, and objects and lists reached the driver.
   */
  #keys(ids: readonly KeyOf<TRelated>[]): readonly KeyOf<TRelated>[] {
    const primaryKey = this.#related.info().primaryKey
    const dialect = this.#related.connection().grammar.dialect
    return asKeys<TRelated>(ids.map((id) => toDatabase(this.#related.table, { ...primaryKey, nullable: false }, id, dialect)))
  }

  /** The tenant condition for the pivot table under `alias` (none for global pivots). */
  #pivotCondition(alias: string): WhereNode | undefined {
    return tenantMode(this.#pivot) === 'global' ? undefined : tenantCondition(this.#pivot, alias)
  }

  #addPivotScope(query: Builder<TRelated, InstanceOf<TRelated>>, alias: string): void {
    const condition = this.#pivotCondition(alias)
    if (condition !== undefined) query.addCondition(condition)
  }

  /** Every id must be a row of the related model the caller can see right now. */
  async #assertVisible(ids: readonly KeyOf<TRelated>[]): Promise<void> {
    const wanted = new Set(ids.map(keyText))
    if (wanted.size === 0) return
    const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related)
    query.addCondition({ kind: 'in', conjunction: 'and', column: { alias: this.#related.table, column: 'id' }, values: ids, negated: false })
    const visible = new Set((await query.fetchWithRows()).map(({ model }) => keyText(attribute(model, 'id'))))
    for (const id of wanted) if (!visible.has(id)) throw new ModelNotFoundError(this.#related.table, id)
  }

  async #insertPivot(parentKey: unknown, id: unknown): Promise<void> {
    const connection = this.#related.connection()
    const record: Record<string, unknown> = { [this.#foreignPivotKey]: parentKey, [this.#relatedPivotKey]: id }
    const column = tenantColumn()
    if (tenantMode(this.#pivot) === 'scoped' && column !== undefined) record[column] = requireTenant(this.#pivot)
    assertInsertScoped(this.#pivot, record)
    await connection.run(markScoped(compileInsert(this.#pivot, record, connection.grammar)), this.#runOptions())
  }

  #runOptions(): { readonly tenantId?: string } {
    const tenant = currentTenant()
    return tenantMode(this.#pivot) === 'scoped' && tenant !== undefined ? { tenantId: tenant } : {}
  }

  #pivotJoin(relatedAlias: string, pivotAlias: string): { table: string; alias: string; left: ColumnRef; right: ColumnRef } {
    return { table: this.#pivot, alias: pivotAlias, left: { alias: relatedAlias, column: 'id' }, right: { alias: pivotAlias, column: this.#relatedPivotKey } }
  }

  #parentKey(): unknown {
    const key = attribute(this.#parent, 'id')
    if (key === undefined || key === null) throw new OrmUsageError('PARENT_NOT_SAVED', `Save the ${this.#parent.runtime().name} before linking rows to it.`)
    return key
  }

  async #linkedIds(parentKey: unknown): Promise<unknown[]> {
    // withTrashed: a soft-deleted related row is still linked, and must not be inserted twice.
    const query = new Builder<TRelated, InstanceOf<TRelated>>(this.#related).withTrashed()
    query.addJoin(this.#pivotJoin(this.#related.table, this.#pivot))
    query.addCondition({ kind: 'compare', conjunction: 'and', column: { alias: this.#pivot, column: this.#foreignPivotKey }, operator: '=', value: parentKey })
    this.#addPivotScope(query, this.#pivot)
    const rows = await query.fetchWithRows()
    return rows.map(({ model }) => attribute(model, 'id'))
  }
}

/** `column = value`, or "matches nothing" when the parent has no key yet. */
function matchOne(column: ColumnRef, value: unknown): WhereNode {
  if (value === undefined || value === null) return { kind: 'boolean', conjunction: 'and', value: false }
  return { kind: 'compare', conjunction: 'and', column, operator: '=', value }
}

function selectFor(kind: 'count' | 'exists', alias: string): SelectItem[] {
  return kind === 'count' ? [{ kind: 'count', as: 'aggregate' }] : [{ kind: 'all', alias }]
}

function assertColumn(table: string, column: string): void {
  if (!tableColumns(table).has(column)) {
    throw new OrmUsageError('UNKNOWN_RELATION_KEY', `"${table}" has no column "${column}" for this relation. Pass the right key name to the relation method.`)
  }
}

/** Distinct non-null key values (as stored), in first-seen order. */
function distinctKeys(models: readonly ModelBase[], column: string): unknown[] {
  const seen = new Map<string, unknown>()
  for (const model of models) {
    const value = attribute(model, column)
    if (value !== null && value !== undefined && !seen.has(keyText(value))) seen.set(keyText(value), value)
  }
  return [...seen.values()]
}

function* chunks<TItem>(items: readonly TItem[]): Generator<readonly TItem[]> {
  for (let start = 0; start < items.length; start += KEYS_PER_QUERY) yield items.slice(start, start + KEYS_PER_QUERY)
}

/** Keys compared as text, so `7`, `7n` and `'7'` from different drivers match each other. */
function keyText(value: unknown): string {
  return String(value)
}

function addToGroup(groups: Map<string, ModelBase[]>, key: string, model: ModelBase): void {
  const group = groups.get(key)
  if (group === undefined) groups.set(key, [model])
  else group.push(model)
}

/** Runtime models meet the static types here (a freshly saved model of the related class). */
function asInstance<TRelated extends AnyModelClass>(model: ModelBase): InstanceOf<TRelated> {
  return model as unknown as InstanceOf<TRelated>
}

/** Ids read back from the database are the related keys; retype them for `detach`. */
function asKeys<TRelated extends AnyModelClass>(ids: readonly unknown[]): readonly KeyOf<TRelated>[] {
  return ids as readonly KeyOf<TRelated>[]
}
