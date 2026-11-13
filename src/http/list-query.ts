/**
 * The REST list-query protocol (ADR-0011): one module that both **serializes** (clients) and
 * **parses** (server), so the two sides can never drift.
 *
 * Wire format:
 * - `filter[<field>][<op>]=<value>`; multi-value operators repeat the key
 *   (`filter[status][in]=draft&filter[status][in]=sent`), so values containing commas are never
 *   mis-split. `isNull` / `isNotNull` take the value `true`.
 * - `sort=-amount,number` (minus = descending).
 * - `page[size]=25`, plus either `page[cursor]=<opaque>` or `page[number]=3`; `page[total]=true`
 *   opts in to a total count.
 * - `search=<text>`, `include=customer,lines`.
 *
 * Anything else is rejected (`unknown_parameter`), so typos fail loudly instead of being
 * ignored, and *every* problem is reported at once, as RFC-0003 issues under `query.*`.
 *
 * @module
 */
import {
  FILTER_OPERATORS,
  type FilterOperator,
  type FilterScalar,
  LIST_QUERY_LIMITS,
  type ListQuery,
  type QueryFilter,
  type SortDirective,
} from '@strutvane/contracts'
import type { IssueInput } from '@strutvane/core'
import { filterValue, ValueError } from '../data/values.ts'
import type { QueryField } from '../query/fields.ts'

const MULTI_VALUE: ReadonlySet<string> = new Set(['in', 'nin', 'between'])
const NULL_CHECK: ReadonlySet<string> = new Set(['isNull', 'isNotNull'])
const TEXT: ReadonlySet<string> = new Set(['contains', 'startsWith', 'endsWith'])
const FILTER_KEY = /^filter\[([A-Za-z][A-Za-z0-9_.]*)\]\[([A-Za-z]+)\]$/
const KNOWN = new Set([
  'sort',
  'page[size]',
  'page[cursor]',
  'page[number]',
  'page[total]',
  'search',
  'include',
])
const MAX_VALUES = 100
const MAX_TEXT = 200
const MAX_PARAMS = 100

/** Client-side list parameters (what a typed client accepts). */
export interface ListParams {
  readonly filter?: Readonly<Record<string, Readonly<Partial<Record<FilterOperator, unknown>>>>>
  readonly sort?: readonly string[]
  readonly page?: {
    readonly size?: number
    readonly cursor?: string
    readonly number?: number
    readonly total?: boolean
  }
  readonly search?: string
  readonly include?: readonly string[]
}

/** Serialize list params to a query string (no leading `?`). Deterministic key order. */
export function serializeListParams(params: ListParams): string {
  const out = new URLSearchParams()
  for (const [field, ops] of Object.entries(params.filter ?? {}).sort(byKey)) {
    for (const [op, value] of Object.entries(ops).sort(byKey)) {
      if (value === undefined) continue
      const key = `filter[${field}][${op}]`
      if (Array.isArray(value)) for (const v of value) out.append(key, String(v))
      else out.append(key, String(value))
    }
  }
  if (params.sort && params.sort.length > 0) out.append('sort', params.sort.join(','))
  if (params.page?.size !== undefined) out.append('page[size]', String(params.page.size))
  if (params.page?.cursor !== undefined) out.append('page[cursor]', params.page.cursor)
  if (params.page?.number !== undefined) out.append('page[number]', String(params.page.number))
  if (params.page?.total) out.append('page[total]', 'true')
  if (params.search !== undefined) out.append('search', params.search)
  if (params.include && params.include.length > 0) out.append('include', params.include.join(','))
  return out.toString()
}

function byKey(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

/** What a resource allows in list queries. */
export interface ListQueryRules {
  /** Queryable fields by API key (filterability per field is in `def.filterOperators`). */
  readonly fields: ReadonlyMap<string, QueryField>
  /** Relations that may be included. */
  readonly includes: readonly string[]
  readonly maxPageSize?: number
  readonly defaultPageSize?: number
}

/** A parsed list request (the contract's `ListQuery` plus the total opt-in). */
export interface ParsedListQuery extends ListQuery {
  readonly withTotal: boolean
}

/** Parse result: the query, or every issue found. */
export type ParseResult =
  | { readonly ok: true; readonly query: ParsedListQuery }
  | { readonly ok: false; readonly issues: readonly IssueInput[] }

/** Parse and validate a list query string against a resource's allow-lists. */
export function parseListQuery(search: URLSearchParams, rules: ListQueryRules): ParseResult {
  const issues: IssueInput[] = []
  const filters: QueryFilter[] = []
  const keys = [...new Set(search.keys())]
  if (keys.length > MAX_PARAMS) {
    return {
      ok: false,
      issues: [{ path: ['query'], code: 'too_many_parameters', params: { max: MAX_PARAMS } }],
    }
  }
  for (const key of keys) {
    const values = search.getAll(key)
    const match = FILTER_KEY.exec(key)
    if (match) {
      const [, field = '', op = ''] = match
      const filter = parseFilter(field, op, values, rules, issues)
      if (filter) filters.push(filter)
    } else if (!KNOWN.has(key)) {
      issues.push({ path: ['query', key], code: 'unknown_parameter', params: { name: key } })
    } else if (values.length > 1) {
      issues.push({ path: ['query', key], code: 'duplicate_parameter', params: { name: key } })
    }
  }
  const sort = parseSort(search.get('sort'), rules, issues)
  const page = parsePage(search, rules, issues)
  const include = parseInclude(search.get('include'), rules, issues)
  const text = search.get('search')
  if (text !== null && (text.length > MAX_TEXT || text.includes('\u0000'))) {
    issues.push({ path: ['query', 'search'], code: 'too_long', params: { max: MAX_TEXT } })
  }
  const total = search.get('page[total]')
  if (total !== null && total !== 'true' && total !== 'false') {
    issues.push({ path: ['query', 'page', 'total'], code: 'invalid_type' })
  }
  if (issues.length > 0) return { ok: false, issues }
  const filter: QueryFilter | undefined =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { op: 'and', filters }
  return {
    ok: true,
    query: {
      ...(filter ? { filter } : {}),
      ...(sort.length > 0 ? { sort } : {}),
      page,
      ...(text !== null && text.trim() !== '' ? { search: text } : {}),
      ...(include.length > 0 ? { include } : {}),
      withTotal: total === 'true',
    },
  }
}

function parseFilter(
  field: string,
  op: string,
  raw: readonly string[],
  rules: ListQueryRules,
  issues: IssueInput[],
): QueryFilter | undefined {
  const path = ['query', 'filter', field, op]
  if (field.includes('.')) {
    issues.push({ path, code: 'relation_path_unsupported' })
    return undefined
  }
  const def = rules.fields.get(field)?.def
  if (!def || def.filterOperators.length === 0) {
    issues.push({ path, code: 'filter_not_allowed' })
    return undefined
  }
  if (!isOperator(op) || !def.filterOperators.includes(op)) {
    issues.push({ path, code: 'operator_not_allowed', params: { operator: op } })
    return undefined
  }
  const bad = (): undefined => {
    issues.push({ path, code: 'invalid_filter_value', params: { operator: op } })
    return undefined
  }
  if (NULL_CHECK.has(op)) {
    return raw.length === 1 && raw[0] === 'true'
      ? { op: op as 'isNull' | 'isNotNull', field }
      : bad()
  }
  if (TEXT.has(op)) {
    // Text operators match substrings, so the value is not validated against the field's
    // format (a partial email is a valid search term); only length and U+0000 are checked.
    const [value] = raw
    if (
      raw.length !== 1 ||
      value === undefined ||
      value === '' ||
      value.length > MAX_TEXT ||
      value.includes('\u0000')
    ) {
      return bad()
    }
    return { op: op as 'contains' | 'startsWith' | 'endsWith', field, value }
  }
  const values: FilterScalar[] = []
  for (const v of raw) {
    try {
      values.push(filterValue(def.kind, def, v))
    } catch (error) {
      if (error instanceof ValueError) return bad()
      throw error
    }
  }
  if (op === 'between') {
    const [from, to] = values
    return values.length === 2 && from !== undefined && to !== undefined
      ? { op: 'between', field, from, to }
      : bad()
  }
  if (MULTI_VALUE.has(op)) {
    return values.length >= 1 && values.length <= MAX_VALUES
      ? { op: op as 'in' | 'nin', field, values }
      : bad()
  }
  const [value] = values
  return values.length === 1 && value !== undefined
    ? { op: op as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', field, value }
    : bad()
}

function parseSort(
  raw: string | null,
  rules: ListQueryRules,
  issues: IssueInput[],
): SortDirective[] {
  if (raw === null || raw === '') return []
  const out: SortDirective[] = []
  const parts = raw.split(',')
  if (parts.length > 5) {
    issues.push({ path: ['query', 'sort'], code: 'too_many_sorts', params: { max: 5 } })
    return []
  }
  for (const part of parts) {
    const desc = part.startsWith('-')
    const field = desc ? part.slice(1) : part
    if (!rules.fields.get(field)?.def.sortable) {
      issues.push({ path: ['query', 'sort'], code: 'sort_not_allowed', params: { field } })
      continue
    }
    out.push({ field, direction: desc ? 'desc' : 'asc' })
  }
  return out
}

function parsePage(
  search: URLSearchParams,
  rules: ListQueryRules,
  issues: IssueInput[],
): NonNullable<ListQuery['page']> {
  const max = Math.min(
    rules.maxPageSize ?? LIST_QUERY_LIMITS.maxPageSize,
    LIST_QUERY_LIMITS.maxPageSize,
  )
  let size = Math.min(rules.defaultPageSize ?? LIST_QUERY_LIMITS.defaultPageSize, max)
  const sizeRaw = search.get('page[size]')
  if (sizeRaw !== null) {
    const n = Number(sizeRaw)
    if (!/^\d+$/.test(sizeRaw) || n < 1 || n > max) {
      issues.push({ path: ['query', 'page', 'size'], code: 'invalid_page_size', params: { max } })
    } else size = n
  }
  const cursor = search.get('page[cursor]')
  const numberRaw = search.get('page[number]')
  if (cursor !== null && numberRaw !== null) {
    issues.push({ path: ['query', 'page'], code: 'conflicting_pagination' })
    return { kind: 'cursor', size }
  }
  if (numberRaw !== null) {
    const n = Number(numberRaw)
    if (!/^\d+$/.test(numberRaw) || n < 1 || n > 100_000) {
      issues.push({ path: ['query', 'page', 'number'], code: 'invalid_page_number' })
      return { kind: 'cursor', size }
    }
    return { kind: 'offset', size, number: n }
  }
  if (cursor !== null) {
    if (cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      issues.push({ path: ['query', 'page', 'cursor'], code: 'invalid_cursor' })
    }
    return { kind: 'cursor', size, cursor }
  }
  return { kind: 'cursor', size }
}

function parseInclude(raw: string | null, rules: ListQueryRules, issues: IssueInput[]): string[] {
  if (raw === null || raw === '') return []
  const out: string[] = []
  for (const name of raw.split(',')) {
    if (!rules.includes.includes(name)) {
      issues.push({
        path: ['query', 'include'],
        code: 'include_not_allowed',
        params: { relation: name },
      })
    } else if (!out.includes(name)) out.push(name)
  }
  return out
}

function isOperator(op: string): op is FilterOperator {
  return (FILTER_OPERATORS as readonly string[]).includes(op)
}
