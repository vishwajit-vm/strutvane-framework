/**
 * The `t` in `schema.create('posts', (t) => { … })`: Laravel's Blueprint, in TypeScript.
 *
 * A Blueprint only records. Each `t.string(…)` call creates a small mutable column draft, because
 * modifiers such as `.nullable()` arrive *after* the call. When the callback returns, the
 * Blueprint turns the drafts into immutable {@link TableAction}s.
 *
 * The public builder types are deliberately narrow (see {@link ColumnBuilder} and friends), so
 * mistakes such as `t.boolean('x').default('yes')` or `t.integer('n').constrained()` fail to
 * compile instead of failing at migrate time.
 *
 * @module
 */

import { pluralize } from '../core/inflection.ts'
import type { ColumnDef, ColumnKind, DefaultValue, ReferentialAction } from './columns.ts'
import { assertIdentifier, SchemaError } from './errors.ts'
import type { TableAction } from './operations.ts'

/**
 * Modifiers every column has. `TValue` is the TypeScript type of the column's values, which is
 * what makes `.default(…)` type-safe.
 *
 * @example
 * t.string('subtitle').nullable().default(null)
 */
export interface ColumnBuilder<TValue> {
  /** Allow SQL `NULL`. Laravel's `->nullable()`. */
  nullable(): this
  /** A literal default value. It must match the column type, and `null` needs `.nullable()`. */
  default(value: TValue | null): this
  /** Add a unique index named `<table>_<column>_unique`. */
  unique(): this
  /** Add a plain index named `<table>_<column>_index`. */
  index(): this
  /** Store a comment on the column (PostgreSQL / MySQL). */
  comment(text: string): this
  /**
   * Never return this column from the API or `toJSON()`, and never let a request filter, sort or
   * search on it (that would reveal its value one query at a time).
   */
  hidden(): this
  /**
   * A secret (an API key, a hash): hidden, redacted in logs, and never named in "did you mean"
   * hints. Columns named `password`, `*_token` or `*_secret` are secret automatically.
   */
  secret(): this
}

/**
 * A UUID column. `.primary()` makes it the table's primary key: a time-ordered UUIDv7 the
 * framework generates on create (decision #93), instead of `t.id()`'s auto-increment.
 *
 * @example
 * t.uuid('id').primary()
 */
export interface UuidColumnBuilder extends ColumnBuilder<string> {
  /** Make this UUID the primary key. */
  primary(): this
}

/**
 * A slug column. Slugs are unique automatically, and `.from('title')` says which column the
 * CRUD API should build the slug from when the client doesn't send one.
 *
 * @example
 * t.slug('slug').from('title')
 */
export interface SlugColumnBuilder extends ColumnBuilder<string> {
  /** The column whose value is turned into the slug, for example `title`. */
  from(column: string): this
}

/**
 * A foreign key column (`bigint`, Laravel's `foreignId`).
 *
 * @example
 * t.foreignId('author_id').constrained('users').cascadeOnDelete()
 */
export interface ForeignIdColumnBuilder extends ColumnBuilder<number> {
  /**
   * Reference another table. With no table name it is guessed from the column, Laravel-style:
   * `category_id` → `categories`.
   */
  constrained(table?: string, column?: string): this
  /** Delete this row when the parent row is deleted. */
  cascadeOnDelete(): this
  /** Set this column to `NULL` when the parent row is deleted (the column must be nullable). */
  nullOnDelete(): this
  /** Refuse to delete a parent row that still has children. */
  restrictOnDelete(): this
}

/**
 * A foreign key column holding a UUID (Laravel's `foreignUuid`), for parents whose key is
 * `t.uuid('id').primary()`.
 *
 * @example
 * t.foreignUuid('project_id').constrained().cascadeOnDelete()
 */
export interface ForeignUuidColumnBuilder extends ColumnBuilder<string> {
  /** Reference another table; the table is guessed from the column name when left out. */
  constrained(table?: string, column?: string): this
  /** Delete this row when the parent row is deleted. */
  cascadeOnDelete(): this
  /** Set this column to `NULL` when the parent row is deleted (the column must be nullable). */
  nullOnDelete(): this
  /** Refuse to delete a parent row that still has children. */
  restrictOnDelete(): this
}

/**
 * The recorder behind {@link ColumnBuilder}: one class implementing every builder interface.
 * Callers only ever see the narrow interfaces, so they can't call `from()` on a boolean.
 */
class ColumnDraft
  implements SlugColumnBuilder, ForeignIdColumnBuilder, ForeignUuidColumnBuilder, UuidColumnBuilder
{
  readonly #table: string
  #column: { -readonly [K in keyof ColumnDef]: ColumnDef[K] }
  #unique = false
  #indexed = false
  #constrainedTo: { table: string; column: string } | undefined
  #onDelete: ReferentialAction = 'no action'

  constructor(table: string, column: ColumnDef) {
    assertIdentifier(column.name, 'column')
    this.#table = table
    this.#column = { ...column }
  }

  nullable(): this {
    this.#column.nullable = true
    return this
  }

  default(value: DefaultValue): this {
    this.#column.default = value
    return this
  }

  unique(): this {
    this.#unique = true
    return this
  }

  index(): this {
    this.#indexed = true
    return this
  }

  comment(text: string): this {
    this.#column.comment = text
    return this
  }

  hidden(): this {
    this.#column.hidden = true
    return this
  }

  secret(): this {
    this.#column.secret = true
    this.#column.hidden = true
    return this
  }

  primary(): this {
    this.#column.primary = true
    return this
  }

  from(column: string): this {
    this.#column.slugFrom = column
    return this
  }

  constrained(table?: string, column = 'id'): this {
    this.#constrainedTo = { table: table ?? guessParentTable(this.#column.name), column }
    return this
  }

  cascadeOnDelete(): this {
    this.#onDelete = 'cascade'
    return this
  }

  nullOnDelete(): this {
    this.#onDelete = 'set null'
    return this
  }

  restrictOnDelete(): this {
    this.#onDelete = 'restrict'
    return this
  }

  /** Freeze the draft into actions: the column first, then any index it asked for. */
  toActions(): TableAction[] {
    const column = this.#finishColumn()
    const actions: TableAction[] = [{ type: 'addColumn', column }]
    // Slugs are looked up by value, so they are unique even if the migration forgot `.unique()`.
    if (this.#unique || column.kind === 'slug') {
      actions.push({ type: 'addIndex', index: indexFor(this.#table, column.name, true) })
    } else if (this.#indexed) {
      actions.push({ type: 'addIndex', index: indexFor(this.#table, column.name, false) })
    }
    return actions
  }

  #finishColumn(): ColumnDef {
    const column = this.#column
    if (this.#constrainedTo !== undefined) {
      column.references = { ...this.#constrainedTo, onDelete: this.#onDelete }
    } else if (this.#onDelete !== 'no action') {
      throw new SchemaError(
        'invalid_foreign_key',
        `Column "${this.#table}.${column.name}" sets an on-delete rule but doesn't reference a table.`,
        `Call .constrained() before .cascadeOnDelete() / .nullOnDelete(), for example t.foreignId('${column.name}').constrained().cascadeOnDelete().`,
      )
    }
    if (column.tenant === true && (column.nullable || 'default' in column)) {
      throw new SchemaError(
        'invalid_tenancy',
        `The tenant column "${this.#table}.${column.name}" can't be nullable or have a default: every row belongs to exactly one tenant.`,
        `Use t.tenant('${column.name}') on its own; Strutvane fills it in from the current tenant.`,
      )
    }
    if (column.primary === true && column.nullable) {
      throw new SchemaError(
        'invalid_column',
        `The primary key "${this.#table}.${column.name}" can't be nullable.`,
        `Remove .nullable() from t.uuid('${column.name}').primary().`,
      )
    }
    validateDefault(this.#table, column)
    return { ...column }
  }
}

function guessParentTable(column: string): string {
  if (!column.endsWith('_id')) {
    throw new SchemaError(
      'invalid_foreign_key',
      `Can't guess which table "${column}" points to.`,
      `Name the table explicitly, for example .constrained('users'), or name the column "<thing>_id".`,
    )
  }
  return pluralize(column.slice(0, -3))
}

function indexFor(
  table: string,
  column: string,
  unique: boolean,
): { name: string; columns: string[]; unique: boolean } {
  return { name: `${table}_${column}_${unique ? 'unique' : 'index'}`, columns: [column], unique }
}

/**
 * Catch defaults that would only blow up at migrate time, or that would make the generated types
 * lie. TypeScript already blocks most of these in `.ts` migrations; this is the runtime safety net
 * for plain JavaScript and for values that are type-correct but out of range.
 */
function validateDefault(table: string, column: ColumnDef): void {
  if (!('default' in column)) return
  const value = column.default
  const where = `"${table}.${column.name}"`
  if (value === null) {
    if (column.nullable) return
    throw new SchemaError(
      'invalid_default',
      `Column ${where} defaults to null but isn't nullable.`,
      'Add .nullable() before .default(null), or pick a non-null default.',
    )
  }
  if (column.kind === 'enum' && !(column.values ?? []).includes(String(value))) {
    throw new SchemaError(
      'invalid_default',
      `Column ${where} defaults to ${JSON.stringify(value)}, which isn't one of its allowed values.`,
      `Use one of: ${(column.values ?? []).map((allowed) => JSON.stringify(allowed)).join(', ')}.`,
    )
  }
  const expected = EXPECTED_DEFAULT_TYPE[column.kind]
  if (!expected.includes(typeof value)) {
    throw new SchemaError(
      'invalid_default',
      `Column ${where} is a ${column.kind} column, but its default ${JSON.stringify(value)} is a ${typeof value}.`,
      `Use a ${expected.join(' or ')} default for ${column.kind} columns.`,
    )
  }
}

const EXPECTED_DEFAULT_TYPE: Readonly<Record<ColumnKind, readonly string[]>> = {
  id: [],
  integer: ['number'],
  bigInteger: ['number'],
  foreignId: ['number'],
  double: ['number'],
  // Decimals accept '0.00' as well as 0, because a string is the only exact way to write 0.1.
  decimal: ['number', 'string'],
  string: ['string'],
  text: ['string'],
  slug: ['string'],
  uuid: ['string'],
  enum: ['string'],
  date: ['string'],
  timestamp: ['string'],
  boolean: ['boolean'],
  json: [],
}

/**
 * Non-empty tuple of enum values. Requiring at least one value makes `t.enum('x', [])` a compile
 * error: an enum nothing can be stored in is always a mistake.
 *
 * @example
 * const statuses: EnumValues = ['draft', 'published']
 */
export type EnumValues = readonly [string, ...string[]]

/**
 * The table builder handed to `schema.create` and `schema.table` callbacks.
 *
 * @example
 * schema.create('posts', (t) => {
 *   t.id()
 *   t.string('title', 200)
 *   t.slug('slug').from('title')
 * })
 */
export class Blueprint {
  readonly #table: string
  readonly #steps: (ColumnDraft | TableAction)[] = []

  constructor(table: string) {
    this.#table = table
  }

  /** The auto-incrementing primary key `id` (`bigint`), Laravel's `$table->id()`. */
  id(name = 'id'): ColumnBuilder<number> {
    return this.#add({ name, kind: 'id', nullable: false })
  }

  /** A 32-bit integer column. */
  integer(name: string): ColumnBuilder<number> {
    return this.#add({ name, kind: 'integer', nullable: false })
  }

  /** A 64-bit integer column. Values beyond ±2^53 lose precision in JavaScript numbers. */
  bigInteger(name: string): ColumnBuilder<number> {
    return this.#add({ name, kind: 'bigInteger', nullable: false })
  }

  /** A short text column, 255 characters unless you say otherwise. */
  string(name: string, length = 255): ColumnBuilder<string> {
    assertPositiveInteger(this.#table, name, 'length', length)
    return this.#add({ name, kind: 'string', nullable: false, length })
  }

  /** A long text column with no length limit. */
  text(name: string): ColumnBuilder<string> {
    return this.#add({ name, kind: 'text', nullable: false })
  }

  /**
   * A unique, URL-safe slug. Strutvane-specific (Laravel needs a package for this): the CRUD API
   * fills it in from the `.from(…)` column and keeps it unique.
   */
  slug(name = 'slug', length = 255): SlugColumnBuilder {
    assertPositiveInteger(this.#table, name, 'length', length)
    return this.#add({ name, kind: 'slug', nullable: false, length })
  }

  /**
   * A UUID stored as text (SQLite, MySQL) or native `uuid` (PostgreSQL). `t.uuid('id').primary()`
   * makes it a UUIDv7 primary key.
   */
  uuid(name: string): UuidColumnBuilder {
    return this.#add({ name, kind: 'uuid', nullable: false })
  }

  /**
   * The tenant column (`tenant_id` unless named otherwise): a required UUID saying which tenant a
   * row belongs to. In a tenant table, `.unique()` means "unique per tenant", the table gets a
   * unique `(tenant, id)` key, and foreign keys to other tenant tables become composite, so no row
   * can ever point at another tenant's data (security review F-05).
   */
  tenant(name = 'tenant_id'): ColumnBuilder<string> {
    return this.#add({ name, kind: 'uuid', nullable: false, tenant: true })
  }

  /**
   * An exact decimal, for money and quantities. Values are strings in TypeScript (`'12.50'`)
   * because JavaScript numbers can't hold every decimal exactly.
   */
  decimal(name: string, precision = 8, scale = 2): ColumnBuilder<number | string> {
    assertPositiveInteger(this.#table, name, 'precision', precision)
    if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
      throw new SchemaError(
        'invalid_column',
        `Column "${this.#table}.${name}" has scale ${scale}, which doesn't fit precision ${precision}.`,
        "Use a scale between 0 and the precision, for example t.decimal('price', 12, 2).",
      )
    }
    return this.#add({ name, kind: 'decimal', nullable: false, precision, scale })
  }

  /** A floating-point number. Use `decimal` for money. */
  double(name: string): ColumnBuilder<number> {
    return this.#add({ name, kind: 'double', nullable: false })
  }

  /** A true/false column. */
  boolean(name: string): ColumnBuilder<boolean> {
    return this.#add({ name, kind: 'boolean', nullable: false })
  }

  /**
   * One of a fixed list of strings. The values become a union type in TypeScript, so
   * `.default('archived')` on `['draft', 'published']` fails to compile.
   */
  enum<const TValues extends EnumValues>(
    name: string,
    values: TValues,
  ): ColumnBuilder<TValues[number]> {
    if (new Set(values).size !== values.length) {
      throw new SchemaError(
        'invalid_column',
        `Enum "${this.#table}.${name}" lists the same value twice.`,
        'Remove the duplicate value.',
      )
    }
    return this.#add({ name, kind: 'enum', nullable: false, values: [...values] })
  }

  /** A calendar date without a time (`'2026-11-14'`). */
  date(name: string): ColumnBuilder<string> {
    return this.#add({ name, kind: 'date', nullable: false })
  }

  /** A point in time, stored with time zone in PostgreSQL. */
  timestamp(name: string): ColumnBuilder<string> {
    return this.#add({ name, kind: 'timestamp', nullable: false })
  }

  /** Any JSON value. Typed as `JsonValue`; defaults aren't supported because they differ per database. */
  json(name: string): ColumnBuilder<never> {
    return this.#add({ name, kind: 'json', nullable: false })
  }

  /** A `bigint` column meant to hold another table's id. Chain `.constrained()` to add the foreign key. */
  /** A UUID column meant to hold another table's UUID key. Chain `.constrained()` for the key. */
  foreignUuid(name: string): ForeignUuidColumnBuilder {
    return this.#add({ name, kind: 'uuid', nullable: false })
  }

  foreignId(name: string): ForeignIdColumnBuilder {
    return this.#add({ name, kind: 'foreignId', nullable: false })
  }

  /** Nullable `created_at` and `updated_at`, which the framework fills in on every write. */
  timestamps(): void {
    this.#add({ name: 'created_at', kind: 'timestamp', nullable: true })
    this.#add({ name: 'updated_at', kind: 'timestamp', nullable: true })
  }

  /** A nullable `deleted_at`. Rows with a value are hidden from lists and treated as deleted. */
  softDeletes(): void {
    this.#add({ name: 'deleted_at', kind: 'timestamp', nullable: true })
  }

  /** Rename a column. Only allowed in `schema.table`, never in `schema.create`. */
  renameColumn(from: string, to: string): void {
    assertIdentifier(to, 'column')
    this.#steps.push({ type: 'renameColumn', from, to })
  }

  /** Drop one or more columns, and any index that only covers them. */
  dropColumn(...names: string[]): void {
    for (const name of names) this.#steps.push({ type: 'dropColumn', name })
  }

  /** Drop a foreign key column together with its constraint (Laravel's `dropConstrainedForeignId`). */
  dropConstrainedForeignId(name: string): void {
    this.dropColumn(name)
  }

  /** Drop `created_at` and `updated_at`. */
  dropTimestamps(): void {
    this.dropColumn('created_at', 'updated_at')
  }

  /** Drop `deleted_at`. */
  dropSoftDeletes(): void {
    this.dropColumn('deleted_at')
  }

  /** Add a unique index over one or more columns. The name defaults to Laravel's convention. */
  unique(columns: string | readonly string[], name?: string): void {
    this.#addIndex(columns, true, name)
  }

  /** Add a plain index over one or more columns. */
  index(columns: string | readonly string[], name?: string): void {
    this.#addIndex(columns, false, name)
  }

  /** Drop an index by name, for example `posts_title_index`. */
  dropIndex(name: string): void {
    this.#steps.push({ type: 'dropIndex', name })
  }

  /** Drop a unique index by name. Same as {@link dropIndex}; kept for Laravel familiarity. */
  dropUnique(name: string): void {
    this.dropIndex(name)
  }

  /**
   * Everything the callback asked for, frozen, in call order.
   * Called by the schema recorder once the callback has returned.
   */
  toActions(): TableAction[] {
    return this.#steps.flatMap((step) => (step instanceof ColumnDraft ? step.toActions() : [step]))
  }

  #add(column: ColumnDef): ColumnDraft {
    const draft = new ColumnDraft(this.#table, column)
    this.#steps.push(draft)
    return draft
  }

  #addIndex(columns: string | readonly string[], unique: boolean, name: string | undefined): void {
    const list = typeof columns === 'string' ? [columns] : [...columns]
    const indexName = name ?? `${this.#table}_${list.join('_')}_${unique ? 'unique' : 'index'}`
    assertIdentifier(indexName, 'index')
    this.#steps.push({ type: 'addIndex', index: { name: indexName, columns: list, unique } })
  }
}

function assertPositiveInteger(table: string, column: string, what: string, value: number): void {
  if (Number.isInteger(value) && value > 0) return
  throw new SchemaError(
    'invalid_column',
    `Column "${table}.${column}" has ${what} ${value}, which isn't a positive whole number.`,
    `Pass a ${what} such as 255.`,
  )
}
