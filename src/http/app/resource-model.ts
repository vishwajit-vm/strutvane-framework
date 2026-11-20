/**
 * The contract between `ResourceController` and the ORM (spike 12's README, "The ResourceController
 * contract"). The controller never touches SQL: it asks a model class for metadata, a page, a
 * new record, a bound record and a uniqueness answer, and asks a record to update or delete
 * itself. The ORM implements these; the tests use an in-memory model.
 *
 * | ResourceController needs | What the ORM does |
 * |---|---|
 * | `metadata()` | labels, fields, primary key, `internal` flag (from `resources.json`) |
 * | `paginate(query, constraints)` | validate every name against the allow-lists (422 `validation_failed` listing every bad one), then search/filter/sort/paginate, tenant-scoped, with the constraints ANDed in |
 * | `createFromValidated(values)` | insert (only `fillable` keys reach it) |
 * | `record.updateFromValidated(values)` | `fill(values).save()` |
 * | `record.delete()` | soft delete when the table has `deleted_at` |
 * | `resolveRouteBinding(value, field?)` | `where(field ?? routeKey, value).first()`, tenant-scoped; `null` when missing (and for malformed ids, refused before SQL) |
 * | `isTaken(column, value, exceptKey?)` | an `exists()` including trashed rows, tenant-scoped |
 * | `fillable` | the mass-assignment allow-list |
 *
 * @module
 */
import type { UrlRoutable } from '../../routing/types.ts'
import { isInternalTable } from '../../schema/internal-tables.ts'

/**
 * A plain value a constraint compares with.
 *
 * @example
 * const value: ResourceValue = 'published'
 */
export type ResourceValue = string | number | boolean | null

/**
 * An extra list condition (`indexConstraints`): rows this user may see. Constraints in a list are
 * ANDed; `anyOf` ORs its members.
 *
 * @example
 * const visible: Constraint = { anyOf: [{ column: 'status', equals: 'published' }, { column: 'author_id', equals: 7 }] }
 */
export type Constraint =
  | { readonly column: string; readonly equals: ResourceValue }
  | { readonly anyOf: readonly Constraint[] }

/**
 * How a field converts between the database, JSON and forms.
 *
 * @example
 * const cast: FieldCast = 'datetime'
 */
export type FieldCast =
  | 'integer'
  | 'number'
  | 'decimal'
  | 'string'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'

/**
 * One field of a resource, as the default validation and the unique checks read it.
 *
 * @example
 * const title: ResourceField = { name: 'title', label: 'Title', kind: 'string', cast: 'string', nullable: false, required: true, fillable: true, unique: false, hidden: false }
 */
export interface ResourceField {
  readonly name: string
  readonly label: string
  /** The column kind (`id`, `string`, `text`, `foreign_id`…); `id` is never writable. */
  readonly kind: string
  readonly cast: FieldCast
  readonly nullable: boolean
  readonly required: boolean
  /** Writable by default (when the model lists no `fillable`). */
  readonly fillable: boolean
  readonly unique: boolean
  /** Never serialised, never writable. */
  readonly hidden: boolean
  readonly maxLength?: number
  /** The allowed values of an enum-like column. */
  readonly options?: readonly string[]
  /** The table a foreign key points at. */
  readonly references?: string
}

/**
 * One resource (one table), as `ResourceController` reads it.
 *
 * @example
 * Post.metadata().label.singular // 'Post'
 */
export interface ResourceMetadata {
  readonly table: string
  /** The model class name (`Post`). */
  readonly model: string
  readonly label: { readonly singular: string; readonly plural: string }
  readonly primaryKey: string
  readonly fields: readonly ResourceField[]
  /** Set by the schema's `{ internal: true }`: never served by an auto resource controller. */
  readonly internal?: boolean
  /** The table has `deleted_at`: deletes are soft, and `restore` brings a row back. */
  readonly softDeletes?: boolean
}

/**
 * How a route parameter is bound: `withTrashed` also finds soft-deleted rows (Laravel's
 * `->withTrashed()` on a route), which only the `restore` route asks for.
 *
 * @example
 * await Post.resolveRouteBinding('7', undefined, { withTrashed: true })
 */
export interface RouteBindingOptions {
  readonly withTrashed?: boolean
}

/**
 * One page of records.
 *
 * @example
 * const page: ResourcePage<Post> = { data: [post], meta: { page: 1, perPage: 15, total: 1 } }
 */
export interface ResourcePage<TRecord> {
  readonly data: readonly TRecord[]
  readonly meta: Readonly<Record<string, unknown>>
}

/**
 * What `ResourceController` needs from a record.
 *
 * @example
 * const record: ResourceRecord = await Post.resolveRouteBinding('hello-world')
 */
export interface ResourceRecord extends UrlRoutable {
  /** The JSON form (hidden fields left out). */
  toJSON(): unknown
  /** Save validated (already `fillable`-filtered) values. */
  updateFromValidated(values: Readonly<Record<string, unknown>>): Promise<void>
  /** Delete (softly, when the table has `deleted_at`). */
  delete(): Promise<void>
  /** Bring a soft-deleted record back (only on tables with `deleted_at`). */
  restore?(): Promise<unknown>
}

/**
 * What `ResourceController` needs from a model class: the static half of the ORM contract.
 *
 * @example
 * const model: ResourceModel<Post> = Post
 */
export interface ResourceModel<TRecord extends ResourceRecord = ResourceRecord> {
  /** The class name, for messages and policy discovery. */
  readonly name: string
  /** The mass-assignment allow-list. Without it, the metadata's rules apply. */
  readonly fillable?: readonly string[] | undefined
  metadata(): ResourceMetadata
  paginate(
    query: URLSearchParams,
    constraints: readonly Constraint[],
  ): Promise<ResourcePage<TRecord>>
  createFromValidated(values: Readonly<Record<string, unknown>>): Promise<TRecord>
  resolveRouteBinding(
    value: string,
    field?: string,
    options?: RouteBindingOptions,
  ): Promise<TRecord | null>
  /** `true` if any row (soft-deleted ones too) has `column = value`, ignoring the row `exceptKey`. */
  isTaken(column: string, value: string | number, exceptKey?: string | number): Promise<boolean>
  /**
   * The model behind an `?include=` name, so the controller can check the related model's
   * policy (`viewAny`) before its rows are loaded; `undefined` when the name may not be included.
   */
  includable?(name: string): ResourceModel | undefined
  /** Apply `?include=` and `?fields=` to one record (`show`, `update`, `restore`). */
  present?(record: TRecord, query: URLSearchParams): Promise<void>
}

/**
 * Framework and identity tables an auto resource controller must never serve (security review
 * F-01), even when the schema flag is missing. Shared with the metadata generator, so the same
 * tables never get a sidebar entry either.
 *
 * @example
 * INTERNAL_TABLES.has('sessions') // true
 */
export { INTERNAL_TABLES } from '../../schema/internal-tables.ts'

/**
 * `true` when a table must never get an auto resource controller: flagged internal, on the list,
 * or a `team_*` membership table.
 *
 * @example
 * isInternalResource(Session.metadata()) // true
 */
export function isInternalResource(resource: ResourceMetadata): boolean {
  return resource.internal === true || isInternalTable(resource.table)
}
