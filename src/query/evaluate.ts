/**
 * In-memory evaluation of a bound filter against one record: the exact twin of the SQL compiler,
 * proven equivalent by property-based tests on both engines.
 *
 * The record holds API values (as the repository returns them). Values are canonicalised with
 * the same functions the binder uses, so `"10.5"` and `"10.50"` compare equal here as they do in
 * SQL. A field missing from the record throws (it was not loaded), rather than reading as null.
 *
 * @module
 */
import { canonicalDatetime, type FilterValue, filterValue } from '../data/values.ts'
import type { BoundField, BoundFilter } from './bind.ts'

/** A record as returned by the repository. */
export type RecordValues = Readonly<Record<string, unknown>>

/** Thrown when the record lacks a field the filter reads. */
export class MissingFieldError extends Error {
  override readonly name = 'MissingFieldError'
}

const asciiFold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

function read(record: RecordValues, field: BoundField): FilterValue | null {
  if (!Object.hasOwn(record, field.key))
    throw new MissingFieldError(`record has no field "${field.key}"`)
  const raw = record[field.key]
  if (raw === null || raw === undefined) return null
  if (field.kind === 'datetime' && (raw instanceof Date || typeof raw === 'string'))
    return canonicalDatetime(raw)
  return filterValue(field.kind, field, raw)
}

/** Compare two canonical values of one field: negative, zero or positive. */
function compare(field: BoundField, a: FilterValue, b: FilterValue): number {
  switch (field.kind) {
    case 'bigInteger': {
      const x = BigInt(a as string)
      const y = BigInt(b as string)
      return x < y ? -1 : x > y ? 1 : 0
    }
    case 'decimal':
      return Number(a) - Number(b)
    case 'integer':
    case 'float':
      return (a as number) - (b as number)
    default:
      // Code-point order (Postgres `COLLATE "C"` and SQLite BINARY compare UTF-8 bytes, which
      // is code-point order); dates and datetimes are canonical text.
      return compareCodePoints(String(a), String(b))
  }
}

/** Compare strings by Unicode code point (not UTF-16 code unit, which differs for astral characters). */
export function compareCodePoints(a: string, b: string): number {
  const x = a[Symbol.iterator]()
  const y = b[Symbol.iterator]()
  for (;;) {
    const p = x.next()
    const q = y.next()
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1
    const d = (p.value.codePointAt(0) ?? 0) - (q.value.codePointAt(0) ?? 0)
    if (d !== 0) return d
  }
}

const equal = (field: BoundField, a: FilterValue | null, b: FilterValue): boolean =>
  a !== null &&
  (field.kind === 'decimal' || field.kind === 'bigInteger' ? compare(field, a, b) === 0 : a === b)

/** Evaluate a bound filter against a record. */
export function evaluateFilter(filter: BoundFilter, record: RecordValues): boolean {
  switch (filter.op) {
    case 'true':
      return true
    case 'false':
      return false
    case 'and':
      return filter.filters.every((f) => evaluateFilter(f, record))
    case 'or':
      return filter.filters.some((f) => evaluateFilter(f, record))
    case 'not':
      return !evaluateFilter(filter.filter, record)
    case 'isNull':
      return read(record, filter.field) === null
    case 'isNotNull':
      return read(record, filter.field) !== null
    case 'eq':
      return equal(filter.field, read(record, filter.field), filter.value)
    case 'ne':
      return !equal(filter.field, read(record, filter.field), filter.value)
    case 'in': {
      const v = read(record, filter.field)
      return filter.values.some((x) => equal(filter.field, v, x))
    }
    case 'nin': {
      const v = read(record, filter.field)
      return !filter.values.some((x) => equal(filter.field, v, x))
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const v = read(record, filter.field)
      if (v === null) return false
      const c = compare(filter.field, v, filter.value)
      if (filter.op === 'gt') return c > 0
      if (filter.op === 'gte') return c >= 0
      if (filter.op === 'lt') return c < 0
      return c <= 0
    }
    case 'between': {
      const v = read(record, filter.field)
      return (
        v !== null &&
        compare(filter.field, v, filter.from) >= 0 &&
        compare(filter.field, v, filter.to) <= 0
      )
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const v = read(record, filter.field)
      if (typeof v !== 'string') return false
      const hay = filter.caseSensitive ? v : asciiFold(v)
      const needle = filter.caseSensitive ? filter.value : asciiFold(filter.value)
      if (filter.op === 'contains') return hay.includes(needle)
      if (filter.op === 'startsWith') return hay.startsWith(needle)
      return hay.endsWith(needle)
    }
  }
}
