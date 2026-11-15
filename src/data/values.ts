/**
 * Value conversion between three worlds that must agree exactly:
 *
 * - **API values** (JSON): decimals and big integers as strings, dates as `YYYY-MM-DD`,
 *   datetimes as ISO-8601 UTC strings, JSON as objects.
 * - **Database parameters** written by the repository.
 * - **Database rows** read back, which differ per driver (PGlite returns `Date` objects and
 *   numeric strings, libSQL returns integers and text).
 *
 * Every stored value is **canonical** (`10.5` → `"10.50"` for `decimal(12,2)`, datetimes always
 * `…T…sssZ`), so equality and ordering behave the same in Postgres, SQLite and the in-memory
 * evaluator. Canonical forms are what make the SQL ↔ memory equivalence tests pass.
 *
 * @module
 */
import type { Dialect } from '../database/types.ts'
import type { FieldDef, FieldKind } from '../model/field.ts'

/** Thrown when a value cannot be converted to a field's type. */
export class ValueError extends Error {
  override readonly name = 'ValueError'
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/
const BIGINT = /^-?\d{1,19}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/**
 * Canonical decimal text: no leading zeros, at least `scale` fraction digits (more are kept, minus
 * trailing zeros, so a too-precise filter value never silently rounds into a match), `-0` → `0`.
 */
export function canonicalDecimal(value: string | number, scale: number): string {
  const text = typeof value === 'number' ? numberToPlain(value) : value.trim()
  const m = DECIMAL.exec(text)
  if (!m) throw new ValueError(`"${String(value)}" is not a decimal number`)
  const [, sign = '', int = '0', frac = ''] = m
  const intPart = int.replace(/^0+(?=\d)/, '')
  let fracPart = frac.length > scale ? frac.replace(/0+$/, '') : frac
  if (fracPart.length < scale) fracPart = fracPart.padEnd(scale, '0')
  const isZero = /^0*$/.test(intPart) && /^0*$/.test(fracPart)
  return `${isZero ? '' : sign}${intPart}${fracPart.length > 0 ? `.${fracPart}` : ''}`
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new ValueError('decimal must be finite')
  // Avoid exponent notation (1e-7) which the decimal pattern rejects.
  return Math.abs(n) < 1e21 ? n.toFixed(20).replace(/\.?0+$/, '') : String(n)
}

/** Canonical 64-bit integer text. */
export function canonicalBigInt(value: string | number | bigint): string {
  let n: bigint
  if (typeof value === 'bigint') n = value
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ValueError('big integer must be an exact integer')
    n = BigInt(value)
  } else {
    if (!BIGINT.test(value.trim())) throw new ValueError(`"${value}" is not an integer`)
    n = BigInt(value.trim())
  }
  if (n < INT64_MIN || n > INT64_MAX) throw new ValueError('big integer out of 64-bit range')
  return n.toString()
}

/**
 * Years every engine stores: 0001-9999. Year 0000 (1 BC) is valid ISO-8601 and fine for SQLite,
 * but Postgres `date`/`timestamptz` have no year zero and reject it, so it is refused everywhere
 * (fail closed) instead of failing inside one database as a server error.
 */
const STORABLE_YEAR = /^(?!0000)\d{4}-/

/** Canonical calendar date `YYYY-MM-DD` (validates the day exists; years 0001-9999). */
export function canonicalDate(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValueError('invalid date')
    const iso = value.toISOString()
    if (!STORABLE_YEAR.test(iso)) throw new ValueError('date year must be 0001-9999')
    return iso.slice(0, 10)
  }
  const m = DATE.exec(value)
  if (!m) throw new ValueError(`"${value}" is not a YYYY-MM-DD date`)
  const d = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ValueError(`"${value}" is not a valid date`)
  }
  if (!STORABLE_YEAR.test(value)) throw new ValueError('date year must be 0001-9999')
  return value
}

/** Canonical instant: ISO-8601 UTC with milliseconds (`2026-11-14T12:00:00.000Z`), years 0001-9999. */
export function canonicalDatetime(value: string | Date): string {
  const d = value instanceof Date ? value : parseIsoDatetime(value)
  if (Number.isNaN(d.getTime())) throw new ValueError(`"${String(value)}" is not a valid datetime`)
  const iso = d.toISOString()
  // Checked on the UTC instant: an offset can move a valid local time out of range.
  if (!STORABLE_YEAR.test(iso)) throw new ValueError('datetime year must be 0001-9999')
  return iso
}

function parseIsoDatetime(value: string): Date {
  // Only ISO-8601 with an explicit offset (or Postgres' `YYYY-MM-DD HH:MM:SS+00` text form).
  if (
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(value)
  ) {
    throw new ValueError(`"${value}" is not an ISO-8601 datetime with an offset`)
  }
  const normalised = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  return new Date(normalised)
}

/** Lower-case UUID text. */
export function canonicalUuid(value: string): string {
  if (!UUID.test(value)) throw new ValueError(`"${value}" is not a UUID`)
  return value.toLowerCase()
}

/** Whether a string contains U+0000, which Postgres text cannot store (fail closed everywhere). */
export function hasNul(value: string): boolean {
  return value.includes('\u0000')
}

/** A scalar usable in a filter after normalisation. */
export type FilterValue = string | number | boolean

/**
 * Convert a filter operand to the field's canonical comparison value. Accepts the API type and,
 * for query strings, its text form (`"42"`, `"true"`). Throws {@link ValueError} when invalid.
 */
export function filterValue(
  kind: FieldKind,
  def: Pick<FieldDef, 'scale'>,
  raw: unknown,
): FilterValue {
  switch (kind) {
    case 'string':
    case 'text':
    case 'email':
    case 'url':
    case 'enum':
      if (typeof raw !== 'string') throw new ValueError('expected text')
      if (hasNul(raw)) throw new ValueError('text must not contain U+0000')
      return raw
    case 'uuid':
    case 'belongsTo':
      if (typeof raw !== 'string') throw new ValueError('expected a UUID')
      return canonicalUuid(raw)
    case 'integer':
    case 'float': {
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : Number.NaN
      if (!Number.isFinite(n)) throw new ValueError('expected a number')
      if (kind === 'integer' && !Number.isInteger(n)) throw new ValueError('expected an integer')
      return n
    }
    case 'bigInteger':
      if (typeof raw !== 'string' && typeof raw !== 'number')
        throw new ValueError('expected an integer')
      return canonicalBigInt(raw)
    case 'decimal':
      if (typeof raw !== 'string' && typeof raw !== 'number')
        throw new ValueError('expected a decimal')
      return canonicalDecimal(raw, def.scale ?? 2)
    case 'boolean':
      if (typeof raw === 'boolean') return raw
      if (raw === 'true' || raw === 'false') return raw === 'true'
      throw new ValueError('expected true or false')
    case 'date':
      if (typeof raw !== 'string') throw new ValueError('expected a date')
      return canonicalDate(raw)
    case 'datetime':
      if (typeof raw !== 'string') throw new ValueError('expected a datetime')
      return canonicalDatetime(raw)
    case 'json':
      throw new ValueError('JSON fields cannot be compared')
  }
}

/** Convert a validated API value to the database parameter for a column. */
export function encodeValue(def: FieldDef, value: unknown, dialect: Dialect): unknown {
  if (value === null || value === undefined) return null
  switch (def.kind) {
    case 'decimal':
      return canonicalDecimal(value as string, def.scale ?? 2)
    case 'bigInteger':
      return canonicalBigInt(value as string)
    case 'datetime':
      return canonicalDatetime(value as string)
    case 'date':
      return canonicalDate(value as string)
    case 'uuid':
    case 'belongsTo':
      return canonicalUuid(value as string)
    case 'json':
      return JSON.stringify(value)
    case 'boolean':
      return dialect === 'sqlite' ? (value ? 1 : 0) : Boolean(value)
    default:
      return value
  }
}

/** Convert a database value back to the API value for a field kind. */
export function decodeValue(kind: FieldKind, def: Pick<FieldDef, 'scale'>, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  switch (kind) {
    case 'integer':
    case 'float':
      return Number(raw)
    case 'bigInteger':
      return typeof raw === 'bigint' ? raw.toString() : canonicalBigInt(String(raw))
    case 'decimal':
      return canonicalDecimal(String(raw), def.scale ?? 2)
    case 'boolean':
      return raw === true || raw === 1 || raw === 1n || raw === 't' || raw === 'true'
    case 'date':
      return canonicalDate(raw instanceof Date ? raw : String(raw).slice(0, 10))
    case 'datetime':
      return canonicalDatetime(raw instanceof Date ? raw : String(raw))
    case 'json':
      return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    case 'uuid':
    case 'belongsTo':
      return String(raw).toLowerCase()
    default:
      return String(raw)
  }
}
