/**
 * `defineModel`: the single source of truth for a resource (ADR-0003).
 *
 * ```ts
 * export const Invoice = defineModel('Invoice', {
 *   number: field.string(32).unique().searchable(),
 *   amount: field.decimal(12, 2).sortable(),
 *   status: field.enum(['draft', 'paid']).default('draft').filterable(),
 *   customer: field.belongsTo('Customer').filterable(),
 *   lines: field.hasMany('InvoiceLine'),
 * }, { tenant: true, softDeletes: true })
 * ```
 *
 * The result is plain, frozen data (`definition`) plus phantom types for inference. Every other
 * layer — schema compiler, migrations, repository, validation, HTTP, OpenAPI, manifest — reads the
 * same definition, so they can never disagree.
 *
 * @module
 */
import { type AnyFieldBuilder, type FieldBuilder, type FieldDef, HasManyBuilder } from './field.ts'
import {
  FIELD_KEY_PATTERN,
  humanLabel,
  kebabCase,
  lowerCamel,
  MODEL_NAME_PATTERN,
  pluralize,
  RESERVED_COLUMNS,
  snakeCase,
} from './naming.ts'

/** Options for a model. */
export interface ModelOptions {
  /** Adds `createdAt` / `updatedAt`. Default `true`. */
  readonly timestamps?: boolean
  /** Adds `deletedAt`; deletes become soft and restorable. Default `false`. */
  readonly softDeletes?: boolean
  /** Scopes every row to a tenant (`tenant_id` + row-level security on Postgres). Default `false`. */
  readonly tenant?: boolean
  /** Record an audit event for every change. Default `false`. */
  readonly audit?: boolean
  /** Field used as the display title. Default: the first `string` field, else `id`. */
  readonly title?: string
  /** Table name. Default: plural snake case of the model name (`invoice_lines`). */
  readonly table?: string
  /** Human labels. Default: derived from the name. */
  readonly label?: string
  readonly pluralLabel?: string
}

/** Model options with every default applied. */
export interface ResolvedModelOptions {
  readonly timestamps: boolean
  readonly softDeletes: boolean
  readonly tenant: boolean
  readonly audit: boolean
}

/** A to-many relation as stored in the definition. */
export interface RelationDef {
  readonly kind: 'hasMany'
  readonly target: string
  /** Field key on the target that points back (default: lowerCamel of this model's name). */
  readonly foreignKey: string
}

/** The plain-data model definition (serialisable; used for migrations snapshots). */
export interface ModelDefinition {
  /** PascalCase model name, e.g. `InvoiceLine`. */
  readonly name: string
  /** Database table, e.g. `invoice_lines`. */
  readonly table: string
  /** API path segment, e.g. `invoice-lines`. */
  readonly path: string
  /** Permission prefix, e.g. `invoiceLine` (→ `invoiceLine.create`). */
  readonly permission: string
  readonly label: string
  readonly pluralLabel: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldDef>>
  readonly relations: Readonly<Record<string, RelationDef>>
  readonly options: ResolvedModelOptions
}

/** What a field map may contain. */
export type FieldMap = Readonly<Record<string, AnyFieldBuilder | HasManyBuilder>>

/** A defined model: the definition plus phantom types for inference. */
export interface Model<
  N extends string = string,
  F extends FieldMap = FieldMap,
  O extends ModelOptions = ModelOptions,
> {
  readonly name: N
  readonly definition: ModelDefinition
  /** The field builders as declared; spread them to derive a variant (`{ ...Invoice.fields }`). */
  readonly fields: F
  /** @internal phantom types; never set at runtime. */
  readonly __types?: { fields: F; options: O }
}

/** Any model, regardless of its field map. */
// biome-ignore lint/suspicious/noExplicitAny: generic erasure for heterogeneous model lists.
export type AnyModel = Model<string, any, any>

type FieldsOf<M> = M extends Model<string, infer F, ModelOptions> ? F : never
type OptionsOf<M> = M extends Model<string, FieldMap, infer O> ? O : never
type ColumnKeys<F> = { [K in keyof F]: F[K] extends HasManyBuilder ? never : K }[keyof F]

type ValueOf<B> =
  B extends FieldBuilder<infer T, infer R, boolean, boolean>
    ? R extends true
      ? T
      : T | null
    : never
type IsRequiredNoDefault<B> =
  B extends FieldBuilder<unknown, infer R, infer D, boolean>
    ? R extends true
      ? D extends true
        ? false
        : true
      : false
    : false
type IsWritable<B> = B extends FieldBuilder<unknown, boolean, boolean, infer W> ? W : false

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type TimestampFields<O> = O extends { timestamps: false }
  ? unknown
  : { readonly createdAt: string; readonly updatedAt: string }
type SoftDeleteFields<O> = O extends { softDeletes: true }
  ? { readonly deletedAt: string | null }
  : unknown

/** The record type a model's repository returns. */
export type InferModel<M extends AnyModel> = Simplify<
  { readonly id: string } & {
    readonly [K in ColumnKeys<FieldsOf<M>>]: ValueOf<FieldsOf<M>[K]>
  } & TimestampFields<OptionsOf<M>> &
    SoftDeleteFields<OptionsOf<M>>
>

type WritableKeys<F> = {
  [K in ColumnKeys<F>]: IsWritable<F[K]> extends true ? K : never
}[ColumnKeys<F>]
type RequiredInputKeys<F> = {
  [K in WritableKeys<F>]: IsRequiredNoDefault<F[K]> extends true ? K : never
}[WritableKeys<F>]
type OptionalInputKeys<F> = Exclude<WritableKeys<F>, RequiredInputKeys<F>>

/** Input accepted when creating a record (required fields without a default are required). */
export type CreateInput<M extends AnyModel> = Simplify<
  { [K in RequiredInputKeys<FieldsOf<M>>]: ValueOf<FieldsOf<M>[K]> } & {
    [K in OptionalInputKeys<FieldsOf<M>>]?: ValueOf<FieldsOf<M>[K]> | null
  }
>

/** Input accepted when updating a record (every writable field optional). */
export type UpdateInput<M extends AnyModel> = Simplify<{
  [K in WritableKeys<FieldsOf<M>>]?:
    | ValueOf<FieldsOf<M>[K]>
    | (IsRequiredNoDefault<FieldsOf<M>[K]> extends true ? never : null)
}>

/** Column name for a field key: `dueDate` → `due_date`, `customer` (belongsTo) → `customer_id`. */
export function columnName(key: string, def: FieldDef): string {
  return def.kind === 'belongsTo' ? `${snakeCase(key)}_id` : snakeCase(key)
}

/** Define a model. Throws a descriptive error for any invalid definition. */
export function defineModel<
  const N extends string,
  const F extends FieldMap,
  const O extends ModelOptions = ModelOptions,
>(name: N, fields: F, options?: O): Model<N, F, O> {
  if (!MODEL_NAME_PATTERN.test(name))
    throw new TypeError(`Model name "${name}" must be PascalCase (e.g. "InvoiceLine")`)
  const opts: ModelOptions = options ?? {}
  const resolvedFields: Record<string, FieldDef> = {}
  const relations: Record<string, RelationDef> = {}
  const columns = new Set<string>()

  for (const [key, builder] of Object.entries(fields)) {
    if (!FIELD_KEY_PATTERN.test(key))
      throw new TypeError(`${name}: field key "${key}" must be lowerCamelCase`)
    if (builder instanceof HasManyBuilder) {
      relations[key] = Object.freeze({
        kind: 'hasMany',
        target: builder.target,
        foreignKey: builder.foreignKey ?? lowerCamel(name),
      })
      continue
    }
    const def = builder.def
    const column = columnName(key, def)
    if (RESERVED_COLUMNS.has(column))
      throw new TypeError(`${name}: field "${key}" uses the reserved column "${column}"`)
    if (columns.has(column))
      throw new TypeError(`${name}: two fields map to the column "${column}"`)
    columns.add(column)
    resolvedFields[key] = Object.freeze({ ...def, label: def.label ?? humanLabel(key) })
  }

  const fieldKeys = Object.keys(resolvedFields)
  if (fieldKeys.length === 0) throw new TypeError(`${name}: a model needs at least one field`)
  const title = opts.title ?? fieldKeys.find((k) => resolvedFields[k]?.kind === 'string') ?? 'id'
  if (title !== 'id' && !resolvedFields[title])
    throw new TypeError(`${name}: title field "${title}" does not exist`)

  const table = opts.table ?? pluralize(snakeCase(name))
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
    throw new TypeError(`${name}: table name "${table}" is not a valid identifier`)
  const label = opts.label ?? humanLabel(name)

  const definition: ModelDefinition = Object.freeze({
    name,
    table,
    path: kebabCase(pluralize(name.charAt(0).toLowerCase() + name.slice(1))),
    permission: lowerCamel(name),
    label,
    pluralLabel: opts.pluralLabel ?? pluralize(label),
    title,
    fields: Object.freeze(resolvedFields),
    relations: Object.freeze(relations),
    options: Object.freeze({
      timestamps: opts.timestamps ?? true,
      softDeletes: opts.softDeletes ?? false,
      tenant: opts.tenant ?? false,
      audit: opts.audit ?? false,
    }),
  })
  return Object.freeze({ name, definition, fields })
}
