/**
 * Binding: a portable {@link QueryFilter} (from a policy, the UI or the list query) becomes a
 * {@link BoundFilter}: fields resolved to columns, values converted to canonical form, actor
 * references replaced by the actor's values. Both the SQL compiler and the in-memory evaluator
 * consume only bound filters, so they can never interpret an input differently (ADR-0008).
 *
 * Fail closed: unknown fields, operators a field does not support, mistyped values, U+0000 and
 * missing actor attributes all throw {@link FilterError}, identically for both paths.
 *
 * Scope: fields of the model itself (plus `id` and timestamps). Relation paths
 * (`customer.region`) are rejected with `relation_path_unsupported` for now.
 *
 * @module
 */
import type { Actor, FilterOperator, QueryFilter } from '../contracts/index.ts'
import { type FilterValue, filterValue, ValueError } from '../data/values.ts'
import { operatorsFor } from '../model/field.ts'
import type { QueryField } from './fields.ts'

/** A field reference after binding. */
export interface BoundField {
  readonly key: string
  readonly column: string
  readonly kind: QueryField['def']['kind']
  readonly scale?: number
}

/** The filter tree after binding. Values are canonical and never null. */
export type BoundFilter =
  | { readonly op: 'true' | 'false' }
  | { readonly op: 'and' | 'or'; readonly filters: readonly BoundFilter[] }
  | { readonly op: 'not'; readonly filter: BoundFilter }
  | {
      readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
      readonly field: BoundField
      readonly value: FilterValue
    }
  | {
      readonly op: 'in' | 'nin'
      readonly field: BoundField
      readonly values: readonly FilterValue[]
    }
  | { readonly op: 'isNull' | 'isNotNull'; readonly field: BoundField }
  | {
      readonly op: 'contains' | 'startsWith' | 'endsWith'
      readonly field: BoundField
      readonly value: string
      readonly caseSensitive: boolean
    }
  | {
      readonly op: 'between'
      readonly field: BoundField
      readonly from: FilterValue
      readonly to: FilterValue
    }

/** Why a filter could not be bound. `code` is an RFC-0003 issue code. */
export class FilterError extends Error {
  override readonly name = 'FilterError'
  readonly code: string
  readonly field: string | undefined
  readonly operator: string | undefined
  constructor(code: string, message: string, field?: string, operator?: string) {
    super(message)
    this.code = code
    this.field = field
    this.operator = operator
  }
}

/** Options for {@link bindFilter}. */
export interface BindOptions {
  /** The fields that may be referenced, by API key. */
  readonly fields: ReadonlyMap<string, QueryField>
  /**
   * `declared`: only the operators each field declared with `filterable(...)` (user filters).
   * `any`: every operator the field's kind supports (trusted policy filters).
   */
  readonly operators: 'declared' | 'any'
  /** The actor `$actor` references resolve against; `null` for anonymous (every value null). */
  readonly actor: Actor | null
  /**
   * Whether `{ $actor: … }` operands are allowed. Default: only for trusted filters
   * (`operators: 'any'`). Client filters must not use them: they would let a caller probe the
   * actor's server-side attributes, and a missing attribute is a server error.
   */
  readonly actorRefs?: boolean
  /** Maximum tree depth and node count (defence against hostile `/query` bodies). */
  readonly maxDepth?: number
  readonly maxNodes?: number
}

const MAX_IN_VALUES = 100
const MAX_TEXT = 200

/** Bind a filter. Throws {@link FilterError} for anything invalid. */
export function bindFilter(filter: QueryFilter, options: BindOptions): BoundFilter {
  let nodes = 0
  const maxDepth = options.maxDepth ?? 16
  const maxNodes = options.maxNodes ?? 500
  const actorRefs = options.actorRefs ?? options.operators === 'any'

  const visit = (f: QueryFilter, depth: number): BoundFilter => {
    nodes++
    // Untrusted trees (`POST /query`) may contain anything: reject non-objects before reading.
    if (typeof f !== 'object' || f === null || Array.isArray(f))
      throw new FilterError('invalid_filter', 'a filter node must be an object')
    if (depth > maxDepth)
      throw new FilterError('filter_too_complex', `filter nesting exceeds ${maxDepth}`)
    if (nodes > maxNodes)
      throw new FilterError('filter_too_complex', `filter has more than ${maxNodes} nodes`)
    switch (f.op) {
      case 'true':
      case 'false':
        return { op: f.op }
      case 'and':
      case 'or':
        if (!Array.isArray(f.filters))
          throw new FilterError('invalid_filter', `${f.op} needs a filters list`)
        return { op: f.op, filters: f.filters.map((x) => visit(x, depth + 1)) }
      case 'not':
        return { op: 'not', filter: visit(f.filter, depth + 1) }
      default:
        return leaf(f)
    }
  }

  const resolve = (path: unknown, op: FilterOperator): QueryField => {
    if (typeof path !== 'string')
      throw new FilterError('invalid_filter', 'filter field must be a string')
    if (path.includes('.')) {
      throw new FilterError(
        'relation_path_unsupported',
        `relation paths are not supported: "${path}"`,
        path,
        op,
      )
    }
    const field = options.fields.get(path)
    // Client filters never see hidden fields, whatever the definition says (no value oracle).
    if (!field || (options.operators === 'declared' && field.def.hidden))
      throw new FilterError(
        'filter_not_allowed',
        `unknown or non-filterable field "${path}"`,
        path,
        op,
      )
    const allowed =
      options.operators === 'declared' ? field.def.filterOperators : operatorsFor(field.def.kind)
    if (allowed.length === 0)
      throw new FilterError('filter_not_allowed', `"${path}" is not filterable`, path, op)
    if (!allowed.includes(op)) {
      throw new FilterError(
        'operator_not_allowed',
        `operator "${op}" is not allowed on "${path}"`,
        path,
        op,
      )
    }
    return field
  }

  const bound = (f: QueryField): BoundField => ({
    key: f.key,
    column: f.column,
    kind: f.def.kind,
    ...(f.def.scale !== undefined ? { scale: f.def.scale } : {}),
  })

  /** Resolve one operand: `undefined` means "the actor's value is null". */
  const operand = (
    field: QueryField,
    raw: unknown,
    op: FilterOperator,
  ): FilterValue | undefined => {
    let value = raw
    if (typeof raw === 'object' && raw !== null && '$actor' in raw) {
      if (!actorRefs) {
        throw new FilterError(
          'invalid_filter_value',
          'actor references are not allowed here',
          field.key,
          op,
        )
      }
      value = actorValue(options.actor, (raw as { $actor: unknown }).$actor)
      if (value === null) return undefined
    }
    if (value === null || value === undefined) {
      throw new FilterError(
        'invalid_filter_value',
        'null is not a comparison value; use isNull',
        field.key,
        op,
      )
    }
    try {
      return filterValue(field.def.kind, field.def, value)
    } catch (error) {
      if (error instanceof ValueError) {
        throw new FilterError('invalid_filter_value', error.message, field.key, op)
      }
      throw error
    }
  }

  const leaf = (
    f: Exclude<QueryFilter, { op: 'true' | 'false' | 'and' | 'or' | 'not' }>,
  ): BoundFilter => {
    const field = resolve(f.field, f.op)
    const ref = bound(field)
    switch (f.op) {
      case 'isNull':
      case 'isNotNull':
        return { op: f.op, field: ref }
      case 'eq':
      case 'ne': {
        const v = operand(field, f.value, f.op)
        // A null actor value never matches (contracts: eq → false, ne → true).
        if (v === undefined) return { op: f.op === 'eq' ? 'false' : 'true' }
        return { op: f.op, field: ref, value: v }
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const v = operand(field, f.value, f.op)
        if (v === undefined) return { op: 'false' }
        return { op: f.op, field: ref, value: v }
      }
      case 'in':
      case 'nin': {
        if (!Array.isArray(f.values))
          throw new FilterError('invalid_filter_value', `${f.op} needs a list`, field.key, f.op)
        if (f.values.length > MAX_IN_VALUES) {
          throw new FilterError(
            'invalid_filter_value',
            `${f.op} accepts at most ${MAX_IN_VALUES} values`,
            field.key,
            f.op,
          )
        }
        const values = f.values
          .map((v) => operand(field, v, f.op))
          .filter((v): v is FilterValue => v !== undefined)
        return { op: f.op, field: ref, values: [...new Set(values)] }
      }
      case 'between': {
        const from = operand(field, f.from, f.op)
        const to = operand(field, f.to, f.op)
        if (from === undefined || to === undefined) return { op: 'false' }
        return { op: 'between', field: ref, from, to }
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        if (
          typeof f.value !== 'string' ||
          f.value.length > MAX_TEXT ||
          f.value.includes('\u0000')
        ) {
          throw new FilterError(
            'invalid_filter_value',
            `text must be a string of at most ${MAX_TEXT} characters`,
            field.key,
            f.op,
          )
        }
        // Empty search text matches every non-null value; express it that way so all paths agree.
        if (f.value === '') return { op: 'isNotNull', field: ref }
        return { op: f.op, field: ref, value: f.value, caseSensitive: f.caseSensitive === true }
      }
      default:
        throw new FilterError(
          'invalid_filter',
          `unknown operator "${String((f as { op: unknown }).op)}"`,
        )
    }
  }

  return visit(filter, 0)
}

/**
 * Resolve an actor reference. Returns `null` for a null value; throws for a missing attribute,
 * because identity providers must set every attribute policies use (contracts, security).
 */
export function actorValue(actor: Actor | null, ref: unknown): unknown {
  if (typeof ref !== 'string') throw new FilterError('invalid_filter', '$actor must be a string')
  if (actor === null) return null
  if (ref === 'id') return actor.id
  if (ref === 'tenantId') return actor.tenantId ?? null
  if (ref.startsWith('attrs.')) {
    const name = ref.slice(6)
    if (!Object.hasOwn(actor.attrs, name)) {
      throw new FilterError('actor_attribute_missing', `actor attribute "${name}" is not set`)
    }
    const value = actor.attrs[name]
    if (value === undefined)
      throw new FilterError('actor_attribute_missing', `actor attribute "${name}" is not set`)
    return value
  }
  throw new FilterError('invalid_filter', `unknown actor reference "${ref}"`)
}

/** `and` of several filters, skipping `true` and short-circuiting `false`. */
export function andAll(filters: readonly BoundFilter[]): BoundFilter {
  const parts = filters.filter((f) => f.op !== 'true')
  if (parts.some((f) => f.op === 'false')) return { op: 'false' }
  if (parts.length === 0) return { op: 'true' }
  if (parts.length === 1) return parts[0] as BoundFilter
  return { op: 'and', filters: parts }
}
