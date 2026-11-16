/**
 * Casts: converting values between the database and the model, in both directions.
 *
 * Two layers, applied in this order on the way in (database → model) and reversed on the way out:
 *
 * 1. **Built-in kind casts**, chosen from the column kind in the schema snapshot. You never
 *    declare them: a `t.boolean()` column *is* a boolean, even on SQLite where it is stored as
 *    `0`/`1`; a `t.timestamp()` is a `Date`; a `t.json()` is parsed. They also make the engines
 *    agree (SQLite does not enforce `VARCHAR(200)`, so the cast does).
 * 2. **Model casts**, declared in `Model('posts', { casts: { … } })`, for what the column kind
 *    cannot know: the TypeScript type of a JSON column, or a custom transformation (Laravel's
 *    `Attribute::make(get:, set:)` accessors/mutators).
 */
import type { ColumnDef } from '../schema/snapshot.ts'
import { type Dialect, isMysqlFamily } from '../sql/grammar.ts'
import { CastError } from './errors.ts'

/**
 * A model cast: how a column's stored value becomes the model's value and back.
 * `TValue` is what app code sees; the type flows into the model's attribute types.
 *
 * @example
 * const lowercase: Cast<string> = cast({ get: (stored) => String(stored), set: (value) => value.toLowerCase() })
 */
export interface Cast<TValue> {
  /** Database form (after the built-in cast) → model value. */
  get(stored: unknown): TValue
  /** Model value → database form (before the built-in cast). */
  set(value: TValue): unknown
}

/**
 * Define a custom cast (an accessor + mutator pair).
 *
 * @example
 * const email = cast<string>({ get: (stored) => String(stored), set: (value) => value.trim().toLowerCase() })
 * class User extends Model('users', { casts: { email } }) {}
 */
export function cast<TValue>(definition: Cast<TValue>): Cast<TValue> {
  return definition
}

/**
 * Type a JSON column. Optionally validate it on read and write (pass a Zod/Valibot `parse`, or
 * any function that returns the value or throws). Without a validator the type is a promise
 * you make, as in every TypeScript ORM; with one it is checked.
 *
 * @example
 * interface PostMeta { readonly tags: readonly string[]; readonly pinned?: boolean }
 * class Post extends Model('posts', { casts: { meta: json<PostMeta>() } }) {}
 */
export function json<TValue>(validate?: (value: unknown) => TValue): Cast<TValue> {
  return {
    get: (stored) => (validate === undefined ? trustJson<TValue>(stored) : validate(stored)),
    set: (value) => (validate === undefined ? value : validate(value)),
  }
}

/**
 * The one place a JSON value is trusted to have the declared type without a validator. Kept as a
 * named function so the unchecked step is visible and searchable.
 */
function trustJson<TValue>(stored: unknown): TValue {
  return stored as TValue
}

/**
 * Run a model cast's `set`, turning anything it throws into a {@link CastError}. A mutator such as
 * `value.trim()` would otherwise crash with a TypeError on `{"email": 0}` from a request body;
 * now it is a clean validation error (a 422), raised before any SQL is sent.
 *
 * @example
 * applyCast('users', 'email', emailCast, ' A@B.C ') // 'a@b.c'
 */
export function applyCast(table: string, column: string, cast: Cast<unknown>, value: unknown): unknown {
  try {
    return cast.set(value)
  } catch (error) {
    throw new CastError(table, column, `the value could not be converted (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Database value → model value, by column kind.
 *
 * @example
 * fromDatabase({ name: 'featured', kind: 'boolean', nullable: false }, 1, 'sqlite') // true
 */
export function fromDatabase(column: ColumnDef, raw: unknown, dialect: Dialect): unknown {
  if (raw === null || raw === undefined) return null
  switch (column.kind) {
    case 'boolean':
      // SQLite stores booleans as 0/1 integers.
      return typeof raw === 'boolean' ? raw : Number(raw) !== 0
    case 'timestamp':
      return raw instanceof Date ? raw : new Date(String(raw))
    case 'date':
      // PGlite returns DATE as a Date at UTC midnight; SQLite returns the text we stored.
      return raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10)
    case 'json':
      // PGlite parses jsonb. SQLite stores JSON text, and the MySQL driver asks mysql2 for JSON as
      // text too (`jsonStrings`): MySQL's JSON type, MariaDB 11's JSON alias and MariaDB 10.4's
      // plain LONGTEXT then all arrive the same way, and "hello" or "123" are parsed exactly once.
      return dialect !== 'postgres' && typeof raw === 'string' ? JSON.parse(raw) : raw
    case 'decimal':
      return canonicalDecimal(raw, column.scale ?? 2)
    case 'id':
    case 'integer':
    case 'bigInteger':
    case 'foreignId':
      return toSafeInteger(raw, column)
    default:
      return raw
  }
}

/**
 * Model value → database value, by column kind. Validates as it goes so every engine stores
 * the same thing and rejects the same things.
 *
 * @example
 * toDatabase('posts', { name: 'status', kind: 'enum', nullable: false, values: ['draft'] }, 'draft', 'mysql') // 'draft'
 */
export function toDatabase(table: string, column: ColumnDef, value: unknown, dialect: Dialect): unknown {
  if (value === null || value === undefined) {
    if (!column.nullable && column.kind !== 'id') throw new CastError(table, column.name, 'it is required (the column is NOT NULL)')
    return null
  }
  switch (column.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new CastError(table, column.name, `expected true or false, got ${describe(value)}`)
      return value
    case 'timestamp':
      return timestampToDatabase(table, column, value, dialect)
    case 'date':
      return dateToDatabase(table, column, value)
    case 'json':
      return JSON.stringify(value)
    case 'decimal': {
      if (typeof value !== 'number' && typeof value !== 'string') throw new CastError(table, column.name, `expected a number or numeric string, got ${describe(value)}`)
      // A number is checked as JavaScript prints it (its shortest exact form), never via toFixed:
      // toFixed *rounds*, so 10.555 became 10.55 and 0.1 + 0.2 became 0.30 without an error.
      const text = typeof value === 'number' ? String(value) : value
      return canonicalDecimal(text, column.scale ?? 2, () => new CastError(table, column.name, `"${text}" is not a decimal with at most ${column.scale ?? 2} decimal places`))
    }
    case 'enum':
      if (typeof value !== 'string' || !(column.values ?? []).includes(value)) {
        throw new CastError(table, column.name, `${describe(value)} is not one of ${(column.values ?? []).join(', ')}`)
      }
      return value
    case 'string':
    case 'slug':
    case 'text':
      return stringToDatabase(table, column, value)
    case 'uuid':
      return uuidToDatabase(table, column, value)
    case 'id':
    case 'integer':
    case 'bigInteger':
    case 'foreignId':
      return integerToDatabase(table, column, value)
    case 'double':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new CastError(table, column.name, `expected a finite number, got ${describe(value)}`)
      return value
  }
}

/**
 * Typed binds (security review F-08). MySQL compares across types by converting: `'1abc' = 1`
 * and `'abc' = 0` are true there. So a value must already have its column's type before it
 * reaches SQL: whole numbers (or strings of digits, as they arrive in URLs) for integer columns,
 * nothing else. Objects and arrays never reach the driver.
 */
function integerToDatabase(table: string, column: ColumnDef, value: unknown): number | bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) return Number(value)
  throw new CastError(table, column.name, `expected a whole number, got ${describe(value)}`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidToDatabase(table: string, column: ColumnDef, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new CastError(table, column.name, `expected a UUID, got ${describe(value)}`)
  // One spelling only, so case-sensitive and case-insensitive engines agree.
  return value.toLowerCase()
}

function stringToDatabase(table: string, column: ColumnDef, value: unknown): string {
  if (typeof value !== 'string') throw new CastError(table, column.name, `expected text, got ${describe(value)}`)
  // U+0000 ends strings in C: PostgreSQL rejects it, others store it. Refuse it everywhere (ADR-0008).
  if (value.includes('\u0000')) throw new CastError(table, column.name, 'text may not contain the NUL character')
  // Half of a surrogate pair isn't text: encoded to UTF-8 it became U+FFFD on some engines and an
  // error on others, so what was stored differed from what was sent.
  if (!value.isWellFormed()) throw new CastError(table, column.name, 'the text contains malformed Unicode (a lone surrogate)')
  // SQLite ignores VARCHAR(n); enforcing it here makes SQLite reject what Postgres would reject.
  if (column.length !== undefined && [...value].length > column.length) {
    throw new CastError(table, column.name, `it is longer than ${column.length} characters`)
  }
  return value
}

/**
 * The only timestamp strings accepted: ISO 8601 with an explicit zone (`Z` or `±hh:mm`), or a bare
 * date meaning UTC midnight. `new Date()` alone would also take `'2026-11-14T10:00:00'` (read in the
 * *server's* time zone, so the stored instant depended on where the app ran), `'Nov 14 2026'` or `'1'`.
 */
const TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/
/** Years every engine stores (MySQL DATETIME: 1000–9999); outside them the engines disagree. */
const YEARS = { min: 1000, max: 9999 } as const

function timestampToDatabase(table: string, column: ColumnDef, value: unknown, dialect: Dialect): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? parseTimestamp(value) : undefined
  if (date === undefined || Number.isNaN(date.getTime()) || !inYearRange(date)) {
    throw new CastError(table, column.name, `expected a Date or an ISO-8601 string with a time zone (2026-11-14T09:30:00Z), years ${YEARS.min}–${YEARS.max}, got ${describe(value)}`)
  }
  const iso = date.toISOString()
  // MySQL DATETIME(3) has no time zone and rejects the "Z": store UTC as "YYYY-MM-DD HH:MM:SS.mmm"
  // (the driver reads it back as UTC). Elsewhere always the same ISO text, so SQLite's text
  // timestamps sort correctly as strings.
  return isMysqlFamily(dialect) ? `${iso.slice(0, 10)} ${iso.slice(11, 23)}` : iso
}

function dateToDatabase(table: string, column: ColumnDef, value: unknown): string {
  const text = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : value
  if (typeof text !== 'string' || !isCalendarDate(text)) throw new CastError(table, column.name, `expected a real date like 2026-11-14 (years ${YEARS.min}–${YEARS.max}), got ${describe(value)}`)
  return text
}

/** A timestamp string in the accepted shape, or `undefined`. Calendar fields must round-trip. */
function parseTimestamp(text: string): Date | undefined {
  const match = TIMESTAMP_TEXT.exec(text)
  if (match === null || !isCalendarDate(text.slice(0, 10))) return undefined
  // 24:00 and 23:60 are not times of day (Date would roll them into the next day or hour).
  if (Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59 || Number(match[6] ?? 0) > 59) return undefined
  const date = new Date(text.length === 10 ? `${text}T00:00:00.000Z` : text)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** `YYYY-MM-DD` that exists on the calendar (no 2026-02-30) within the portable years. */
function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text && inYearRange(date)
}

function inYearRange(date: Date): boolean {
  const year = date.getUTCFullYear()
  return year >= YEARS.min && year <= YEARS.max
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * Canonical decimal text with exactly `scale` decimals (`10.5` → `"10.50"`). Values with more
 * decimals than the column holds are rejected, never silently rounded. A number here is only ever
 * a value *read* from SQLite (a float holding a stored decimal), so formatting it to the scale is
 * exact; numbers written by app code are turned into text before they get here.
 */
function canonicalDecimal(raw: unknown, scale: number, invalid?: () => Error): string {
  // SQLite hands decimals back as floating-point numbers: format them to the column's scale.
  const source = typeof raw === 'number' ? raw.toFixed(scale) : String(raw).trim()
  const match = DECIMAL.exec(source)
  const fraction = match?.[3] ?? ''
  if (match === null || fraction.replace(/0+$/, '').length > scale) {
    throw invalid === undefined ? new TypeError(`"${source}" is not a decimal`) : invalid()
  }
  const sign = match[1] === '-' && /[1-9]/.test(`${match[2]}${fraction}`) ? '-' : ''
  const integer = (match[2] ?? '0').replace(/^0+(?=\d)/, '')
  return scale === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction.slice(0, scale).padEnd(scale, '0')}`
}

function toSafeInteger(raw: unknown, column: ColumnDef): number {
  const number = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isSafeInteger(number)) {
    throw new TypeError(`${column.name} holds ${String(raw)}, which is beyond JavaScript's safe integer range. Use a bigint cast for this column.`)
  }
  return number
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Date) return 'a Date'
  if (Array.isArray(value)) return 'a list'
  return typeof value === 'object' && value !== null ? 'an object' : String(value)
}
