/**
 * The bridge between migrations and models, at compile time and at runtime.
 *
 * - **Compile time:** {@link TableRegistry} is empty here. The generated
 *   `.strutvane/types.d.ts` fills it through declaration merging, exactly like spike 10's
 *   `models.d.ts`. That is how `Model('posts')` knows a post has `title: string` without the
 *   model file declaring it.
 * - **Runtime:** {@link registerSchema} receives the snapshot (also generated) and
 *   {@link tableInfo} answers the questions the ORM asks about a table, once, cached.
 */
// Declared in the public entry, the module generated types augment (declaration merging only
// reaches the module that declares an interface, never one that re-exports it).
import type { TableRegistry } from '../../entries/database.ts'
import { OrmUsageError } from '../orm/errors.ts'
import type { ColumnDef, SchemaSnapshot, TableState } from './snapshot.ts'

/**
 * The four shapes of one table, as the type generator writes them.
 *
 * @example
 * type PostShapes = { row: Post; insert: NewPost; update: PostPatch; json: PostJson }
 */
export interface TableShapes {
  readonly row: object
  readonly insert: object
  readonly update: object
  readonly json: object
}

export type { TableRegistry }

/**
 * The name of any table the migrations created.
 *
 * @example
 * const table: TableName = 'posts' // 'post' would not compile
 */
export type TableName = keyof TableRegistry & string

/**
 * A row of a table, as the database returns it after the built-in casts (timestamps as `Date`).
 *
 * @example
 * type PostRow = RowOf<'posts'>
 */
export type RowOf<TTable extends TableName> = TableRegistry[TTable] extends {
  readonly row: infer TRow
}
  ? TRow
  : never

/**
 * What inserting a row needs: required columns are required, defaulted ones optional.
 *
 * @example
 * type NewPostInput = InsertOf<'posts'>
 */
export type InsertOf<TTable extends TableName> = TableRegistry[TTable] extends {
  readonly insert: infer TInsert
}
  ? TInsert
  : never

/**
 * A column name of a table.
 *
 * @example
 * const column: ColumnOf<'posts'> = 'title'
 */
export type ColumnOf<TTable extends TableName> = keyof RowOf<TTable> & string

/**
 * Everything the ORM needs to know about one table, derived once from the snapshot.
 *
 * @example
 * tableInfo('posts').softDeletes // true when the migration called t.softDeletes()
 */
export interface TableInfo {
  readonly name: string
  readonly columns: ReadonlyMap<string, ColumnDef>
  /** The primary key column (`id` in every Strutvane migration). */
  readonly primaryKey: ColumnDef
  /** `created_at` and `updated_at` both exist, so the ORM maintains them. */
  readonly timestamps: boolean
  /** `deleted_at` exists, so deletes are soft by default. */
  readonly softDeletes: boolean
  /** Slug columns and the column each is generated from. */
  readonly slugs: readonly ColumnDef[]
  /** For each slug column: the other columns of its unique index (the uniqueness scope). */
  readonly slugScopes: ReadonlyMap<string, readonly string[]>
}

/** Column names the ORM manages itself. */
export const SYSTEM_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
} as const

let snapshot: SchemaSnapshot | undefined
const infoCache = new Map<string, TableInfo>()

/**
 * Hand the ORM the schema snapshot. The generated `.strutvane/schema.ts` calls this at boot.
 * Registering again (watch mode after `node strut migrate`) replaces the snapshot and clears caches.
 *
 * @example
 * registerSchema(snapshot)
 */
export function registerSchema(next: SchemaSnapshot): void {
  snapshot = next
  infoCache.clear()
}

/**
 * The derived facts about a table. Throws a friendly error when the table is unknown, which
 * nearly always means the migrations were not run or the types are stale.
 *
 * @example
 * tableInfo('posts').primaryKey.name // 'id'
 */
export function tableInfo(table: string): TableInfo {
  const cached = infoCache.get(table)
  if (cached !== undefined) return cached
  const state = ownTable(table)
  if (state === undefined) {
    const hint =
      snapshot === undefined
        ? 'No schema is registered yet: call registerSchema(snapshot) at boot.'
        : 'Did you create it in a migration and run `node strut migrate`?'
    throw new OrmUsageError(
      'unknown_table',
      `The table "${table}" is not in the schema snapshot. ${hint}`,
    )
  }
  const info = deriveInfo(state)
  infoCache.set(table, info)
  return info
}

/**
 * Does a table exist in the registered snapshot? Used to validate pivot tables.
 *
 * @example
 * hasTable('post_tag') // true
 */
export function hasTable(table: string): boolean {
  return ownTable(table) !== undefined
}

/**
 * The column names of any table, including pivot tables that have no `id` and no model.
 * Throws the same friendly error as {@link tableInfo} for unknown tables.
 *
 * @example
 * tableColumns('post_tag') // Set { 'post_id', 'tag_id' }
 */
export function tableColumns(table: string): ReadonlySet<string> {
  return new Set(tableState(table).columns.map((column) => column.name))
}

/**
 * The raw state of any table (pivots included), or the friendly "unknown table" error.
 *
 * @example
 * tableState('post_tag').global // true
 */
export function tableState(table: string): TableState {
  const state = ownTable(table)
  if (state === undefined) {
    throw new OrmUsageError(
      'unknown_table',
      `The table "${table}" is not in the schema snapshot. Did you create it in a migration and run \`node strut migrate\`?`,
    )
  }
  return state
}

/**
 * Every table name in the snapshot.
 *
 * @example
 * allTables() // ['users', 'posts', …]
 */
export function allTables(): string[] {
  return Object.keys(snapshot?.tables ?? {})
}

/** A table of the snapshot by name: own entries only (never `constructor` from the prototype). */
function ownTable(table: string): TableState | undefined {
  const tables = snapshot?.tables
  return tables !== undefined && Object.hasOwn(tables, table) ? tables[table] : undefined
}

function deriveInfo(state: TableState): TableInfo {
  const columns = new Map(state.columns.map((column) => [column.name, column]))
  const primaryKey = columns.get('id')
  if (primaryKey === undefined) {
    throw new OrmUsageError(
      'no_primary_key',
      `"${state.name}" has no "id" column. Models need t.id() (or t.uuid('id')) in the migration; pivot tables don't need a model.`,
    )
  }
  const slugs = state.columns.filter((column) => column.kind === 'slug')
  return {
    name: state.name,
    columns,
    primaryKey,
    timestamps: columns.has(SYSTEM_COLUMNS.createdAt) && columns.has(SYSTEM_COLUMNS.updatedAt),
    softDeletes: columns.has(SYSTEM_COLUMNS.deletedAt),
    slugs,
    slugScopes: new Map(slugs.map((slug) => [slug.name, uniqueScopeOf(state, slug.name)])),
  }
}

/**
 * The columns a slug must be unique *together with*. A slug in a tenant table is normally
 * unique per tenant (`unique(['tenant_id', 'slug'])`), so `my-project` may exist once per tenant.
 */
function uniqueScopeOf(state: TableState, slugColumn: string): readonly string[] {
  const index = state.indexes.find(
    (candidate) => candidate.unique && candidate.columns.includes(slugColumn),
  )
  return index === undefined ? [] : index.columns.filter((column) => column !== slugColumn)
}

/**
 * Any value a JSON column can hold (what `t.json()` columns are typed as until a model cast
 * gives them a precise type).
 *
 * @example
 * const meta: JsonValue = { tags: ['a', 'b'], pinned: true }
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
