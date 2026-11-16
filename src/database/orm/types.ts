/**
 * The type-level half of the ORM: how a model's TypeScript types are computed from the generated
 * table types plus the few options that change them (casts, fillable, hidden).
 *
 * Nothing here exists at runtime except two symbols. Read it top to bottom: model markers, the
 * shapes of a model's attributes, relations, eager-loaded results, and JSON.
 */
import type { ColumnOf, InsertOf, RowOf, TableName } from '../schema/registry.ts'
import type { CompareOperator } from '../sql/ast.ts'
import type { SqlFragment } from '../sql/fragment.ts'
import type { Builder } from './builder.ts'
import type { Cast } from './casts.ts'

/**
 * Compile-time marker carrying a model's table and options. It is never set at runtime (reading
 * it gives `undefined`); it exists so types can recover "which table is this model?" from any
 * instance cheaply, without walking every property (which would make relation types circular).
 */
export const MODEL_TYPES: unique symbol = Symbol('strutvane.modelTypes')

/** Compile-time marker carrying a relation's related model class and whether it is to-many. */
export const RELATION_TYPES: unique symbol = Symbol('strutvane.relationTypes')

/** Columns Strutvane fills itself: never mass-assignable, never accepted from input. */
export type SystemColumn = 'id' | 'created_at' | 'updated_at' | 'deleted_at' | 'tenant_id'

/**
 * The options that shape a model's types. They go in the `Model('posts', { … })` call (not in
 * the class body) because TypeScript can only use them to type the class if they are known when
 * the base class is created. It is the TypeScript twin of Laravel 13's `#[Table]`, `#[Fillable]`
 * and `#[Hidden]` attributes, with no decorators.
 *
 * @example
 * class User extends Model('users', { fillable: ['name', 'email'], hidden: ['password'] }) {}
 */
export interface ModelOptions<TTable extends TableName> {
  /** Columns that `create()` / `fill()` accept from untrusted input. Everything else is refused. */
  readonly fillable?: readonly FillableColumn<TTable>[]
  /**
   * Sensitive-looking columns (`is_*`, `*_at`, `*_by`, `role`, `plan`, `user_id`…) that you
   * deliberately let users set. Listing them in `fillable` alone is refused at boot.
   */
  readonly allowSensitive?: readonly FillableColumn<TTable>[]
  /** Columns left out of `toJSON()` (and of its type). */
  readonly hidden?: readonly ColumnOf<TTable>[]
  /** Model casts for JSON types and custom get/set transformations. */
  readonly casts?: { readonly [TColumn in ColumnOf<TTable>]?: Cast<unknown> }
  /** Default page size for `paginate()` (Laravel's `$perPage`). Default 15. */
  readonly perPage?: number
}

/** A column that may appear in `fillable`: any insertable column except Strutvane's own. */
export type FillableColumn<TTable extends TableName> = Exclude<keyof InsertOf<TTable> & string, SystemColumn>

/** "No options given", as a type. */
export type NoOptions = Readonly<Record<never, never>>

type CastsOf<TOptions> = TOptions extends { readonly casts: infer TCasts } ? TCasts : NoOptions
type CastValue<TCast> = TCast extends Cast<infer TValue> ? TValue : never
type KeepNull<TOriginal, TValue> = null extends TOriginal ? TValue | null : TValue

/**
 * A model's attributes: the generated row type with model casts applied.
 *
 * @example
 * type PostAttributes = Attributes<'posts', { casts: { meta: Cast<PostMeta> } }> // meta: PostMeta | null
 */
export type Attributes<TTable extends TableName, TOptions> = {
  -readonly [TColumn in ColumnOf<TTable>]: TColumn extends keyof CastsOf<TOptions> ? KeepNull<RowOf<TTable>[TColumn], CastValue<CastsOf<TOptions>[TColumn]>> : RowOf<TTable>[TColumn]
}

/** What a writable column accepts: the generated insert type with model casts applied. */
export type WritableAttributes<TTable extends TableName, TOptions> = {
  [TColumn in keyof InsertOf<TTable>]: TColumn extends keyof CastsOf<TOptions> ? KeepNull<InsertOf<TTable>[TColumn], CastValue<CastsOf<TOptions>[TColumn]>> : InsertOf<TTable>[TColumn]
}

type FillableOf<TOptions> = TOptions extends { readonly fillable: readonly (infer TColumn)[] } ? TColumn : never

/**
 * The friendly compile error shown when `create()` is used on a model without `fillable`.
 * Hovering the error shows the property name, which is the instruction.
 */
export interface DeclareFillableFirst {
  readonly 'Add fillable: [...] to Model(...) to use create(), or use forceCreate() for trusted data': never
}

/**
 * What `create()` and `fill()` accept: only the fillable columns, with their real types.
 *
 * @example
 * type NewPostInput = CreateInput<'posts', { fillable: ['title'] }> // { title: string }
 */
export type CreateInput<TTable extends TableName, TOptions> = [FillableOf<TOptions>] extends [never]
  ? DeclareFillableFirst
  : Pick<WritableAttributes<TTable, TOptions>, FillableOf<TOptions> & keyof WritableAttributes<TTable, TOptions>>

/** What `forceCreate()` accepts: every writable column except Strutvane's own. */
export type ForceCreateInput<TTable extends TableName, TOptions> = Omit<WritableAttributes<TTable, TOptions>, SystemColumn>

/** The marker every model instance carries (type-level only). */
export interface ModelMarker<TTable extends TableName = TableName, TOptions = object> {
  readonly [MODEL_TYPES]: { readonly table: TTable; readonly options: TOptions }
}

/** Any model instance. */
export type AnyModel = ModelMarker

/**
 * Any model class (its static side). Kept shallow on purpose so checking `typeof Post` against it
 * never needs Post's relation methods, which is what keeps `User ↔ Post` relations non-circular.
 */
export interface AnyModelClass {
  new (): AnyModel
  readonly table: TableName
  readonly options: object
}

/** The instance type of a model class. */
export type InstanceOf<TClass> = TClass extends new () => infer TInstance ? TInstance : never
/** The table of a model class. */
export type TableOf<TClass> = TClass extends { readonly table: infer TTable extends TableName } ? TTable : never
/** The options of a model class. */
export type OptionsOf<TClass> = TClass extends { readonly options: infer TOptions } ? TOptions : never
/** The table of a model instance. */
export type TableOfInstance<TInstance> = TInstance extends { readonly [MODEL_TYPES]: { readonly table: infer TTable extends TableName } } ? TTable : never
/** The primary key type of a model class (`number` for `t.id()`, `string` for `t.uuid('id')`). */
export type KeyOf<TClass> = RowOf<TableOf<TClass>> extends { readonly id: infer TKey } ? TKey : never

/**
 * The value a `where` on `column` accepts: the column's own type (with `null` when nullable).
 *
 * @example
 * type StatusValue = ColumnValue<'posts', 'status'> // 'draft' | 'published'
 */
export type ColumnValue<TTable extends TableName, TColumn extends ColumnOf<TTable>> = RowOf<TTable>[TColumn]

// ---------------------------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------------------------

/** What a relation knows at the type level. */
export interface RelationTypes<TRelated extends AnyModelClass, TMany extends boolean> {
  readonly related: TRelated
  readonly many: TMany
}

/** Anything a relation method returns. */
export interface RelationLike<TRelated extends AnyModelClass = AnyModelClass, TMany extends boolean = boolean> {
  readonly [RELATION_TYPES]: RelationTypes<TRelated, TMany>
}

/**
 * The names of a model's relation methods (`author`, `tags`, …).
 *
 * @example
 * type PostRelations = RelationNames<Post> // 'author' | 'tags'
 */
export type RelationNames<TInstance> = {
  [TKey in CandidateKeys<TInstance>]-?: TKey extends string ? (TInstance[TKey] extends () => RelationLike ? TKey : never) : never
}[CandidateKeys<TInstance>]

/**
 * The built-in model methods. They are never relations, and skipping them matters for the
 * compiler: `load()` and `toJSON()` are typed in terms of relations, so inspecting them while
 * looking for relations would be circular.
 */
export type ModelMethodName =
  | 'isPersisted'
  | 'setAttribute'
  | 'fill'
  | 'forceFill'
  | 'getDirty'
  | 'isDirty'
  | 'trashed'
  | 'save'
  | 'delete'
  | 'forceDelete'
  | 'restore'
  | 'refresh'
  | 'load'
  | 'toJSON'
  | 'runtime'
  | 'belongsTo'
  | 'hasMany'
  | 'belongsToMany'

/** Keys that could be relation methods: everything except the built-ins and the type marker. */
type CandidateKeys<TInstance> = Exclude<keyof TInstance, ModelMethodName | typeof MODEL_TYPES>

/** The related model class of relation `TName`. */
export type RelatedClassOf<TInstance, TName> = TName extends keyof TInstance
  ? TInstance[TName] extends () => { readonly [RELATION_TYPES]: { readonly related: infer TRelated } }
    ? TRelated
    : never
  : never

type IsMany<TInstance, TName> = TName extends keyof TInstance
  ? TInstance[TName] extends () => { readonly [RELATION_TYPES]: { readonly many: infer TMany } }
    ? TMany
    : never
  : never

/** A loaded relation's value: an array for to-many, the model or `null` for to-one. */
type RelationValue<TInstance, TName, TLoaded> = IsMany<TInstance, TName> extends true ? TLoaded[] : TLoaded | null

/** Countdown used to stop relation paths at three levels (User → posts → author → …). */
type Depth = [never, 0, 1, 2]

/**
 * Every eager-loadable path: `'author'`, `'tags'`, `'author.posts'`, … up to three levels deep.
 *
 * @example
 * const path: RelationPath<Post> = 'author.posts'
 */
export type RelationPath<TInstance, TDepth extends number = 3> = [TDepth] extends [never]
  ? never
  : {
      [TName in RelationNames<TInstance>]: TName | `${TName}.${RelationPath<InstanceOf<RelatedClassOf<TInstance, TName>>, Depth[TDepth]>}`
    }[RelationNames<TInstance>]

type HeadOf<TPath extends string> = TPath extends `${infer THead}.${string}` ? THead : TPath
type TailOf<TPath extends string, THead extends string> = TPath extends `${THead}.${infer TTail}` ? TTail : never
type LoadedNested<TInstance, TTail extends string> = [TTail] extends [never] ? TInstance : WithRelations<TInstance, TTail>

/**
 * Add properties to a result type and keep `toJSON()` in sync with them. The new `toJSON` is
 * listed first because TypeScript resolves calls on intersections to the first matching overload.
 */
export type Extend<TResult, TExtra> = { toJSON(): JsonOf<Omit<TResult, keyof TExtra | 'toJSON'> & TExtra> } & Omit<TResult, keyof TExtra | 'toJSON'> & TExtra

/**
 * A model with relations loaded: `post.author` becomes `User | null` (the method is replaced by
 * the data, like Laravel's `$post->author`), nested paths recursively.
 *
 * @example
 * type PostWithAuthor = WithRelations<Post, 'author'> // post.author: User | null
 */
export type WithRelations<TInstance, TPath extends string> = Extend<
  TInstance,
  {
    [TName in HeadOf<TPath> & RelationNames<TInstance>]: RelationValue<TInstance, TName, LoadedNested<InstanceOf<RelatedClassOf<TInstance, TName>>, TailOf<TPath, TName>>>
  }
>

/**
 * A model with `withCount()` columns: `posts_count: number`.
 *
 * @example
 * type UserWithCount = WithCounts<User, 'posts'> // user.posts_count: number
 */
export type WithCounts<TInstance, TName extends string> = Extend<TInstance, { [TCount in TName as `${TCount}_count`]: number }>

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

type HiddenOf<TInstance> = TInstance extends { readonly [MODEL_TYPES]: { readonly options: infer TOptions } }
  ? TOptions extends { readonly hidden: readonly (infer THidden)[] }
    ? THidden
    : never
  : never

type IsJsonKey<TInstance, TKey extends keyof TInstance> = TKey extends HiddenOf<TInstance>
  ? false
  : TKey extends ColumnOf<TableOfInstance<TInstance>>
    ? true
    : TKey extends `${string}_count`
      ? TInstance[TKey] extends number
        ? true
        : false
      : TKey extends string
        ? TInstance[TKey] extends AnyModel | readonly AnyModel[] | null
          ? true
          : false
        : false

type JsonValueOf<TValue> = TValue extends Date ? string : TValue extends readonly AnyModel[] ? JsonOf<TValue[number]>[] : TValue extends AnyModel ? JsonOf<TValue> : TValue

/**
 * A model as JSON: columns minus `hidden`, dates as ISO strings, loaded relations nested, counts
 * included. Methods and the type marker are left out.
 *
 * @example
 * type UserJson = JsonOf<User> // no `password` when it is hidden
 */
export type JsonOf<TInstance> = {
  [TKey in keyof TInstance as IsJsonKey<TInstance, TKey> extends true ? TKey : never]: JsonValueOf<TInstance[TKey]>
}

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

/**
 * The query a scope receives: the filtering half of the builder, typed by table. Scopes see
 * table types only (not the model class), which keeps `static scopes` free of circular types.
 *
 * @example
 * const published = (query: ScopeQuery<'posts'>) => query.where('status', 'published')
 */
export interface ScopeQuery<TTable extends TableName> {
  where<TColumn extends ColumnOf<TTable>>(column: TColumn, value: ColumnValue<TTable, TColumn>): ScopeQuery<TTable>
  where<TColumn extends ColumnOf<TTable>>(column: TColumn, operator: CompareOperator, value: ColumnValue<TTable, TColumn>): ScopeQuery<TTable>
  orWhere<TColumn extends ColumnOf<TTable>>(column: TColumn, value: ColumnValue<TTable, TColumn>): ScopeQuery<TTable>
  orWhere<TColumn extends ColumnOf<TTable>>(column: TColumn, operator: CompareOperator, value: ColumnValue<TTable, TColumn>): ScopeQuery<TTable>
  whereIn<TColumn extends ColumnOf<TTable>>(column: TColumn, values: readonly NonNullable<ColumnValue<TTable, TColumn>>[]): ScopeQuery<TTable>
  whereNull(column: ColumnOf<TTable>): ScopeQuery<TTable>
  whereNotNull(column: ColumnOf<TTable>): ScopeQuery<TTable>
  whereRaw(fragment: SqlFragment): ScopeQuery<TTable>
  orderBy(column: ColumnOf<TTable>, direction?: 'asc' | 'desc'): ScopeQuery<TTable>
}

/**
 * Named scopes on a model: `static scopes = { … } satisfies Scopes<'posts'>`. Extra parameters
 * after the query become the scope method's parameters.
 *
 * @example
 * static scopes = { ofStatus: (query, status: 'draft' | 'published') => query.where('status', status) } satisfies Scopes<'posts'>
 */
export type Scopes<TTable extends TableName> = Readonly<Record<string, (query: ScopeQuery<TTable>, ...args: never[]) => unknown>>

type ScopesOf<TClass> = TClass extends { readonly scopes: infer TScopes } ? TScopes : NoOptions

/** The scope methods a model's query builder gains: `Post.query().published()`. */
export type ScopeMethods<TClass extends AnyModelClass, TResult> = {
  [TName in keyof ScopesOf<TClass>]: ScopesOf<TClass>[TName] extends (query: never, ...args: infer TArgs) => unknown ? (...args: TArgs) => QueryBuilder<TClass, TResult> : never
}

/**
 * The query builder for model class `TClass`, producing `TResult` rows (the model, plus any
 * loaded relations and counts), with the model's scopes as methods.
 *
 * @example
 * const query: QueryBuilder<typeof Post, Post> = Post.query()
 */
export type QueryBuilder<TClass extends AnyModelClass, TResult> = Builder<TClass, TResult> & ScopeMethods<TClass, TResult>

/** The builder for the model a relation points at. */
export type RelatedQuery<TInstance, TName> = QueryBuilder<RelatedClassOf<TInstance, TName> & AnyModelClass, InstanceOf<RelatedClassOf<TInstance, TName>>>
