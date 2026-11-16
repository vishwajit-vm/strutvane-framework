/**
 * The plain-data vocabulary of a database schema.
 *
 * Everything in this file is data, never behaviour: it describes a table the way the migrations
 * left it. The recorder builds it, the generators (types, metadata, SQL) read it, the ORM reads
 * it at runtime (`.strutvane/schema.json`), and the introspector compares a real database against
 * it. Keeping it dumb and serialisable is what lets the whole pipeline run offline and stay
 * deterministic.
 *
 * @module
 */

/**
 * Every column kind the migration builder can create.
 *
 * Why a closed list: each kind maps to exactly one TypeScript type, one SQL type per dialect, one
 * validation rule and one UI widget. Adding a kind means touching each of those on purpose.
 *
 * @example
 * const kind: ColumnKind = 'decimal'
 */
export type ColumnKind =
  | 'id'
  | 'integer'
  | 'bigInteger'
  | 'string'
  | 'text'
  | 'slug'
  | 'uuid'
  | 'decimal'
  | 'double'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'timestamp'
  | 'json'
  | 'foreignId'

/**
 * What happens to rows that point at a parent row when the parent is deleted.
 *
 * @example
 * const onDelete: ReferentialAction = 'cascade'
 */
export type ReferentialAction = 'cascade' | 'set null' | 'restrict' | 'no action'

/**
 * The tenant half of a composite foreign key: the child's tenant column and the parent's.
 *
 * @example
 * const tenant: TenantKeyDef = { column: 'tenant_id', parentColumn: 'tenant_id' }
 */
export interface TenantKeyDef {
  /** The tenant column of the child table (the table holding the key). */
  readonly column: string
  /** The tenant column of the parent table. */
  readonly parentColumn: string
}

/**
 * A foreign key: "this column holds an id from that table".
 *
 * @example
 * const fk: ForeignKeyDef = { table: 'users', column: 'id', onDelete: 'cascade' }
 */
export interface ForeignKeyDef {
  /** The parent table, for example `users`. */
  readonly table: string
  /** The parent column, almost always `id`. */
  readonly column: string
  /** What the database does to this row when the parent row is deleted. */
  readonly onDelete: ReferentialAction
  /**
   * The constraint's name, fixed when the column is added (`posts_author_id_foreign`). MySQL keeps
   * it through table and column renames, so it must be remembered, not re-derived when dropping.
   */
  readonly name?: string
  /**
   * Set when both tables are tenant tables (security review F-05): the key is composite,
   * `(<tenant column>, column)` → parent `(<parent tenant column>, <parent column>)`, so a row can
   * never point at another tenant's parent and a cascade can never cross tenants. The recorder
   * fills it in; migrations never write it by hand.
   */
  readonly tenant?: TenantKeyDef
}

/**
 * A literal default value. Only literals are allowed, so the same default can be written into
 * SQLite, PostgreSQL and MySQL DDL and into TypeScript `New*` types without running any code.
 *
 * @example
 * const fallback: DefaultValue = 'draft'
 */
export type DefaultValue = string | number | boolean | null

/**
 * One column, fully resolved.
 *
 * @example
 * const title: ColumnDef = { name: 'title', kind: 'string', nullable: false, length: 200 }
 */
export interface ColumnDef {
  readonly name: string
  readonly kind: ColumnKind
  /** `true` when the column accepts SQL `NULL` (and the TypeScript type gains `| null`). */
  readonly nullable: boolean
  /** Present only when the migration called `.default(…)`. `null` is a real default here. */
  readonly default?: DefaultValue
  /** Maximum characters for `string` / `slug`. */
  readonly length?: number
  /** Total digits for `decimal`. */
  readonly precision?: number
  /** Digits after the decimal point for `decimal`. */
  readonly scale?: number
  /** Allowed values for `enum`, in declaration order. */
  readonly values?: readonly string[]
  /** For `slug`: the column the slug is generated from, for example `title`. */
  readonly slugFrom?: string
  /** Present when the column references another table. */
  readonly references?: ForeignKeyDef
  /** A free-text comment stored in the database (PostgreSQL / MySQL only). */
  readonly comment?: string
  /**
   * `t.uuid('id').primary()`: the table's primary key is a UUIDv7 the framework generates,
   * instead of the auto-increment `t.id()` (decision #93).
   */
  readonly primary?: true
  /** `t.tenant()`: the column that says which tenant a row belongs to. At most one per table. */
  readonly tenant?: true
  /** `.hidden()`: never returned by the API or `toJSON()`, never filtered, sorted or searched. */
  readonly hidden?: true
  /**
   * `.secret()`: hidden, and also redacted in logs and never named in hints (passwords, tokens).
   * Columns named like secrets (`password`, `*_token`, `*_secret`) are secret without asking.
   */
  readonly secret?: true
}

/**
 * An index on one or more columns. Named the way Laravel names them (`posts_slug_unique`), so
 * people coming from Laravel recognise them in `\d posts`.
 *
 * @example
 * const idx: IndexDef = { name: 'posts_slug_unique', columns: ['slug'], unique: true }
 */
export interface IndexDef {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
}

/**
 * A table as the migrations left it. Column order is the order columns were added, which is also
 * the order the generators print them in: that keeps generated files stable and readable.
 *
 * @example
 * const empty: TableState = { name: 'posts', columns: [], indexes: [] }
 */
export interface TableState {
  readonly name: string
  readonly columns: readonly ColumnDef[]
  readonly indexes: readonly IndexDef[]
  /**
   * `schema.create(name, fn, { global: true })`: shared reference data, deliberately visible to
   * every tenant. With tenancy on, a table with neither a tenant column nor this flag is refused
   * by the ORM (fail closed, security review F-04).
   */
  readonly global?: true
  /**
   * `schema.create(name, fn, { internal: true })`: framework bookkeeping (sessions, jobs, …). It
   * gets no API resource, no UI screen and no sidebar entry.
   */
  readonly internal?: true
}

/**
 * The whole schema: every table, in creation order.
 *
 * @example
 * const nothingYet: SchemaState = { tables: [] }
 */
export interface SchemaState {
  readonly tables: readonly TableState[]
}

/**
 * The runtime schema the ORM reads at boot (`.strutvane/schema.json`): every table by name, as
 * the migrations left it. Types can't carry facts such as "this column is a boolean" (SQLite
 * returns `0`/`1`) or "this is the slug and its source" into JavaScript, so the ORM reads them here.
 *
 * @example
 * const snapshot: SchemaSnapshot = { version: 1, tables: { tags: { name: 'tags', columns: [], indexes: [] } } }
 */
export interface SchemaSnapshot {
  /** The file format version; bumped only for incompatible changes. */
  readonly version: 1
  readonly tables: Readonly<Record<string, TableState>>
}

/**
 * An empty schema, the starting point before the first migration runs.
 *
 * @example
 * replayMigrations(loaded, EMPTY_SCHEMA)
 */
export const EMPTY_SCHEMA: SchemaState = Object.freeze({ tables: Object.freeze([]) })

/**
 * Find a table by name.
 *
 * @example
 * const posts = findTable(state, 'posts') // TableState | undefined
 */
export function findTable(state: SchemaState, name: string): TableState | undefined {
  return state.tables.find((table) => table.name === name)
}

/**
 * Find a column by name.
 *
 * @example
 * const title = findColumn(posts, 'title') // ColumnDef | undefined
 */
export function findColumn(table: TableState, name: string): ColumnDef | undefined {
  return table.columns.find((column) => column.name === name)
}

/**
 * The tenant column of a table (`t.tenant()`), if it has one.
 *
 * @example
 * tenantColumnOf(projects)?.name // 'tenant_id'
 */
export function tenantColumnOf(table: TableState): ColumnDef | undefined {
  return table.columns.find((column) => column.tenant === true)
}

/**
 * The primary key column: `t.id()` or `t.uuid('id').primary()`.
 *
 * @example
 * primaryKeyOf(posts)?.name // 'id'
 */
export function primaryKeyOf(table: TableState): ColumnDef | undefined {
  return table.columns.find((column) => column.kind === 'id' || column.primary === true)
}

/**
 * Columns the database or the framework fills in by itself, so neither a create form nor a `New*`
 * type asks for them: the primary key (auto-increment or UUIDv7), the tenant column (taken from
 * the current tenant, never from input), and the timestamps stamped on every write.
 *
 * @example
 * isManagedColumn({ name: 'created_at', kind: 'timestamp', nullable: true }) // true
 */
export function isManagedColumn(column: ColumnDef): boolean {
  if (column.kind === 'id' || column.primary === true || column.tenant === true) return true
  return MANAGED_TIMESTAMPS.has(column.name) && column.kind === 'timestamp'
}

/**
 * Timestamp columns the framework writes itself (Laravel's `timestamps()` and `softDeletes()`).
 *
 * @example
 * MANAGED_TIMESTAMPS.has('updated_at') // true
 */
export const MANAGED_TIMESTAMPS: ReadonlySet<string> = new Set([
  'created_at',
  'updated_at',
  'deleted_at',
])

/**
 * Column names that hold secrets. They are never returned by the API, never searched and never
 * shown in the UI, whatever the migration says. This mirrors Laravel's `$hidden` defaults.
 *
 * @example
 * isSensitiveColumn('password') // true
 */
export function isSensitiveColumn(name: string): boolean {
  return SENSITIVE_NAMES.has(name) || name.endsWith('_secret') || name.endsWith('_token')
}

const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  'password',
  'remember_token',
  'two_factor_secret',
])

/**
 * Is this column a secret: `.secret()`, or named like one (see {@link isSensitiveColumn})?
 * Secrets are hidden, redacted in logs and never named in "did you mean" hints.
 *
 * @example
 * isSecretColumn({ name: 'api_token', kind: 'string', nullable: true }) // true
 */
export function isSecretColumn(column: ColumnDef): boolean {
  return column.secret === true || isSensitiveColumn(column.name)
}

/**
 * Is this column kept out of API output, `toJSON()`, filters, sorts, search and hints:
 * `.hidden()`, `.secret()` or a secret-looking name?
 *
 * @example
 * isHiddenColumn({ name: 'internal_note', kind: 'text', nullable: true, hidden: true }) // true
 */
export function isHiddenColumn(column: ColumnDef): boolean {
  return column.hidden === true || isSecretColumn(column)
}
