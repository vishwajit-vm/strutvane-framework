/**
 * The ORM half of the `ResourceController` contract (`http/app/resource-model.ts`): what a model
 * class does when a generated CRUD API asks it for metadata, a page of rows, a bound row or a
 * uniqueness answer. `ModelBase` exposes these as statics (`Customer.metadata()`,
 * `Customer.paginate(query, constraints)`, …); this module holds the logic, so the model file
 * stays about rows (FW-5: the two halves, data layer and app core, were never joined).
 *
 * **Every name in a request is checked against the resource's allow-lists before any SQL**
 * (security review F-02/F-09): existing is not the same as allowed. The allow-lists are the ones
 * in `.strutvane/resources.json`, derived here from the same schema snapshot with the same code
 * (`resourceMetadataForTable`), so the API can never accept what the UI was told is refused:
 * hidden and secret columns are never filtered, sorted, searched, selected or included.
 *
 * Wire format (ADR-0011, the one `@strutvane/ui` sends): `filter[field][op]=v` (repeat the key
 * for `in`), `sort=-created_at,name`, `search=text`, `page[number]`, `page[size]`,
 * `page[total]=true`, `include=customer,orders`, `fields=name,email`. Unknown parameters are
 * refused (422 `unknown_parameter`), and every problem is reported at once.
 *
 * Costs are capped: at most 100 rows per page, 10,000 rows deep (`page_too_deep`), 5 sorts,
 * 5 includes, 100 `in` values, 200 search characters, and totals only on request.
 *
 * **Read access** (`ResourceReadAccess`, decided by the controller from the policies): a field
 * the user may not read can't be filtered, sorted, searched or selected either (each would reveal
 * its values one request at a time), and is left out of every row; an include loads only the
 * related rows the related policy's scope and `view` allow, with that policy's readable fields.
 *
 * @module
 */

import { type IssueInput, ValidationError } from '../../core/errors/errors.ts'
import { camelCase } from '../../core/inflection.ts'
import type {
  Constraint,
  IncludeAccess,
  ResourceModel,
  ResourcePage,
  ResourceReadAccess,
  ResourceRecord,
  ResourceReference,
} from '../../http/app/resource-model.ts'
import {
  type FieldMetadata,
  type FilterOperator,
  type ResourceMetadata,
  resourceMetadataForTable,
} from '../../schema/generate/metadata.ts'
import type { ModelOptions } from '../../schema/generate/model-options.ts'
import { registeredSchema, tableState } from '../schema/registry.ts'
import type { SchemaSnapshot } from '../schema/snapshot.ts'
import { Builder, type EagerTree, loadRelations } from './builder.ts'
import { ormConfig } from './config.ts'
import { CastError, OrmUsageError } from './errors.ts'
import type { ModelBase } from './model.ts'
import { attribute, isModelRuntime, type ModelRuntime, setLoaded } from './runtime.ts'
import type { AnyModelClass } from './types.ts'

/** The model options the metadata reads (mass assignment and visibility). */
export interface ResourceModelOptions {
  readonly fillable?: readonly string[]
  readonly hidden?: readonly string[]
  readonly allowSensitive?: readonly string[]
}

/** A model class as this module uses it: its runtime plus the options given to `Model()`. */
export type ResourceSource = ModelRuntime & { readonly options: ResourceModelOptions }

/**
 * A resource's metadata as the ORM serves it: what `resources.json` says about the table, plus
 * `internal` for framework and identity tables (never served by an auto controller).
 *
 * @example
 * const meta: OrmResourceMetadata = Customer.metadata()
 */
export type OrmResourceMetadata = ResourceMetadata & { readonly internal?: true }

/** Rows deeper than this are refused for numbered pages (blueprint §5: "total capped at 10,000"). */
export const MAX_PAGE_DEPTH = 10_000
const MAX_PARAMETERS = 100
const MAX_SORTS = 5
const MAX_INCLUDES = 5
const MAX_IN_VALUES = 100
const MAX_SEARCH = 200
const MAX_SEARCH_WORDS = 5
const FILTER_KEY = /^filter\[([^\][]*)\]\[([^\][]*)\]$/
const SINGLE_KEYS: ReadonlySet<string> = new Set([
  'sort',
  'search',
  'include',
  'fields',
  'page[size]',
  'page[number]',
  'page[total]',
])

const cache = new WeakMap<
  object,
  { readonly schema: SchemaSnapshot; readonly meta: OrmResourceMetadata }
>()

/**
 * The model's resource metadata, derived once per registered schema from the snapshot and the
 * model's own `fillable` / `hidden` / `allowSensitive`.
 *
 * @example
 * resourceMetadataOf(Customer).fields.find((field) => field.name === 'email')?.unique // true
 */
export function resourceMetadataOf(model: ResourceSource): OrmResourceMetadata {
  const schema = registeredSchema()
  // Throws the ORM's friendly errors first: no schema registered yet, or the table isn't in it.
  model.info()
  const cached = cache.get(model)
  if (cached !== undefined && cached.schema === schema) return cached.meta
  const snapshot = schema as SchemaSnapshot
  const options: ModelOptions = {
    model: model.name,
    file: '',
    fillable: model.options.fillable,
    hidden: model.options.hidden ?? [],
    allowSensitive: model.options.allowSensitive ?? [],
  }
  const meta = resourceMetadataForTable(
    { tables: Object.values(snapshot.tables) },
    model.table,
    options,
  )
  cache.set(model, { schema: snapshot, meta })
  return meta
}

/**
 * One page of rows for a list request, after every name in it was checked against the
 * resource's allow-lists. Throws one 422 `validation_failed` listing every problem.
 *
 * @example
 * const page = await listForRequest(Customer, new URLSearchParams('filter[active][eq]=true&sort=name'), [])
 */
export async function listForRequest(
  model: ResourceSource,
  query: URLSearchParams,
  constraints: readonly Constraint[],
  access?: ResourceReadAccess,
): Promise<ResourcePage<ModelBase>> {
  const meta = readableMeta(resourceMetadataOf(model), access?.readable)
  const issues: IssueInput[] = []
  const builder = new Builder<AnyModelClass, ModelBase>(model)
  const keys = [...new Set(query.keys())]
  if (keys.length > MAX_PARAMETERS)
    throw new ValidationError([
      { path: ['query'], code: 'too_many_parameters', params: { max: MAX_PARAMETERS } },
    ])
  for (const key of keys) {
    const filter = FILTER_KEY.exec(key)
    if (filter !== null) {
      applyFilter(builder, meta, filter[1] ?? '', filter[2] ?? '', query.getAll(key), issues)
      continue
    }
    if (!SINGLE_KEYS.has(key))
      issues.push({ path: ['query', key], code: 'unknown_parameter', params: { name: key } })
    else if (query.getAll(key).length > 1)
      issues.push({ path: ['query', key], code: 'duplicate_parameter', params: { name: key } })
  }
  applySearch(builder, meta, query.get('search'), issues)
  applySort(builder, meta, query.get('sort'), issues)
  const includes = parseIncludes(model, query.get('include'), issues, access)
  const fields = parseFields(meta, query.get('fields'), issues)
  const page = parsePage(meta, query, issues)
  if (issues.length > 0) throw new ValidationError(issues)
  for (const constraint of constraints) applyConstraint(builder, constraint, 'and', meta.primaryKey)

  const total = page.withTotal ? await builder.clone().count() : undefined
  if (includes.length > 0) builder.with(includeConstraints(model, includes, access))
  const rows = await builder
    .limit(page.size + 1)
    .offset((page.number - 1) * page.size)
    .get()
  const hasMore = rows.length > page.size
  const data = hasMore ? rows.slice(0, page.size) : rows
  await concealIncludes(model, data, includes, access)
  const shown = fields ?? (access?.readable === undefined ? undefined : readableKeys(meta))
  if (shown !== undefined) for (const row of data) row.setVisible([...shown, ...includes])
  return {
    data,
    meta: {
      page: {
        number: page.number,
        size: page.size,
        hasMore,
        ...(total === undefined ? {} : { total }),
      },
    },
  }
}

/**
 * Apply `?include=` and `?fields=` to one record (show, update, restore). Any other parameter is
 * refused: a single record has nothing to filter, sort or page.
 *
 * @example
 * await presentRecord(Customer, customer, new URLSearchParams('include=orders'))
 */
export async function presentRecord(
  model: ResourceSource,
  record: ModelBase,
  query: URLSearchParams,
  access?: ResourceReadAccess,
): Promise<void> {
  const meta = readableMeta(resourceMetadataOf(model), access?.readable)
  const issues: IssueInput[] = []
  for (const key of new Set(query.keys())) {
    if (key !== 'include' && key !== 'fields')
      issues.push({ path: ['query', key], code: 'unknown_parameter', params: { name: key } })
    else if (query.getAll(key).length > 1)
      issues.push({ path: ['query', key], code: 'duplicate_parameter', params: { name: key } })
  }
  const includes = parseIncludes(model, query.get('include'), issues, access)
  const fields = parseFields(meta, query.get('fields'), issues)
  if (issues.length > 0) throw new ValidationError(issues)
  // Not a lazy load in a loop: one record, its relations loaded in one query each.
  if (includes.length > 0) await loadOnto(record, includeTree(model, includes, access))
  await concealIncludes(model, [record], includes, access)
  const shown = fields ?? (access?.readable === undefined ? undefined : readableKeys(meta))
  if (shown !== undefined) record.setVisible([...shown, ...includes])
}

/**
 * Where a foreign key column points, through the model's own `belongsTo`: the relation named
 * like the column (`customer_id` → `customer()`), whose model must own the referenced table.
 * `undefined` when the column isn't a foreign key, or the model has no such relation.
 *
 * @example
 * referenceOf(Order, 'customer_id') // { model: Customer, key: 'id' }
 */
export function referenceOf(model: ResourceSource, column: string): ResourceReference | undefined {
  const references = tableState(model.table).columns.find(
    (candidate) => candidate.name === column,
  )?.references
  if (references === undefined) return undefined
  let related: unknown
  try {
    related = model.relation(camelCase(column.replace(/_id$/, ''))).relatedModel()
  } catch (error) {
    if (error instanceof OrmUsageError) return undefined
    throw error
  }
  if (!isModelRuntime(related) || related.table !== references.table || !isResourceModel(related))
    return undefined
  return { model: related, key: references.column }
}

/**
 * The related model behind an include name, when it may be included: a relation listed in the
 * metadata (never one to an internal table) that the model class really defines.
 *
 * @example
 * includableModel(Customer, 'orders')?.name // 'Order'
 */
export function includableModel(model: ResourceSource, name: string): ResourceSource | undefined {
  const meta = resourceMetadataOf(model)
  if (!meta.relations.some((relation) => relation.name === name)) return undefined
  try {
    const related = model.relation(name).relatedModel()
    return isResourceSource(related) ? related : undefined
  } catch (error) {
    if (error instanceof OrmUsageError) return undefined
    throw error
  }
}

/**
 * The row a route parameter names, or `null` (never an error) when it doesn't exist, is hidden by
 * the tenant scope, or is malformed (`abc` for an integer id is refused before any SQL).
 *
 * @example
 * await bindRoute(Customer, '7') // the customer, or null
 */
export async function bindRoute(
  model: ResourceSource,
  value: string,
  field: string | undefined,
  withTrashed: boolean,
): Promise<ModelBase | null> {
  const column = field ?? model.info().primaryKey.name
  if (model.settings().hidden.has(column))
    throw new OrmUsageError(
      'hidden_route_key',
      `${model.name} can't be bound by "${column}": the column is hidden, and a URL would reveal it. Bind by a visible column such as {${singularParam(model.table)}:slug}.`,
    )
  const builder = new Builder<AnyModelClass, ModelBase>(model)
  if (withTrashed) builder.withTrashed()
  try {
    builder.filter(column, 'eq', value)
  } catch (error) {
    if (error instanceof CastError) return null
    throw error
  }
  return (await builder.first()) ?? null
}

/**
 * Is `value` already used in `column` by another row? Soft-deleted rows count (the unique index
 * sees them), global scopes don't apply (the index ignores them too), the tenant scope does.
 *
 * @example
 * await isValueTaken(Customer, 'email', 'a@b.test', 7)
 */
export async function isValueTaken(
  model: ResourceSource,
  column: string,
  value: string | number,
  exceptKey: string | number | undefined,
): Promise<boolean> {
  const builder = new Builder<AnyModelClass, ModelBase>(model).withTrashed()
  for (const scope of model.settings().globalScopes.keys()) builder.withoutGlobalScope(scope)
  try {
    builder.filter(column, 'eq', value)
    if (exceptKey !== undefined) builder.filter(model.info().primaryKey.name, 'ne', exceptKey)
  } catch (error) {
    // A value the column can't hold can't be a duplicate; validation reports it on its own.
    if (error instanceof CastError) return false
    throw error
  }
  return builder.exists()
}

/**
 * The value of a record for a URL: the given column, or the primary key.
 *
 * @example
 * routeKeyOf(customer, 'slug') // 'acme-ltd'
 */
export function routeKeyOf(record: ModelBase, field: string | undefined): string | number {
  const column = field ?? record.runtime().info().primaryKey.name
  const value = attribute(record, column)
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'bigint') return value.toString()
  throw new OrmUsageError(
    'no_route_key',
    `This ${record.runtime().name} has no "${column}" value to put in a URL. Save it first, or bind by another column.`,
  )
}

/**
 * The adapter type check: an ORM model class is a {@link ResourceModel}. Used by tests and by
 * `resourceController()` to fail at boot with a clear message instead of at the first request.
 *
 * @example
 * isResourceModel(Customer) // true
 */
export function isResourceModel(value: unknown): value is ResourceModel<ResourceRecord> {
  return (
    (typeof value === 'function' || (typeof value === 'object' && value !== null)) &&
    typeof Reflect.get(value, 'metadata') === 'function' &&
    typeof Reflect.get(value, 'paginate') === 'function' &&
    typeof Reflect.get(value, 'resolveRouteBinding') === 'function' &&
    typeof Reflect.get(value, 'isTaken') === 'function' &&
    typeof Reflect.get(value, 'createFromValidated') === 'function'
  )
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/** Wire operators (ADR-0011 and resources.json) → the builder's vocabulary. */
const OPERATORS: Readonly<Record<string, FilterOperator>> = {
  eq: 'eq',
  ne: 'ne',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  in: 'in',
  contains: 'contains',
  startsWith: 'startsWith',
  null: 'null',
  isNull: 'null',
  isNotNull: 'null',
}

function applyFilter(
  builder: Builder<AnyModelClass, ModelBase>,
  meta: OrmResourceMetadata,
  field: string,
  wireOperator: string,
  raw: readonly string[],
  issues: IssueInput[],
): void {
  const path = ['query', 'filter', field, wireOperator]
  if (field.includes('.')) {
    issues.push({ path, code: 'relation_path_unsupported' })
    return
  }
  const definition = visibleField(meta, field)
  if (definition === undefined || definition.filterOperators.length === 0) {
    issues.push({ path, code: 'filter_not_allowed' })
    return
  }
  const operator = Object.hasOwn(OPERATORS, wireOperator) ? OPERATORS[wireOperator] : undefined
  if (operator === undefined || !definition.filterOperators.includes(operator)) {
    issues.push({ path, code: 'operator_not_allowed', params: { operator: wireOperator } })
    return
  }
  const invalid = (): void => {
    issues.push({ path, code: 'invalid_filter_value', params: { operator: wireOperator } })
  }
  const operand = filterOperand(definition, wireOperator, raw)
  if (operand === INVALID) {
    invalid()
    return
  }
  try {
    builder.filter(field, operator, operand)
  } catch (error) {
    if (!(error instanceof CastError || error instanceof OrmUsageError)) throw error
    invalid()
  }
}

const INVALID: unique symbol = Symbol('invalid')

/** The operand for the builder, or {@link INVALID}. Values arrive as text; casts make them typed. */
function filterOperand(
  field: FieldMetadata,
  operator: string,
  raw: readonly string[],
): unknown | typeof INVALID {
  if (raw.some((value) => value.length > MAX_SEARCH || value.includes('\u0000'))) return INVALID
  if (operator === 'isNull' || operator === 'isNotNull')
    return raw.length === 1 && raw[0] === 'true' ? operator === 'isNull' : INVALID
  if (operator === 'null')
    return raw.length === 1 && (raw[0] === 'true' || raw[0] === 'false')
      ? raw[0] === 'true'
      : INVALID
  if (operator === 'in') {
    if (raw.length < 1 || raw.length > MAX_IN_VALUES) return INVALID
    const values = raw.map((value) => typedValue(field, value))
    return values.includes(INVALID) ? INVALID : values
  }
  const [value] = raw
  if (raw.length !== 1 || value === undefined || value === '') return INVALID
  return operator === 'contains' || operator === 'startsWith' ? value : typedValue(field, value)
}

/** Text from a URL → the type the column's cast expects (booleans and doubles need conversion). */
function typedValue(field: FieldMetadata, value: string): unknown | typeof INVALID {
  if (field.cast === 'boolean')
    return value === 'true' || value === '1'
      ? true
      : value === 'false' || value === '0'
        ? false
        : INVALID
  if (field.cast === 'number') {
    const parsed = Number(value)
    return value.trim() !== '' && Number.isFinite(parsed) ? parsed : INVALID
  }
  return value
}

function applySearch(
  builder: Builder<AnyModelClass, ModelBase>,
  meta: OrmResourceMetadata,
  raw: string | null,
  issues: IssueInput[],
): void {
  if (raw === null || raw.trim() === '') return
  if (raw.length > MAX_SEARCH || raw.includes('\u0000') || !raw.isWellFormed()) {
    issues.push({ path: ['query', 'search'], code: 'too_long', params: { max: MAX_SEARCH } })
    return
  }
  const fields = meta.fields.filter((field) => !field.hidden)
  const text = fields.filter((field) => field.searchable === 'text').map((field) => field.name)
  const exact = fields.filter((field) => field.searchable === 'exact').map((field) => field.name)
  // AND between words, OR across columns (blueprint §5); a handful of words at most.
  const words = raw.trim().split(/\s+/).slice(0, MAX_SEARCH_WORDS)
  for (const word of words) builder.search(word, text, exact)
}

function applySort(
  builder: Builder<AnyModelClass, ModelBase>,
  meta: OrmResourceMetadata,
  raw: string | null,
  issues: IssueInput[],
): void {
  const fromDefault = raw === null || raw.trim() === ''
  const spec = fromDefault ? meta.defaultSort : raw
  const parts = spec.split(',').map((part) => part.trim())
  if (parts.length > MAX_SORTS) {
    issues.push({ path: ['query', 'sort'], code: 'too_many_sorts', params: { max: MAX_SORTS } })
    return
  }
  const accepted: string[] = []
  for (const part of parts) {
    const name = part.startsWith('-') ? part.slice(1) : part
    if (visibleField(meta, name)?.sortable !== true) {
      // The default sort on a field this user may not read is dropped, not reported: the order
      // would reveal its values, and the client never asked for it.
      if (!fromDefault)
        issues.push({ path: ['query', 'sort'], code: 'sort_not_allowed', params: { field: name } })
      continue
    }
    accepted.push(part)
  }
  // Deterministic order (blueprint §5): the primary key breaks every tie.
  const key = meta.primaryKey
  if (!accepted.some((part) => part === key || part === `-${key}`))
    accepted.push(accepted.at(-1)?.startsWith('-') === true ? `-${key}` : key)
  if (accepted.length > 0) builder.sort(accepted.join(','))
}

function parseIncludes(
  model: ResourceSource,
  raw: string | null,
  issues: IssueInput[],
  access: ResourceReadAccess | undefined,
): string[] {
  if (raw === null || raw === '') return []
  const names = [...new Set(raw.split(',').map((name) => name.trim()))]
  if (names.length > MAX_INCLUDES) {
    issues.push({
      path: ['query', 'include'],
      code: 'too_many_includes',
      params: { max: MAX_INCLUDES },
    })
    return []
  }
  const accepted: string[] = []
  for (const name of names) {
    // With access decided, an include the controller didn't clear is refused like an unknown one.
    if (includableModel(model, name) === undefined || (access && !access.includes.has(name)))
      issues.push({
        path: ['query', 'include'],
        code: 'include_not_allowed',
        params: { relation: name },
      })
    else accepted.push(name)
  }
  return accepted
}

function parseFields(
  meta: OrmResourceMetadata,
  raw: string | null,
  issues: IssueInput[],
): string[] | undefined {
  if (raw === null) return undefined
  const names = [...new Set(raw.split(',').map((name) => name.trim()))].filter(
    (name) => name !== '',
  )
  const accepted: string[] = [meta.primaryKey]
  for (const name of names) {
    if (visibleField(meta, name) === undefined)
      issues.push({ path: ['query', 'fields'], code: 'unknown_field', params: { field: name } })
    else if (!accepted.includes(name)) accepted.push(name)
  }
  return accepted
}

interface PageRequest {
  readonly number: number
  readonly size: number
  readonly withTotal: boolean
}

function parsePage(
  meta: OrmResourceMetadata,
  query: URLSearchParams,
  issues: IssueInput[],
): PageRequest {
  const max = Math.min(ormConfig().maxPerPage, 100)
  let size = Math.min(meta.perPage, max)
  const sizeRaw = query.get('page[size]')
  if (sizeRaw !== null) {
    const parsed = Number(sizeRaw)
    if (!/^\d{1,4}$/.test(sizeRaw) || parsed < 1 || parsed > max)
      issues.push({ path: ['query', 'page', 'size'], code: 'invalid_page_size', params: { max } })
    else size = parsed
  }
  let number = 1
  const numberRaw = query.get('page[number]')
  if (numberRaw !== null) {
    const parsed = Number(numberRaw)
    if (!/^\d{1,6}$/.test(numberRaw) || parsed < 1)
      issues.push({ path: ['query', 'page', 'number'], code: 'invalid_page_number' })
    else number = parsed
  }
  if (number * size > MAX_PAGE_DEPTH)
    issues.push({
      path: ['query', 'page', 'number'],
      code: 'page_too_deep',
      params: { max: MAX_PAGE_DEPTH },
    })
  const total = query.get('page[total]')
  if (total !== null && total !== 'true' && total !== 'false')
    issues.push({ path: ['query', 'page', 'total'], code: 'invalid_type' })
  return { number, size, withTotal: total === 'true' }
}

/** A field the API may name: in the metadata and not hidden. */
function visibleField(meta: OrmResourceMetadata, name: string): FieldMetadata | undefined {
  const field = meta.fields.find((candidate) => candidate.name === name)
  return field === undefined || field.hidden ? undefined : field
}

/** Server-side list conditions (`indexConstraints`): ANDed, `anyOf` ORed. */
function applyConstraint(
  builder: Builder<AnyModelClass, ModelBase>,
  constraint: Constraint,
  conjunction: 'and' | 'or',
  primaryKey: string,
): void {
  const add = (target: Builder<AnyModelClass, ModelBase>): void => {
    if ('anyOf' in constraint) {
      if (constraint.anyOf.length === 0) {
        // "Any of nothing" matches nothing: fail closed, never "no condition".
        target.filter(primaryKey, 'null', true)
        return
      }
      target.where((group) => {
        for (const member of constraint.anyOf) applyConstraint(group, member, 'or', primaryKey)
      })
      return
    }
    if (constraint.equals === null) target.filter(constraint.column, 'null', true)
    else target.filter(constraint.column, 'eq', constraint.equals)
  }
  if (conjunction === 'and') add(builder)
  else builder.orWhere((group) => add(group))
}

/** A model class with its `Model()` options: what the metadata is derived from. */
function isResourceSource(value: unknown): value is ResourceSource {
  return isModelRuntime(value) && typeof Reflect.get(value, 'options') === 'object'
}

/** Load relations onto one record without the lazy-loading guard (it is not a loop). */
async function loadOnto(record: ModelBase, tree: EagerTree): Promise<void> {
  await loadRelations([record], tree)
}

/** The metadata as one user may use it: unreadable fields count as hidden (never named). */
function readableMeta(
  meta: OrmResourceMetadata,
  readable: readonly string[] | undefined,
): OrmResourceMetadata {
  if (readable === undefined) return meta
  const allowed = new Set([...readable, meta.primaryKey])
  return {
    ...meta,
    fields: meta.fields.map((field) =>
      allowed.has(field.name) ? field : { ...field, hidden: true },
    ),
  }
}

/** The fields of (readable) metadata a row may show. */
function readableKeys(meta: OrmResourceMetadata): string[] {
  return meta.fields.filter((field) => !field.hidden).map((field) => field.name)
}

/** `with({ orders: (query) => … })`: each include limited to the related policy's scope. */
function includeConstraints(
  model: ResourceSource,
  includes: readonly string[],
  access: ResourceReadAccess | undefined,
): Record<string, (query: Builder<AnyModelClass, ModelBase>) => void> {
  const constrained: Record<string, (query: Builder<AnyModelClass, ModelBase>) => void> = {}
  for (const name of includes) constrained[name] = includeConstraint(model, name, access)
  return constrained
}

/** The eager-loading tree for one record's includes, constrained like {@link includeConstraints}. */
function includeTree(
  model: ResourceSource,
  includes: readonly string[],
  access: ResourceReadAccess | undefined,
): EagerTree {
  const tree: EagerTree = new Map()
  for (const name of includes) {
    const constrain = includeConstraint(model, name, access)
    tree.set(name, {
      constrain: (query: never) => Reflect.apply(constrain, undefined, [query]),
      children: new Map(),
    })
  }
  return tree
}

function includeConstraint(
  model: ResourceSource,
  name: string,
  access: ResourceReadAccess | undefined,
): (query: Builder<AnyModelClass, ModelBase>) => void {
  const rule = access?.includes.get(name)
  const related = includableModel(model, name)
  if (rule === undefined || related === undefined) return () => undefined
  const key = related.info().primaryKey.name
  return (query) => {
    for (const constraint of rule.constraints) applyConstraint(query, constraint, 'and', key)
  }
}

/**
 * After loading: drop included rows the related policy's `view` refuses (the scope is its SQL
 * form; `view` has the last word), and show only that policy's readable fields.
 */
async function concealIncludes(
  model: ResourceSource,
  rows: readonly ModelBase[],
  includes: readonly string[],
  access: ResourceReadAccess | undefined,
): Promise<void> {
  if (access === undefined) return
  for (const name of includes) {
    const rule = access.includes.get(name)
    if (rule === undefined) continue
    const related = includableModel(model, name)
    const keys =
      rule.readable === undefined || related === undefined
        ? undefined
        : readableKeys(readableMeta(resourceMetadataOf(related), rule.readable))
    for (const row of rows) {
      const loaded = attribute(row, name)
      if (Array.isArray(loaded)) {
        const kept = await visibleOnly(loaded, rule, keys)
        setLoaded(row, name, kept)
      } else if (loaded instanceof Object) {
        const [kept] = await visibleOnly([loaded], rule, keys)
        setLoaded(row, name, kept ?? null)
      }
    }
  }
}

async function visibleOnly(
  records: readonly unknown[],
  rule: IncludeAccess,
  keys: readonly string[] | undefined,
): Promise<unknown[]> {
  const kept: unknown[] = []
  for (const record of records) {
    if (!(await rule.visible(record))) continue
    if (keys !== undefined && isModel(record)) record.setVisible(keys)
    kept.push(record)
  }
  return kept
}

function isModel(value: unknown): value is ModelBase {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'setVisible') === 'function'
  )
}

function singularParam(table: string): string {
  return table.endsWith('s') ? table.slice(0, -1) : table
}
