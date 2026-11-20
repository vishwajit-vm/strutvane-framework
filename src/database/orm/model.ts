// biome-ignore-all lint/complexity/noThisInStatic: Eloquent-style statics use `this` so Post.query() builds a query for Post, not for the base class.
/**
 * The model: Strutvane's Eloquent `Model`, as an active-record class in `app/models`.
 *
 * ```ts
 * export class Post extends Model('posts', { fillable: ['title', 'body'], casts: { meta: json<PostMeta>() } }) {
 *   static scopes = { published: (q) => q.where('status', 'published') } satisfies Scopes<'posts'>
 *   author() { return this.belongsTo(User, 'author_id') }
 *   tags() { return this.belongsToMany(Tag, 'post_tag') }
 *   get isPublished() { return this.status === 'published' }
 * }
 * ```
 *
 * Why `Model('posts', …)` (a function call) and not `Model<'posts'>`: a class can only get
 * per-column properties (`post.title: string`) from a base class whose constructor type already
 * has them. A generic class cannot add properties named by a type parameter; a function that
 * returns a precisely typed class can. The columns come from the generated table types, so the
 * model file never repeats them, and renaming a column in a migration breaks every use of the
 * old name at compile time.
 *
 * At runtime there is one real class, {@link ModelBase}; `Model()` makes a tiny subclass that
 * knows its table and options.
 */

import { isHiddenColumn, isPrivilegeColumn, isSecretColumn } from '../../schema/columns.ts'
import type { Connection } from '../db/connection.ts'
import type { Row } from '../db/driver.ts'
import { assertConnectionName, connectionNamed } from '../db/manager.ts'
import {
  type ColumnOf,
  SYSTEM_COLUMNS,
  type TableInfo,
  type TableName,
  tableInfo,
} from '../schema/registry.ts'
import type { ColumnDef } from '../schema/snapshot.ts'
import type { WhereNode } from '../sql/ast.ts'
import { compileDelete, compileInsert, compileUpdate } from '../sql/compile.ts'
import { assertIdentifier, sql } from '../sql/fragment.ts'
import { Builder, loadRelations, parseRelationPaths } from './builder.ts'
import { applyCast, type Cast, fromDatabase, toDatabase } from './casts.ts'
import { ormConfig } from './config.ts'
import {
  LazyLoadingError,
  MassAssignmentError,
  ModelNotFoundError,
  OrmUsageError,
  TenantMismatchError,
} from './errors.ts'
import { currentModelEvents, type ModelEventVerb, modelEventName } from './events.ts'
import { uuidv7 } from './keys.ts'
import {
  type BelongsTo,
  type BelongsToMany,
  BelongsToManyRelation,
  BelongsToRelation,
  type HasMany,
  HasManyRelation,
} from './relations.ts'
import {
  attribute,
  isModelRuntime,
  isRelation,
  type ModelRuntime,
  type ModelSettings,
  type RelationContract,
  type StoredCallback,
} from './runtime.ts'
import { nextFreeSlug, slugify } from './slug.ts'
import { closest } from './suggest.ts'
import { currentTenant } from './tenancy.ts'
import {
  assertInsertScoped,
  assertWriteScoped,
  markScoped,
  requireTenant,
  tenantColumn,
  tenantCondition,
  tenantMode,
} from './tenant-scope.ts'
import type {
  AnyModelClass,
  Attributes,
  ColumnValue,
  CreateInput,
  ForceCreateInput,
  InstanceOf,
  JsonOf,
  KeyOf,
  ModelMarker,
  ModelOptions,
  NoOptions,
  OptionsOf,
  QueryBuilder,
  RelationPath,
  TableOf,
  WithRelations,
} from './types.ts'

/** Model options as the runtime sees them (the typed version is {@link ModelOptions}). */
interface RuntimeOptions {
  readonly fillable?: readonly string[]
  readonly allowSensitive?: readonly string[]
  readonly hidden?: readonly string[]
  readonly casts?: Readonly<Record<string, Cast<unknown> | undefined>>
  readonly perPage?: number
  readonly connection?: string
}

/** Columns Strutvane fills itself: keys, timestamps, soft deletes and the configured tenant column. */
function isSystemColumn(column: string): boolean {
  return (
    column === 'id' ||
    column === tenantColumn() ||
    Object.values<string>(SYSTEM_COLUMNS).includes(column)
  )
}
const SLUG_ATTEMPTS = 5
const settingsCache = new WeakMap<object, ModelSettings>()
/** `Post.on('archive')`, made once per model class and connection name. */
const boundCache = new WeakMap<object, Map<string, typeof ModelBase>>()
const relationCache = new WeakMap<object, Map<string, RelationContract>>()

/**
 * The runtime class behind every model. App code never extends it directly; it extends
 * `Model('table', options)`, which gives it its types.
 *
 * @example
 * post instanceof ModelBase // true
 */
export class ModelBase {
  /** Brand checked by {@link isModelRuntime}. */
  static readonly '~strutvane.model': true = true
  /** The table, set by `Model()`. */
  static readonly table: string = ''
  /** The options given to `Model()`. */
  static readonly options: RuntimeOptions = {}

  /** Column values as last read from / written to the database, in comparable form. */
  #original: Record<string, unknown> = {}
  #persisted = false
  /** Arrived in a multi-row result: loading a relation on it alone is the N+1 pattern. */
  #fromList = false

  // -------------------------------------------------------------------------------------------
  // Static side: what `Post.something()` does
  // -------------------------------------------------------------------------------------------

  /**
   * Facts about this model's table, from the schema snapshot.
   *
   * @example
   * Post.info().softDeletes // true
   */
  static info(): TableInfo {
    return tableInfo(this.table)
  }

  /**
   * The model's options, validated once (friendly errors for typos and dangerous settings).
   *
   * @example
   * Post.settings().fillable?.has('title') // true
   */
  static settings(): ModelSettings {
    const cached = settingsCache.get(this)
    if (cached !== undefined) return cached
    const settings = buildSettings(
      this.name,
      this.info(),
      this.options,
      readStatic(this, 'scopes'),
      readStatic(this, 'globalScopes'),
    )
    settingsCache.set(this, settings)
    return settings
  }

  /** Set on the subclasses {@link ModelBase.on} makes: the connection they are bound to. */
  static readonly boundConnection: string | undefined = undefined

  /**
   * The connection this model uses: the one `on()` bound it to, else its `connection` option
   * (Laravel's `$connection`), else the default `DB_*` connection. Resolved on every call, so a
   * request always gets its own application's connection.
   *
   * @example
   * Post.connection().inTransaction()
   */
  static connection(): Connection {
    return connectionNamed(this.boundConnection ?? this.options.connection)
  }

  /**
   * This model on another connection, for the queries and saves made through it (Laravel's
   * `Post::on('archive')`). It is a subclass of the model, so instances are still `instanceof
   * Post`, and every query, save, `afterCommit` and model event uses `name`. Relations keep their
   * own models' connections. Made once per model and name.
   *
   * @example
   * const old = await Post.on('archive').where('year', 2019).get()
   * await Post.on('archive').create({ title: 'Moved' })
   */
  static on(name: string): typeof ModelBase {
    assertConnectionName(name)
    let byName = boundCache.get(this)
    if (byName === undefined) {
      byName = new Map()
      boundCache.set(this, byName)
    }
    const cached = byName.get(name)
    if (cached !== undefined) return cached
    class Bound extends this {
      static override readonly boundConnection: string = name
    }
    // Error messages and model events name the app's class, not "Bound".
    Object.defineProperty(Bound, 'name', { value: this.name })
    byName.set(name, Bound)
    return Bound
  }

  /**
   * A model instance from a database row (casts applied, marked as saved).
   *
   * @example
   * const post = Post.hydrate({ id: 1, title: 'Hi', … }, false)
   */
  static hydrate(row: Row, fromList: boolean): ModelBase {
    const model = new this()
    model.#assignRow(row)
    model.#persisted = true
    model.#fromList = fromList
    return model
  }

  /**
   * A new, unsaved instance (Laravel's `new Post`).
   *
   * @example
   * const post = Post.make()
   */
  static make(): ModelBase {
    return new this()
  }

  /**
   * The relation `name`, resolved safely. Only methods defined on the app's own model class are
   * considered (never `save`, `delete` or other built-ins), async methods are refused, and the
   * method runs on a blank instance, so naming a non-relation method cannot act on real rows.
   *
   * @example
   * Post.relation('author') // a BelongsToRelation
   */
  static relation(name: string): RelationContract {
    let cache = relationCache.get(this)
    if (cache === undefined) {
      cache = new Map()
      relationCache.set(this, cache)
    }
    const cached = cache.get(name)
    if (cached !== undefined) return cached
    const method = findOwnMethod(this.prototype, name)
    if (method === undefined) throw unknownRelation(this.name, name, ownMethodNames(this.prototype))
    if (method.constructor.name !== 'Function') {
      throw new OrmUsageError(
        'relation_not_sync',
        `${this.name}.${name}() is async or a generator. Relation methods must be plain methods that return this.belongsTo(…), this.hasMany(…) or this.belongsToMany(…).`,
      )
    }
    const relation: unknown = Reflect.apply(method, new this(), [])
    if (!isRelation(relation)) {
      throw new OrmUsageError(
        'not_a_relation',
        `${this.name}.${name}() is not a relation: it must return this.belongsTo(…), this.hasMany(…) or this.belongsToMany(…).`,
      )
    }
    cache.set(name, relation)
    return relation
  }

  /**
   * Start a query.
   *
   * @example
   * Post.query().where('status', 'published').get()
   */
  static query(): Builder<AnyModelClass, ModelBase> {
    return new Builder(this)
  }

  /**
   * Every row (within global scopes).
   *
   * @example
   * const tags = await Tag.all()
   */
  static all(): Promise<ModelBase[]> {
    return this.query().get()
  }

  /**
   * The row with this primary key, or `undefined`.
   *
   * @example
   * const post = await Post.find(1)
   */
  static find(key: unknown): Promise<ModelBase | undefined> {
    return this.query().find(asKey(key))
  }

  /**
   * The row with this primary key, or {@link ModelNotFoundError}.
   *
   * @example
   * const post = await Post.findOrFail(1)
   */
  static findOrFail(key: unknown): Promise<ModelBase> {
    return this.query().findOrFail(asKey(key))
  }

  /**
   * Create and save a row from untrusted input: only `fillable` columns are accepted.
   *
   * @example
   * const post = await Post.create({ title: 'Hello', body: '…' })
   */
  static async create(input: object): Promise<ModelBase> {
    const model = new this()
    model.fill(input)
    await model.save()
    return model
  }

  /**
   * Create and save a row from trusted input (seeders, your own code): any real column except
   * Strutvane's own. Never pass request data here.
   *
   * @example
   * await Post.forceCreate({ title: 'Seeded', author_id: admin.id })
   */
  static async forceCreate(input: object): Promise<ModelBase> {
    const model = new this()
    model.forceFill(input)
    await model.save()
    return model
  }

  /**
   * Shortcut for `query().with(…)`.
   *
   * @example
   * await Post.with('author').get()
   */
  static with(...paths: readonly unknown[]): unknown {
    const builder = this.query()
    return Reflect.apply(builder.with, builder, paths)
  }

  /**
   * Shortcut for `query().where(…)`.
   *
   * @example
   * await Post.where('status', 'published').get()
   */
  static where(...args: readonly unknown[]): unknown {
    const builder = this.query()
    return Reflect.apply(builder.where, builder, args)
  }

  /**
   * Shortcut for `query().withTrashed()`.
   *
   * @example
   * await Post.withTrashed().get()
   */
  static withTrashed(): Builder<AnyModelClass, ModelBase> {
    return this.query().withTrashed()
  }

  /**
   * Shortcut for `query().onlyTrashed()`.
   *
   * @example
   * await Post.onlyTrashed().get()
   */
  static onlyTrashed(): Builder<AnyModelClass, ModelBase> {
    return this.query().onlyTrashed()
  }

  // -------------------------------------------------------------------------------------------
  // Instance side: what `post.something()` does
  // -------------------------------------------------------------------------------------------

  /**
   * This instance's model class, as the runtime contract.
   *
   * @example
   * post.runtime().table // 'posts'
   */
  runtime(): ModelRuntime {
    const ctor: unknown = this.constructor
    if (!isModelRuntime(ctor))
      throw new OrmUsageError('not_a_model', 'This object is not a Strutvane model instance.')
    return ctor
  }

  /**
   * Has this instance been saved (or loaded from the database)? Laravel's `$model->exists`.
   *
   * @example
   * Post.make().isPersisted() // false
   */
  isPersisted(): boolean {
    return this.#persisted
  }

  /**
   * Set one column value from trusted code (no mass-assignment check, but the column must exist).
   *
   * @example
   * post.setAttribute('author_id', user.id)
   */
  setAttribute(column: string, value: unknown): this {
    const info = this.runtime().info()
    if (!info.columns.has(column))
      throw new MassAssignmentError(
        info.name,
        column,
        'unknown',
        closest(column, hintableColumns(info, this.runtime().settings().hidden)),
      )
    defineColumn(this, column, value)
    return this
  }

  /**
   * Assign untrusted input. Every key must be a `fillable` column; anything else (unknown
   * columns, `is_admin` when it is not fillable, `tenant_id`) throws, nothing is silently dropped.
   *
   * @example
   * post.fill(request.body)
   */
  fill(input: object): this {
    const runtime = this.runtime()
    const info = runtime.info()
    const fillable = runtime.settings().fillable
    for (const [key, value] of Object.entries(input)) {
      if (!info.columns.has(key))
        throw new MassAssignmentError(
          info.name,
          key,
          'unknown',
          closest(key, hintableColumns(info, runtime.settings().hidden)),
        )
      if (isSystemColumn(key)) throw new MassAssignmentError(info.name, key, 'system')
      if (fillable === undefined || !fillable.has(key))
        throw new MassAssignmentError(info.name, key, 'not-fillable')
      defineColumn(this, key, value)
    }
    return this
  }

  /**
   * Assign trusted input: any real column except the primary key and Strutvane's own columns.
   *
   * @example
   * post.forceFill({ author_id: 1, status: 'published' })
   */
  forceFill(input: object): this {
    const info = this.runtime().info()
    for (const [key, value] of Object.entries(input)) {
      if (!info.columns.has(key))
        throw new MassAssignmentError(
          info.name,
          key,
          'unknown',
          closest(key, hintableColumns(info, this.runtime().settings().hidden)),
        )
      // tenant_id and timestamps are Strutvane's; a uuid id may be chosen by trusted code.
      if (isSystemColumn(key) && !(key === 'id' && info.primaryKey.kind === 'uuid'))
        throw new MassAssignmentError(info.name, key, 'system')
      defineColumn(this, key, value)
    }
    return this
  }

  /**
   * The changed columns since the model was loaded or saved, with their new values.
   *
   * @example
   * post.title = 'New'; post.getDirty() // { title: 'New' }
   */
  getDirty(): Record<string, unknown> {
    const dirty: Record<string, unknown> = {}
    for (const column of this.runtime().info().columns.keys()) {
      if (!Object.hasOwn(this, column)) continue
      const current = attribute(this, column)
      if (!this.#persisted || comparable(current) !== this.#original[column])
        dirty[column] = current
    }
    return dirty
  }

  /**
   * Did `column` (or any column) change since the last load or save?
   *
   * @example
   * post.isDirty('title') // true after post.title = '…'
   */
  isDirty(column?: string): boolean {
    const dirty = this.getDirty()
    return column === undefined ? Object.keys(dirty).length > 0 : column in dirty
  }

  /**
   * Is this row soft-deleted?
   *
   * @example
   * await post.delete(); post.trashed() // true
   */
  trashed(): boolean {
    const deletedAt = attribute(this, SYSTEM_COLUMNS.deletedAt)
    return deletedAt !== null && deletedAt !== undefined
  }

  /**
   * Insert or update the row. Timestamps, tenant, generated keys and slugs are handled here.
   *
   * @example
   * post.title = 'Better title'
   * await post.save()
   */
  async save(): Promise<this> {
    if (this.#persisted) {
      const changed = await this.#update()
      if (changed.length > 0) await this.#announce('updated', { changed })
    } else {
      await this.#insert()
      await this.#announce('created', {})
    }
    return this
  }

  /**
   * Delete the row: soft (sets `deleted_at`) when the table has `t.softDeletes()`, hard otherwise.
   *
   * @example
   * await post.delete()
   */
  async delete(): Promise<void> {
    const info = this.#assertPersisted('delete')
    if (!info.softDeletes) return this.forceDelete()
    defineColumn(this, SYSTEM_COLUMNS.deletedAt, new Date())
    // #update, not save(): a soft delete is announced as `deleted`, never as `updated`.
    await this.#update()
    await this.#announce('deleted', { soft: true })
  }

  /**
   * Delete the row for real, even on a soft-deleting table.
   *
   * @example
   * await post.forceDelete()
   */
  async forceDelete(): Promise<void> {
    const info = this.#assertPersisted('forceDelete')
    const connection = this.runtime().connection()
    const where = this.#keyConditions(info)
    assertWriteScoped(info.name, where)
    const { rowsAffected } = await connection.run(
      markScoped(compileDelete(info.name, where, connection.grammar)),
      this.#runOptions(info),
    )
    if (rowsAffected === 0) throw new ModelNotFoundError(info.name, attribute(this, 'id'))
    this.#persisted = false
    await this.#announce('deleted', { soft: false })
  }

  /**
   * Bring a soft-deleted row back.
   *
   * @example
   * await post.restore()
   */
  async restore(): Promise<this> {
    const info = this.#assertPersisted('restore')
    if (!info.softDeletes)
      throw new OrmUsageError(
        'no_soft_deletes',
        `"${info.name}" has no deleted_at column, so there is nothing to restore. Add t.softDeletes() in a migration to enable it.`,
      )
    defineColumn(this, SYSTEM_COLUMNS.deletedAt, null)
    // Restoring a row that isn't deleted changes nothing, so nothing is announced.
    if ((await this.#update()).length > 0) await this.#announce('restored', {})
    return this
  }

  /**
   * Reload every column from the database (including when soft-deleted).
   *
   * @example
   * await post.refresh()
   */
  async refresh(): Promise<this> {
    const info = this.#assertPersisted('refresh')
    const query = new Builder<AnyModelClass, ModelBase>(this.runtime()).withTrashed()
    for (const condition of this.#keyConditions(info)) query.addCondition(condition)
    const [found] = await query.fetchWithRows()
    if (found === undefined) throw new ModelNotFoundError(info.name, attribute(this, 'id'))
    this.#assignRow(found.row)
    return this
  }

  /**
   * Load relations onto this one model. Refused (by default outside production) when the model
   * came from a list: load for the whole list with `with()` or {@link loadMany} instead.
   *
   * @example
   * const post = await Post.findOrFail(1)
   * await post.load('author')
   */
  async load(...paths: readonly string[]): Promise<this> {
    if (this.#fromList && ormConfig().preventLazyLoading)
      throw new LazyLoadingError(this.runtime().table, paths.join(', '))
    await loadRelations([this], parseRelationPaths(paths))
    return this
  }

  /**
   * The model as plain JSON data: columns minus hidden ones (the model's `hidden`, the
   * migration's `.hidden()`/`.secret()` and secret-looking names), dates as ISO strings, loaded relations
   * and counts included. `JSON.stringify(post)` calls this.
   *
   * @example
   * JSON.stringify(user) // no "password"
   */
  toJSON(): Record<string, unknown> {
    const hidden = this.runtime().settings().hidden
    const json: Record<string, unknown> = {}
    for (const key of Object.keys(this)) {
      if (hidden.has(key)) continue
      json[key] = jsonValue(attribute(this, key))
    }
    return json
  }

  /**
   * Declare a "belongs to" relation. The foreign key (on this table) defaults to
   * `<related singular>_id`; the owner key to `id`.
   *
   * @example
   * author() { return this.belongsTo(User, 'author_id') }
   */
  belongsTo(related: unknown, foreignKey?: string, ownerKey = 'id'): unknown {
    const relatedRuntime = asModel(related, 'belongsTo')
    return new BelongsToRelation(
      this,
      relatedRuntime,
      foreignKey ?? `${singular(relatedRuntime.table)}_id`,
      ownerKey,
    )
  }

  /**
   * Declare a "has many" relation. The foreign key (on the related table) defaults to
   * `<this singular>_id`.
   *
   * @example
   * posts() { return this.hasMany(Post, 'author_id') }
   */
  hasMany(related: unknown, foreignKey?: string, localKey = 'id'): unknown {
    const relatedRuntime = asModel(related, 'hasMany')
    return new HasManyRelation(
      this,
      relatedRuntime,
      foreignKey ?? `${singular(this.runtime().table)}_id`,
      localKey,
    )
  }

  /**
   * Declare a many-to-many relation through a pivot table. Defaults follow Laravel: pivot
   * `post_tag` (singulars, alphabetical), keys `post_id` and `tag_id`.
   *
   * @example
   * tags() { return this.belongsToMany(Tag, 'post_tag') }
   */
  belongsToMany(
    related: unknown,
    pivotTable?: string,
    foreignPivotKey?: string,
    relatedPivotKey?: string,
  ): unknown {
    const relatedRuntime = asModel(related, 'belongsToMany')
    const own = singular(this.runtime().table)
    const other = singular(relatedRuntime.table)
    const pivot = pivotTable ?? [own, other].sort().join('_')
    return new BelongsToManyRelation(
      this,
      relatedRuntime,
      pivot,
      foreignPivotKey ?? `${own}_id`,
      relatedPivotKey ?? `${other}_id`,
    )
  }

  // -------------------------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------------------------

  #assignRow(row: Row): void {
    const runtime = this.runtime()
    const info = runtime.info()
    const casts = runtime.settings().casts
    const dialect = runtime.connection().grammar.dialect
    for (const column of info.columns.values()) {
      if (!(column.name in row)) continue
      const stored = fromDatabase(column, row[column.name], dialect)
      const cast = casts.get(column.name)
      defineColumn(
        this,
        column.name,
        cast === undefined || stored === null ? stored : cast.get(stored),
      )
    }
    this.#snapshot(info)
  }

  #snapshot(info: TableInfo): void {
    this.#original = {}
    for (const column of info.columns.keys())
      this.#original[column] = comparable(attribute(this, column))
  }

  async #insert(): Promise<void> {
    const runtime = this.runtime()
    const info = runtime.info()
    this.#applyTenant(info)
    if (info.primaryKey.kind === 'uuid' && attribute(this, 'id') == null)
      defineColumn(this, 'id', uuidv7())
    if (info.timestamps) {
      const now = new Date()
      if (attribute(this, SYSTEM_COLUMNS.createdAt) == null)
        defineColumn(this, SYSTEM_COLUMNS.createdAt, now)
      defineColumn(this, SYSTEM_COLUMNS.updatedAt, now)
    }
    const record = this.#storedValues(
      info,
      [...info.columns.keys()].filter((column) => attribute(this, column) !== undefined),
    )
    const missingSlugs = info.slugs.filter(
      (slug) =>
        record[slug.name] === undefined || record[slug.name] === null || record[slug.name] === '',
    )
    const row =
      missingSlugs.length === 0
        ? await this.#insertRow(info, record)
        : await this.#insertWithSlugs(info, record, missingSlugs)
    this.#assignRow(row)
    this.#persisted = true
  }

  async #insertRow(info: TableInfo, record: Record<string, unknown>): Promise<Row> {
    const connection = this.runtime().connection()
    assertInsertScoped(info.name, record)
    const result = await connection.run(
      markScoped(compileInsert(info.name, record, connection.grammar)),
      this.#runOptions(info),
    )
    if (connection.grammar.supportsReturning) {
      const [row] = result.rows
      if (row === undefined)
        throw new Error(
          `Inserting into "${info.name}" returned no row; the database did not honour RETURNING.`,
        )
      return row
    }
    // MySQL has no RETURNING: learn the key (ours for UUIDs, the driver's insert id otherwise),
    // then read the row back so database defaults (status = 'draft', …) are on the model too.
    if (attribute(this, 'id') == null) defineColumn(this, 'id', result.insertId)
    return this.#reselect(info)
  }

  /** Read this row back by key (within the tenant), for engines without RETURNING. */
  async #reselect(info: TableInfo): Promise<Row> {
    const query = new Builder<AnyModelClass, ModelBase>(this.runtime()).withTrashed()
    for (const condition of this.#keyConditions(info)) query.addCondition(condition)
    const [found] = await query.fetchWithRows()
    if (found === undefined) throw new ModelNotFoundError(info.name, attribute(this, 'id'))
    return found.row
  }

  /**
   * Pick free slugs and insert; if another request took the same slug in between, the unique
   * index rejects the insert and we try again with fresh suffixes. Each attempt runs in its own
   * savepoint, so a failed attempt never poisons an outer transaction (Postgres aborts the whole
   * transaction on any error otherwise).
   */
  async #insertWithSlugs(
    info: TableInfo,
    record: Record<string, unknown>,
    slugs: readonly ColumnDef[],
  ): Promise<Row> {
    const connection = this.runtime().connection()
    // Slugs a failed attempt tried. A retry means the unique index saw a row the lookup could not
    // (another transaction's uncommitted insert, or one committed after a REPEATABLE READ snapshot,
    // which MySQL keeps for the whole transaction), so those count as taken from then on.
    const tried = new Map<string, string[]>()
    for (let attempt = 1; ; attempt += 1) {
      for (const slug of slugs) {
        const source =
          slug.slugFrom === undefined ? '' : String(attribute(this, slug.slugFrom) ?? '')
        const base = slugify(source, slug.length ?? 255)
        const taken = [
          ...(await this.#takenSlugs(info, slug, base)),
          ...(tried.get(slug.name) ?? []),
        ]
        const candidate = nextFreeSlug(base, taken)
        record[slug.name] = candidate
        tried.set(slug.name, [...(tried.get(slug.name) ?? []), candidate])
      }
      try {
        return await connection.transaction(
          () => this.#insertRow(info, record),
          this.#runOptions(info),
        )
      } catch (error) {
        if (!connection.grammar.isUniqueViolation(error) || attempt >= SLUG_ATTEMPTS) throw error
      }
    }
  }

  /** Existing slugs equal to `base` or starting with `base-`, within the slug's unique scope. */
  async #takenSlugs(info: TableInfo, slug: ColumnDef, base: string): Promise<string[]> {
    const column = sql.id(slug.name)
    const prefix = `${base}-`
    // The lookup is always limited to the active tenant (and to the slug's unique-index scope),
    // so a collision can never reveal that another tenant uses the same title (review F-14).
    const tenant = tenantMode(info.name) === 'scoped' ? tenantColumn() : undefined
    const scopeColumns = new Set([
      ...(info.slugScopes.get(slug.name) ?? []),
      ...(tenant === undefined ? [] : [tenant]),
    ])
    const scope = [...scopeColumns].map((name) => {
      const value = attribute(this, name)
      return value === null || value === undefined
        ? sql`${sql.id(name)} IS NULL`
        : sql`${sql.id(name)} = ${value}`
    })
    // substr instead of LIKE: a "%" or "_" in a title must not act as a wildcard.
    const conditions = [
      sql`(${column} = ${base} OR substr(${column}, 1, ${prefix.length}) = ${prefix})`,
      ...scope,
    ]
    const query = sql`SELECT ${column} AS slug FROM ${sql.id(info.name)} WHERE ${sql.join(conditions, ' AND ')}`
    // Hand-written, so marked as checked explicitly: the tenant condition was added just above.
    const { rows } = await this.runtime()
      .connection()
      .run(markScoped(query), this.#runOptions(info))
    return rows.map((row) => String(row['slug']))
  }

  /**
   * Emit a model event (`post.created`, …) after the write commits, when the running app has a
   * listener for it (see `events.ts`). Builds nothing when nobody listens.
   */
  async #announce(
    verb: ModelEventVerb,
    extra: { readonly changed?: readonly string[]; readonly soft?: boolean },
  ): Promise<void> {
    const events = currentModelEvents()
    if (events === undefined) return
    const runtime = this.runtime()
    const info = runtime.info()
    const type = modelEventName(info.name, verb)
    if (!events.wants(type)) return
    const payload = Object.freeze({
      table: info.name,
      model: this.constructor.name,
      key: attribute(this, 'id'),
      record: Object.freeze(this.toJSON()),
      ...(extra.changed === undefined ? {} : { changed: Object.freeze([...extra.changed]) }),
      ...(extra.soft === undefined ? {} : { soft: extra.soft }),
    })
    const tenant = this.#runOptions(info).tenantId
    await runtime.connection().afterCommit(() => events.dispatch(type, payload, tenant))
  }

  /** Write the dirty columns; returns the columns that changed (none: nothing was written). */
  async #update(): Promise<string[]> {
    const runtime = this.runtime()
    const info = runtime.info()
    const dirty = this.getDirty()
    if (Object.keys(dirty).length === 0) return []
    if ('id' in dirty)
      throw new OrmUsageError(
        'primary_key_changed',
        `The primary key of a saved "${info.name}" row can't change. Create a new row instead.`,
      )
    const tenant = tenantColumn()
    if (tenant !== undefined && tenant in dirty)
      throw new TenantMismatchError(info.name, `${tenant} of a saved row was changed`)
    if (info.timestamps && !(SYSTEM_COLUMNS.updatedAt in dirty)) {
      defineColumn(this, SYSTEM_COLUMNS.updatedAt, new Date())
      dirty[SYSTEM_COLUMNS.updatedAt] = attribute(this, SYSTEM_COLUMNS.updatedAt)
    }
    const changes = this.#storedValues(info, Object.keys(dirty))
    const connection = runtime.connection()
    const where = this.#keyConditions(info)
    assertWriteScoped(info.name, where)
    const result = await connection.run(
      markScoped(compileUpdate(info.name, changes, where, connection.grammar, true)),
      this.#runOptions(info),
    )
    // Without RETURNING (MySQL) the row is read back with the same key and tenant conditions.
    const row = connection.grammar.supportsUpdateReturning
      ? result.rows[0]
      : await this.#reselect(info)
    // Zero rows: deleted meanwhile, or (with tenancy) never ours. Both are "not found".
    if (row === undefined) throw new ModelNotFoundError(info.name, attribute(this, 'id'))
    this.#assignRow(row)
    return Object.keys(dirty)
  }

  /** Model values → database values for the given columns (model casts, then built-in casts). */
  #storedValues(info: TableInfo, columns: readonly string[]): Record<string, unknown> {
    const casts = this.runtime().settings().casts
    const dialect = this.runtime().connection().grammar.dialect
    const record: Record<string, unknown> = {}
    for (const name of columns) {
      const column = info.columns.get(name)
      if (column === undefined) continue
      const value = attribute(this, name)
      const cast = casts.get(name)
      const modelValue =
        cast === undefined || value === null || value === undefined
          ? value
          : applyCast(info.name, name, cast, value)
      record[name] = toDatabase(info.name, column, modelValue, dialect)
    }
    return record
  }

  /** `id = ?`, plus `<tenant column> = ?` on tenant tables: a write can only touch our own row. */
  #keyConditions(info: TableInfo): WhereNode[] {
    const conditions: WhereNode[] = [
      {
        kind: 'compare',
        conjunction: 'and',
        column: { alias: info.name, column: 'id' },
        operator: '=',
        value: attribute(this, 'id'),
      },
    ]
    const tenant = tenantCondition(info.name, info.name)
    if (tenant !== undefined) conditions.push(tenant)
    return conditions
  }

  /** Stamp a new row with the active tenant; refuse a row that names a different one. */
  #applyTenant(info: TableInfo): void {
    if (tenantMode(info.name) === 'global') return
    const tenant = requireTenant(info.name)
    const column = tenantColumn()
    if (column === undefined) return
    const given = attribute(this, column)
    if (given !== undefined && given !== null && given !== tenant)
      throw new TenantMismatchError(
        info.name,
        `${column} ${String(given)} is not the active tenant`,
      )
    defineColumn(this, column, tenant)
  }

  #runOptions(info: TableInfo): { readonly tenantId?: string } {
    const tenant = currentTenant()
    return tenantMode(info.name) === 'scoped' && tenant !== undefined ? { tenantId: tenant } : {}
  }

  #assertPersisted(action: string): TableInfo {
    const info = this.runtime().info()
    if (!this.#persisted)
      throw new OrmUsageError(
        'not_saved',
        `Can't ${action}() a "${info.name}" row that was never saved. Call save() first.`,
      )
    return info
  }
}

// ---------------------------------------------------------------------------------------------
// The typed face of a model: what `Model('posts', …)` returns
// ---------------------------------------------------------------------------------------------

/**
 * The instance methods of a model, typed for its table and options.
 *
 * @example
 * const json = post.toJSON() // typed: no hidden columns, dates as strings
 */
export interface ModelInstanceMethods<TTable extends TableName, TOptions>
  extends ModelMarker<TTable, TOptions> {
  isPersisted(): boolean
  setAttribute<TColumn extends ColumnOf<TTable>>(
    column: TColumn,
    value: Attributes<TTable, TOptions>[TColumn],
  ): this
  fill(input: Partial<CreateInput<TTable, TOptions>>): this
  forceFill(input: Partial<ForceCreateInput<TTable, TOptions>>): this
  getDirty(): Partial<Attributes<TTable, TOptions>>
  isDirty(column?: ColumnOf<TTable>): boolean
  trashed(): boolean
  save(): Promise<this>
  delete(): Promise<void>
  forceDelete(): Promise<void>
  restore(): Promise<this>
  refresh(): Promise<this>
  load<TPath extends RelationPath<this>>(...paths: TPath[]): Promise<WithRelations<this, TPath>>
  toJSON(): JsonOf<this>
  runtime(): ModelRuntime
  belongsTo<TRelated extends AnyModelClass>(
    related: TRelated,
    foreignKey?: ColumnOf<TTable>,
    ownerKey?: ColumnOf<TableOf<TRelated>>,
  ): BelongsTo<TRelated>
  hasMany<TRelated extends AnyModelClass>(
    related: TRelated,
    foreignKey?: ColumnOf<TableOf<TRelated>>,
    localKey?: ColumnOf<TTable>,
  ): HasMany<TRelated>
  belongsToMany<TRelated extends AnyModelClass, TPivot extends TableName>(
    related: TRelated,
    pivotTable?: TPivot,
    foreignPivotKey?: ColumnOf<TPivot>,
    relatedPivotKey?: ColumnOf<TPivot>,
  ): BelongsToMany<TRelated>
}

/**
 * A model instance: its columns as typed properties, plus the model methods.
 *
 * @example
 * const post: ModelInstance<'posts', NoOptions> = Post.make()
 */
export type ModelInstance<TTable extends TableName, TOptions> = Attributes<TTable, TOptions> &
  ModelInstanceMethods<TTable, TOptions>

/**
 * The class `Model('posts', …)` returns: extend it, call its static methods.
 *
 * @example
 * class Post extends Model('posts') {}
 * await Post.query().get()
 */
export interface ModelClass<TTable extends TableName, TOptions> {
  new (): ModelInstance<TTable, TOptions>
  readonly table: TTable
  readonly options: TOptions
  query<TSelf extends AnyModelClass>(this: TSelf): QueryBuilder<TSelf, InstanceOf<TSelf>>
  make<TSelf extends AnyModelClass>(this: TSelf): InstanceOf<TSelf>
  all<TSelf extends AnyModelClass>(this: TSelf): Promise<InstanceOf<TSelf>[]>
  find<TSelf extends AnyModelClass>(
    this: TSelf,
    key: KeyOf<TSelf>,
  ): Promise<InstanceOf<TSelf> | undefined>
  findOrFail<TSelf extends AnyModelClass>(
    this: TSelf,
    key: KeyOf<TSelf>,
  ): Promise<InstanceOf<TSelf>>
  create<TSelf extends AnyModelClass>(
    this: TSelf,
    input: CreateInput<TableOf<TSelf>, OptionsOf<TSelf>>,
  ): Promise<InstanceOf<TSelf>>
  forceCreate<TSelf extends AnyModelClass>(
    this: TSelf,
    input: ForceCreateInput<TableOf<TSelf>, OptionsOf<TSelf>>,
  ): Promise<InstanceOf<TSelf>>
  with<TSelf extends AnyModelClass, TPath extends RelationPath<InstanceOf<TSelf>>>(
    this: TSelf,
    ...paths: TPath[]
  ): QueryBuilder<TSelf, WithRelations<InstanceOf<TSelf>, TPath>>
  where<TSelf extends AnyModelClass, TColumn extends ColumnOf<TableOf<TSelf>>>(
    this: TSelf,
    column: TColumn,
    value: ColumnValue<TableOf<TSelf>, TColumn>,
  ): QueryBuilder<TSelf, InstanceOf<TSelf>>
  withTrashed<TSelf extends AnyModelClass>(this: TSelf): QueryBuilder<TSelf, InstanceOf<TSelf>>
  onlyTrashed<TSelf extends AnyModelClass>(this: TSelf): QueryBuilder<TSelf, InstanceOf<TSelf>>
  /** This model on the connection `name` (declared in `config/database.ts`): Laravel's `on()`. */
  on<TSelf extends AnyModelClass>(this: TSelf, name: string): TSelf
  /** The connection this model uses (its `connection` option, or the default one). */
  connection(): Connection
}

/**
 * Create the base class for a model of `table`. Options that change the model's *types*
 * (fillable, hidden, casts) go here; behaviour (relations, scopes, accessors) goes in the class.
 *
 * @example
 * export class User extends Model('users', { fillable: ['name', 'email'], hidden: ['password'] }) {
 *   posts() { return this.hasMany(Post, 'author_id') }
 * }
 */
export function Model<
  const TTable extends TableName,
  const TOptions extends ModelOptions<TTable> = NoOptions,
>(table: TTable, options?: TOptions): ModelClass<TTable, TOptions> {
  assertIdentifier(table)
  const runtimeOptions: RuntimeOptions = options ?? {}
  // A bad name is a typo in code: refuse it at import. Whether it is declared is checked on the
  // first query, because config/database.ts is the app's, read at boot.
  if (runtimeOptions.connection !== undefined) assertConnectionName(runtimeOptions.connection)
  class TableModel extends ModelBase {
    static override readonly table: string = table
    static override readonly options: RuntimeOptions = runtimeOptions
  }
  return typedModelClass<TTable, TOptions>(TableModel)
}

/**
 * The one bridge from the runtime class to its static type: `ModelBase` implements every
 * member of {@link ModelClass} at runtime with looser parameter types, and the types above are
 * the precise contract. Kept in one named function so it is easy to audit.
 */
function typedModelClass<TTable extends TableName, TOptions>(
  runtimeClass: typeof ModelBase,
): ModelClass<TTable, TOptions> {
  return runtimeClass as unknown as ModelClass<TTable, TOptions>
}

/**
 * Load relations for a list of models in one query per relation (Laravel's `$posts->load()`).
 *
 * @example
 * const posts = await Post.all()
 * await loadMany(posts, 'author')
 */
export async function loadMany<TModel extends ModelMarker>(
  models: readonly TModel[],
  ...paths: readonly RelationPath<TModel>[]
): Promise<void> {
  const runtimeModels = models.filter(
    (model): model is TModel & ModelBase => model instanceof ModelBase,
  )
  await loadRelations(runtimeModels, parseRelationPaths(paths))
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Names a query builder must never have as methods, or it would be mistaken for a promise. */
const PROMISE_MEMBERS: ReadonlySet<string> = new Set(['then', 'catch', 'finally'])

/**
 * Every column kept out of `toJSON()`, request filters, sorts, searches, cursors and hints: the
 * model's own `hidden` list plus every column the migration marked `.hidden()` or `.secret()`,
 * and every column named like a secret (`password`, `*_token`, `api_key`, …). The schema decides
 * first, so forgetting `hidden` on a model never leaks a secret.
 */
function hiddenColumns(info: TableInfo, options: RuntimeOptions): ReadonlySet<string> {
  const hidden = new Set(options.hidden ?? [])
  for (const column of info.columns.values()) if (isHiddenColumn(column)) hidden.add(column.name)
  return hidden
}

/** Columns a "Did you mean" hint may name: never a hidden one (its name alone is a leak). */
function hintableColumns(info: TableInfo, hidden: ReadonlySet<string>): string[] {
  return [...info.columns.keys()].filter((column) => !hidden.has(column))
}

/** Store a column as an own, enumerable data property (never through a setter). */
function defineColumn(model: object, column: string, value: unknown): void {
  Object.defineProperty(model, column, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** A value in a form where `!==` means "changed" (dates and JSON compare by content). */
function comparable(value: unknown): unknown {
  if (value instanceof Date) return `date:${value.toISOString()}`
  if (typeof value === 'object' && value !== null) return `json:${JSON.stringify(value)}`
  return value
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value instanceof ModelBase) return value.toJSON()
  if (Array.isArray(value)) return value.map(jsonValue)
  return value
}

/** Naive English singular, enough for default key names (`posts` → `post`, `categories` → `category`). */
function singular(table: string): string {
  if (table.endsWith('ies')) return `${table.slice(0, -3)}y`
  if (table.endsWith('ses')) return table.slice(0, -2)
  return table.endsWith('s') ? table.slice(0, -1) : table
}

function asModel(related: unknown, relation: string): ModelRuntime {
  if (!isModelRuntime(related)) {
    throw new OrmUsageError(
      'not_a_model',
      `${relation}() needs a model class, such as this.${relation}(User). If you passed a class from another file, check for a circular import that left it undefined.`,
    )
  }
  return related
}

/** Find a method defined by the app's model class itself (stopping before ModelBase's own). */
function findOwnMethod(prototype: object, name: string): StoredCallback | undefined {
  let current: object | null = prototype
  while (current !== null && current !== ModelBase.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      const value: unknown = descriptor.value
      return typeof value === 'function' && name !== 'constructor'
        ? (value as StoredCallback)
        : undefined
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

function ownMethodNames(prototype: object): string[] {
  const names: string[] = []
  let current: object | null = prototype
  while (current !== null && current !== ModelBase.prototype) {
    for (const name of Object.getOwnPropertyNames(current))
      if (name !== 'constructor') names.push(name)
    current = Object.getPrototypeOf(current)
  }
  return names
}

function unknownRelation(
  model: string,
  name: string,
  candidates: readonly string[],
): OrmUsageError {
  const suggestion = closest(name, candidates)
  const hint = suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`
  return new OrmUsageError(
    'unknown_relation',
    `${model} has no relation "${name}".${hint} Relations are methods on the model that return this.belongsTo(…), this.hasMany(…) or this.belongsToMany(…).`,
  )
}

function readStatic(
  modelClass: object,
  name: 'scopes' | 'globalScopes',
): ReadonlyMap<string, StoredCallback> {
  const value: unknown = Reflect.get(modelClass, name)
  const scopes = new Map<string, StoredCallback>()
  if (value === undefined) return scopes
  if (typeof value !== 'object' || value === null)
    throw new OrmUsageError('invalid_scopes', `static ${name} must be an object of functions.`)
  for (const [key, scope] of Object.entries(value)) {
    if (typeof scope !== 'function')
      throw new OrmUsageError(
        'invalid_scopes',
        `static ${name}.${key} must be a function (query, …args) => …`,
      )
    scopes.set(key, (...args: never[]) => Reflect.apply(scope, undefined, args))
  }
  return scopes
}

/** Validate options against the schema once, with messages that say how to fix them. */
function buildSettings(
  modelName: string,
  info: TableInfo,
  options: RuntimeOptions,
  scopes: ReadonlyMap<string, StoredCallback>,
  globalScopes: ReadonlyMap<string, StoredCallback>,
): ModelSettings {
  for (const column of info.columns.keys()) {
    if (column in ModelBase.prototype) {
      throw new OrmUsageError(
        'column_clashes_with_method',
        `"${info.name}.${column}" has the same name as the model method ${column}(). Rename the column in a new migration.`,
      )
    }
  }
  for (const column of options.hidden ?? []) {
    if (!info.columns.has(column))
      throw new OrmUsageError(
        'unknown_hidden_column',
        `${modelName} hides "${column}", but "${info.name}" has no such column.`,
      )
  }
  const hidden = hiddenColumns(info, options)
  const acknowledged = new Set(options.allowSensitive ?? [])
  for (const column of options.fillable ?? []) {
    if (!info.columns.has(column))
      throw new MassAssignmentError(
        info.name,
        column,
        'unknown',
        closest(column, hintableColumns(info, hidden)),
      )
    if (isSystemColumn(column)) throw new MassAssignmentError(info.name, column, 'system')
    const definition = info.columns.get(column)
    if (definition !== undefined && isSecretColumn(definition) && !acknowledged.has(column)) {
      throw new OrmUsageError(
        'secret_fillable',
        `${modelName} lists "${column}" as fillable, and it is a secret (.secret() or a name like password, *_token, api_key). ` +
          `A request must not set it directly: set it in your own code (forceFill/forceCreate) after hashing or generating it, ` +
          `or, if users really may send it, also list it in allowSensitive: ['${column}'].`,
      )
    }
    if (isPrivilegeColumn(column) && !acknowledged.has(column)) {
      throw new OrmUsageError(
        'sensitive_fillable',
        `${modelName} lists "${column}" as fillable, and it looks privilege- or workflow-related (is_*, *_at, *_by, role, plan…). ` +
          `If users really may set it from a request, also list it in allowSensitive: ['${column}']; otherwise set it in your own code.`,
      )
    }
  }
  const casts = new Map<string, Cast<unknown>>()
  for (const [column, cast] of Object.entries(options.casts ?? {})) {
    if (cast === undefined) continue
    if (!info.columns.has(column))
      throw new OrmUsageError(
        'unknown_cast_column',
        `${modelName} casts "${column}", but "${info.name}" has no such column.`,
      )
    casts.set(column, cast)
  }
  for (const name of scopes.keys()) {
    if (name in Builder.prototype)
      throw new OrmUsageError(
        'scope_clashes_with_method',
        `${modelName} has a scope named "${name}", which clashes with the query method ${name}(). Rename the scope.`,
      )
    // Promise members: a builder with a `then` method is "thenable", so `await query` would call the
    // scope instead of running the query (and catch/finally make it look like a promise to tools).
    if (PROMISE_MEMBERS.has(name)) {
      throw new OrmUsageError(
        'scope_clashes_with_method',
        `${modelName} has a scope named "${name}", which clashes with promises: \`await query\` would call it instead of running the query. Rename the scope.`,
      )
    }
  }
  return {
    fillable: options.fillable === undefined ? undefined : new Set(options.fillable),
    hidden,
    casts,
    perPage: options.perPage ?? 15,
    scopes,
    globalScopes,
  }
}

// What `console.log(user)` and `util.inspect(user)` print: the same fields as `toJSON()`, so a
// stray debug or log line never prints a password hash or a token (server code that really needs
// one reads the attribute itself). Defined here because a symbol-named method can't be declared
// under isolatedDeclarations.
Object.defineProperty(ModelBase.prototype, Symbol.for('nodejs.util.inspect.custom'), {
  value(this: ModelBase): Record<string, unknown> {
    return this.toJSON()
  },
  enumerable: false,
  writable: false,
  configurable: false,
})

/** Keys arrive as `unknown` on the runtime side; their types were checked by the static API. */
function asKey(key: unknown): KeyOf<AnyModelClass> {
  return key as KeyOf<AnyModelClass>
}
