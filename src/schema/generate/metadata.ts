/**
 * Generate resource metadata: the JSON a CRUD API and a UI read to do their jobs without any
 * per-model code. Labels, search, sorting, filters, relations, slugs, form inputs and sidebar
 * order are all derived from column types and names.
 *
 * Migrations stay purely about the database. Anything presentational that the derivation gets
 * wrong (a label, the sidebar order) is overridden in {@link ResourceOverrides}, which is the
 * stand-in for an app's resource config file (level L1 "configure").
 *
 * Hidden and secret columns are never searchable, sortable or filterable, so a request can't learn
 * their values one query at a time. Internal tables (`{ internal: true }`, and the framework and
 * identity tables of `INTERNAL_TABLES`: sessions, cache, jobs, users…) get no resource at all.
 *
 * **Mass assignment comes from the model** (`app/models`, read by `readAppModels`): a field is
 * `fillable` only when the table's model lists it in `fillable`. Without a model, only plain
 * columns are: never a secret, a hidden column or a privilege-like name (`is_*`, `*_at`, `role`…),
 * and with a model those still need the model's `allowSensitive`. The model's `hidden` list hides
 * fields too. So the metadata never invites a request to set what the model would refuse.
 *
 * @module
 */

import {
  camelCase,
  humanize,
  modelNameForTable,
  pascalCase,
  singularize,
} from '../../core/inflection.ts'
import {
  type ColumnDef,
  type ColumnKind,
  isHiddenColumn,
  isPrivilegeColumn,
  MANAGED_TIMESTAMPS,
  primaryKeyOf,
  type SchemaState,
  type TableState,
  tenantColumnOf,
} from '../columns.ts'
import { isInternalTable } from '../internal-tables.ts'
import type { ModelOptions } from './model-options.ts'
import { isFillable, isRequiredOnCreate, isReturnedByApi, isWritable } from './semantics.ts'

/**
 * How a value is converted between the database, JSON and forms.
 *
 * @example
 * const cast: FieldCast = 'decimal'
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
 * How free-text `?search=` treats a field: `text` means "contains, case-insensitive", `exact`
 * means "equals, when the search term is a number".
 *
 * @example
 * const mode: SearchMode = 'text'
 */
export type SearchMode = 'text' | 'exact'

/**
 * Filter operators, used as `?filter[price][gte]=10`.
 *
 * @example
 * const op: FilterOperator = 'gte'
 */
export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'null'

/**
 * The UI widget for a field.
 *
 * @example
 * const input: FieldInput = 'select'
 */
export type FieldInput =
  | 'text'
  | 'textarea'
  | 'number'
  | 'decimal'
  | 'switch'
  | 'select'
  | 'relation'
  | 'date'
  | 'datetime'
  | 'json'
  | 'none'

/**
 * Everything a CRUD API or UI needs to know about one field.
 *
 * @example
 * resource.fields.find((field) => field.name === 'status')?.options // ['draft', 'published']
 */
export interface FieldMetadata {
  readonly name: string
  readonly label: string
  readonly kind: ColumnKind
  readonly cast: FieldCast
  readonly nullable: boolean
  /** Must be sent on create. */
  readonly required: boolean
  /** May be sent on create/update. */
  readonly fillable: boolean
  /**
   * Covered by a single-column unique index (per tenant in a tenant table), so the API checks for
   * duplicates before writing.
   */
  readonly unique: boolean
  /** Never returned by the API or shown in the UI. */
  readonly hidden: boolean
  readonly searchable: SearchMode | false
  readonly sortable: boolean
  /** Shown as a column in the list view. */
  readonly listed: boolean
  readonly input: FieldInput
  /** Operators accepted by `?filter[name][op]=…`; empty when the field can't be filtered. */
  readonly filterOperators: readonly FilterOperator[]
  readonly maxLength?: number
  readonly precision?: number
  readonly scale?: number
  readonly options?: readonly string[]
  readonly default?: string | number | boolean | null
  /** For foreign keys: the resource the value points to. */
  readonly references?: string
}

/**
 * A relation between two resources, for eager loading and relation pickers.
 *
 * @example
 * const author: RelationMetadata = { name: 'author', kind: 'belongsTo', resource: 'users', foreignKey: 'author_id', ownerKey: 'id' }
 */
export interface RelationMetadata {
  readonly name: string
  readonly kind: 'belongsTo' | 'hasMany'
  readonly resource: string
  /** The column holding the id: on this table for `belongsTo`, on the other table for `hasMany`. */
  readonly foreignKey: string
  readonly ownerKey: string
}

/**
 * One resource: a table plus everything needed to serve and show it.
 *
 * @example
 * metadata.resources.find((resource) => resource.table === 'posts')?.label.plural // 'Posts'
 */
export interface ResourceMetadata {
  readonly table: string
  readonly model: string
  /** URL segment: `/api/posts`. */
  readonly route: string
  readonly label: { readonly singular: string; readonly plural: string }
  readonly primaryKey: string
  /** The field that names a row in pickers and breadcrumbs (`name`, `title`, …). */
  readonly titleField: string
  readonly slug?: { readonly field: string; readonly from: string }
  readonly timestamps: boolean
  readonly softDeletes: boolean
  /** For example `-created_at` (newest first). */
  readonly defaultSort: string
  readonly perPage: number
  readonly fields: readonly FieldMetadata[]
  readonly relations: readonly RelationMetadata[]
  readonly sidebar: { readonly order: number; readonly hidden: boolean }
  /** The tenant column, when rows belong to one tenant (`t.tenant()`). */
  readonly tenant?: string
  /** Shared reference data every tenant may see (`{ global: true }`). */
  readonly global?: true
}

/**
 * The whole metadata document, written to `.strutvane/resources.json`.
 *
 * @example
 * const metadata: AppMetadata = JSON.parse(readFileSync('.strutvane/resources.json', 'utf8'))
 */
export interface AppMetadata {
  readonly version: 1
  readonly resources: readonly ResourceMetadata[]
  /**
   * Tables with no resource, so the API and the UI refuse them by name: created with
   * `{ internal: true }`, or framework and identity tables (`INTERNAL_TABLES`, `team_*`).
   */
  readonly internal: readonly string[]
}

/**
 * App-level tweaks to the derived metadata. Kept out of migrations on purpose: migrations describe
 * the database, not the UI.
 *
 * @example
 * const overrides: ResourceOverrides = { users: { label: { singular: 'Member', plural: 'Members' }, sidebarOrder: 1 } }
 */
export type ResourceOverrides = Readonly<
  Record<
    string,
    {
      readonly label?: { readonly singular: string; readonly plural: string }
      readonly sidebarOrder?: number
      readonly hidden?: boolean
    }
  >
>

/** The default page size for the API and the UI (decision #54). */
const DEFAULT_PER_PAGE = 25

/** At most this many fields are searched by `?search=` (decision #53); the rest are left out. */
const MAX_SEARCHABLE = 10

/** Preferred title columns, in order. The first one that exists names the row. */
const TITLE_CANDIDATES = ['name', 'title', 'label', 'email'] as const

/**
 * Derive metadata for every table.
 *
 * @example
 * const metadata = generateMetadata(replay.state)
 * writeFileSync('.strutvane/resources.json', `${JSON.stringify(metadata, null, 2)}\n`)
 */
export function generateMetadata(
  state: SchemaState,
  overrides: ResourceOverrides = {},
  models: ReadonlyMap<string, ModelOptions> = new Map(),
): AppMetadata {
  const resources = state.tables
    .filter((table) => !isInternal(table))
    .map((table) => resourceFor(state, table, models.get(table.name)))
  const internal = state.tables.filter(isInternal).map((table) => table.name)
  return { version: 1, resources: withSidebarOrder(resources, overrides), internal }
}

/**
 * The metadata of one table, derived exactly as {@link generateMetadata} derives it for
 * `.strutvane/resources.json`, for the runtime (the ORM serves a model's API from the schema
 * snapshot it already holds, so the API can never disagree with the file the UI reads). Internal
 * tables get their metadata too, flagged `internal: true`, so the boot check can refuse them by
 * name. The sidebar order is not computed here (it needs every resource and the overrides).
 *
 * @example
 * resourceMetadataForTable(state, 'posts', models.get('posts')).fields.find((f) => f.name === 'email')?.unique
 */
export function resourceMetadataForTable(
  state: SchemaState,
  table: string,
  model?: ModelOptions,
): ResourceMetadata & { readonly internal?: true } {
  const found = state.tables.find((candidate) => candidate.name === table)
  if (found === undefined)
    throw new RangeError(
      `The table "${table}" is not in the schema. Create it in a migration and run \`node strut migrate\`.`,
    )
  const resource = resourceFor(state, found, model)
  return isInternal(found) ? { ...resource, internal: true } : resource
}

/** Flagged `{ internal: true }`, or a framework/identity table whatever its flag says. */
function isInternal(table: TableState): boolean {
  return table.internal === true || isInternalTable(table.name)
}

function resourceFor(
  state: SchemaState,
  table: TableState,
  options: ModelOptions | undefined,
): ResourceMetadata {
  const model = modelNameForTable(table.name)
  const slugColumn = table.columns.find(
    (column) => column.kind === 'slug' && column.slugFrom !== undefined,
  )
  const has = (name: string): boolean => table.columns.some((column) => column.name === name)
  const tenant = tenantColumnOf(table)
  return {
    table: table.name,
    model,
    route: table.name.replace(/_/g, '-'),
    label: { singular: humanize(singularize(table.name)), plural: humanize(table.name) },
    primaryKey: primaryKeyOf(table)?.name ?? 'id',
    titleField: titleFieldOf(table),
    ...(slugColumn?.slugFrom === undefined
      ? {}
      : { slug: { field: slugColumn.name, from: slugColumn.slugFrom } }),
    timestamps: has('created_at') && has('updated_at'),
    softDeletes: has('deleted_at'),
    defaultSort: has('created_at') ? '-created_at' : '-id',
    perPage: DEFAULT_PER_PAGE,
    fields: capSearchable(table.columns.map((column) => fieldFor(table, column, options))),
    relations: relationsOf(state, table),
    sidebar: { order: 0, hidden: false },
    ...(tenant === undefined ? {} : { tenant: tenant.name }),
    ...(table.global === true ? { global: true } : {}),
  }
}

function fieldFor(
  table: TableState,
  column: ColumnDef,
  model: ModelOptions | undefined,
): FieldMetadata {
  // The tenant column is never a client concern: it comes from the current tenant.
  const hidden = !isReturnedByApi(column) || model?.hidden.includes(column.name) === true
  const internal = hidden || column.tenant === true
  const fillable = isMassAssignable(column, hidden, model)
  const tenant = tenantColumnOf(table)?.name
  const unique = table.indexes.some((index) => {
    const own = index.columns.filter((name) => name !== tenant)
    return index.unique && own.length === 1 && own[0] === column.name
  })
  return {
    name: column.name,
    label: humanize(column.name),
    kind: column.kind,
    cast: CAST[column.kind],
    nullable: column.nullable,
    required: fillable && isRequiredOnCreate(column),
    fillable,
    unique,
    hidden,
    searchable: internal ? false : SEARCH[column.kind],
    sortable: !internal && column.kind !== 'text' && column.kind !== 'json',
    listed: !internal && isListed(column),
    input: hidden || !fillable ? 'none' : inputFor(column),
    filterOperators: internal ? [] : filterOperatorsFor(column),
    ...(column.length === undefined ? {} : { maxLength: column.length }),
    ...(column.precision === undefined ? {} : { precision: column.precision }),
    ...(column.scale === undefined ? {} : { scale: column.scale }),
    ...(column.values === undefined ? {} : { options: column.values }),
    ...('default' in column && column.default !== undefined ? { default: column.default } : {}),
    ...(column.references === undefined ? {} : { references: column.references.table }),
  }
}

/**
 * May a request set this column through the generated API? Never a key, the tenant column or a
 * managed timestamp. A secret, a hidden column or a privilege-like name only when the model opts in
 * with `allowSensitive`. With a model, only what its `fillable` lists (none when it lists nothing,
 * exactly as `Model.create()` behaves); without one, every other plain column.
 */
function isMassAssignable(
  column: ColumnDef,
  hidden: boolean,
  model: ModelOptions | undefined,
): boolean {
  const sensitive = hidden || isPrivilegeColumn(column.name)
  if (model === undefined) return isFillable(column) && !sensitive
  if (model.fillable?.includes(column.name) !== true) return false
  const writable =
    isFillable(column) || (isWritableSecret(column) && model.allowSensitive.includes(column.name))
  return writable && (!sensitive || model.allowSensitive.includes(column.name))
}

/** A secret the ORM may write (not a key or managed column): only fillable with `allowSensitive`. */
function isWritableSecret(column: ColumnDef): boolean {
  return !isFillable(column) && isWritable(column)
}

const CAST: Readonly<Record<ColumnKind, FieldCast>> = {
  id: 'integer',
  integer: 'integer',
  bigInteger: 'integer',
  foreignId: 'integer',
  double: 'number',
  decimal: 'decimal',
  string: 'string',
  text: 'string',
  slug: 'string',
  uuid: 'string',
  enum: 'string',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'datetime',
  json: 'json',
}

/**
 * Free-text search. Booleans, dates and JSON are left out on purpose: "search for `true`" or
 * "search for 2026" are better served by filters, and matching them as text gives surprising hits.
 */
const SEARCH: Readonly<Record<ColumnKind, SearchMode | false>> = {
  id: 'exact',
  integer: 'exact',
  bigInteger: 'exact',
  foreignId: 'exact',
  double: 'exact',
  decimal: 'exact',
  string: 'text',
  text: 'text',
  slug: 'text',
  uuid: 'text',
  enum: 'text',
  boolean: false,
  date: false,
  timestamp: false,
  json: false,
}

function filterOperatorsFor(column: ColumnDef): FilterOperator[] {
  const base = FILTER_OPERATORS[column.kind]
  // `?filter[subtitle][null]=true` only makes sense on columns that can be null.
  return column.nullable && base.length > 0 ? [...base, 'null'] : [...base]
}

const NUMERIC_OPERATORS: readonly FilterOperator[] = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte']
const RANGE_OPERATORS: readonly FilterOperator[] = ['eq', 'gt', 'gte', 'lt', 'lte']
const STRING_OPERATORS: readonly FilterOperator[] = ['eq', 'ne', 'in', 'contains', 'startsWith']

const FILTER_OPERATORS: Readonly<Record<ColumnKind, readonly FilterOperator[]>> = {
  id: NUMERIC_OPERATORS,
  integer: NUMERIC_OPERATORS,
  bigInteger: NUMERIC_OPERATORS,
  double: NUMERIC_OPERATORS,
  decimal: NUMERIC_OPERATORS,
  foreignId: ['eq', 'ne', 'in'],
  string: STRING_OPERATORS,
  slug: STRING_OPERATORS,
  uuid: ['eq', 'ne', 'in'],
  text: ['contains'],
  enum: ['eq', 'ne', 'in'],
  boolean: ['eq'],
  date: RANGE_OPERATORS,
  timestamp: RANGE_OPERATORS,
  json: [],
}

function inputFor(column: ColumnDef): FieldInput {
  switch (column.kind) {
    case 'text':
      return 'textarea'
    case 'integer':
    case 'bigInteger':
    case 'double':
      return 'number'
    case 'decimal':
      return 'decimal'
    case 'boolean':
      return 'switch'
    case 'enum':
      return 'select'
    case 'foreignId':
      return column.references === undefined ? 'number' : 'relation'
    case 'date':
      return 'date'
    case 'timestamp':
      return 'datetime'
    case 'json':
      return 'json'
    case 'id':
      return 'none'
    case 'uuid':
      return column.references === undefined ? 'text' : 'relation'
    case 'string':
    case 'slug':
      return 'text'
  }
}

/** List views show short, scannable columns: no long text, JSON, secrets or bookkeeping timestamps. */
function isListed(column: ColumnDef): boolean {
  if (isHiddenColumn(column)) return false
  if (column.kind === 'text' || column.kind === 'json') return false
  return !(MANAGED_TIMESTAMPS.has(column.name) && column.name !== 'created_at')
}

function titleFieldOf(table: TableState): string {
  for (const candidate of TITLE_CANDIDATES) {
    if (table.columns.some((column) => column.name === candidate && column.kind === 'string'))
      return candidate
  }
  return table.columns.find((column) => column.kind === 'slug')?.name ?? 'id'
}

function relationsOf(state: SchemaState, table: TableState): RelationMetadata[] {
  const internal = new Set(state.tables.filter(isInternal).map((other) => other.name))
  const belongsTo: RelationMetadata[] = table.columns.flatMap((column) =>
    column.references === undefined || internal.has(column.references.table)
      ? []
      : [
          {
            name: camelCase(column.name.replace(/_id$/, '')),
            kind: 'belongsTo' as const,
            resource: column.references.table,
            foreignKey: column.name,
            ownerKey: column.references.column,
          },
        ],
  )
  const children = state.tables
    .filter((child) => !internal.has(child.name))
    .flatMap((child) =>
      child.columns
        .filter((column) => column.references?.table === table.name)
        .map((column) => ({ child, column })),
    )
  const hasMany: RelationMetadata[] = children.map(({ child, column }) => {
    // Two keys from the same child table (author_id, editor_id) would both be "posts": disambiguate.
    const ambiguous = children.filter((other) => other.child.name === child.name).length > 1
    const base = camelCase(child.name)
    const name = ambiguous ? `${base}As${pascalCase(column.name.replace(/_id$/, ''))}` : base
    return {
      name,
      kind: 'hasMany' as const,
      resource: child.name,
      foreignKey: column.name,
      ownerKey: column.references?.column ?? 'id',
    }
  })
  return [...belongsTo, ...hasMany]
}

/**
 * Sidebar order: explicit overrides first (by their number), then everything else alphabetically
 * by label. Alphabetical, not migration order, so adding a table never reshuffles the menu.
 */
function withSidebarOrder(
  resources: readonly ResourceMetadata[],
  overrides: ResourceOverrides,
): ResourceMetadata[] {
  const configured = resources.map((resource) => {
    const override = overrides[resource.table]
    return {
      ...resource,
      ...(override?.label === undefined ? {} : { label: override.label }),
      sidebar: {
        order: override?.sidebarOrder ?? Number.POSITIVE_INFINITY,
        hidden: override?.hidden ?? false,
      },
    }
  })
  const ranked = [...configured].sort(
    (a, b) => a.sidebar.order - b.sidebar.order || compareText(a.label.plural, b.label.plural),
  )
  return configured.map((resource) => ({
    ...resource,
    sidebar: { ...resource.sidebar, order: ranked.indexOf(resource) + 1 },
  }))
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Keep `?search=` affordable and predictable: only the first {@link MAX_SEARCHABLE} searchable
 * fields (in column order) are searched.
 */
function capSearchable(fields: readonly FieldMetadata[]): FieldMetadata[] {
  let kept = 0
  return fields.map((field) => {
    if (field.searchable === false) return field
    kept++
    return kept <= MAX_SEARCHABLE ? field : { ...field, searchable: false }
  })
}
