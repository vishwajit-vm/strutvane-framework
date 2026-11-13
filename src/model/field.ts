/**
 * Field builders: `field.string()`, `field.decimal(12, 2)`, `field.belongsTo('Customer')`, …
 *
 * A builder produces a {@link FieldDef}: plain, JSON-serialisable data with no functions. That is
 * what makes a model diffable (migrations), storable (snapshots) and readable by every other layer.
 * Builders are immutable: every modifier returns a new builder, so a shared base field can never be
 * changed by accident.
 *
 * The generic parameters carry the field's TypeScript type into model inference:
 * `T` value type, `R` required (non-null), `D` has a default (optional on create),
 * `W` writable through the API (false for `readOnly`).
 *
 * @module
 */
import type { FilterOperator } from '@strutvane/contracts'

/** Every field kind. `hasMany` is a relation, not a column (see {@link HasManyBuilder}). */
export type FieldKind =
  | 'string'
  | 'text'
  | 'email'
  | 'url'
  | 'uuid'
  | 'integer'
  | 'bigInteger'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'datetime'
  | 'json'
  | 'belongsTo'

/** A literal default value (stored in the database schema). */
export type DefaultValue = string | number | boolean

/** A serialisable regular expression. */
export interface PatternDef {
  readonly source: string
  readonly flags: string
}

/** The fully-resolved, plain-data description of one field. */
export interface FieldDef {
  readonly kind: FieldKind
  /** NOT NULL. Fields are required unless `.optional()` / `.nullable()` is called. */
  readonly required: boolean
  readonly unique: boolean
  readonly index: boolean
  readonly default?: DefaultValue
  /** Numbers: smallest allowed value. Text: minimum length. */
  readonly min?: number
  /** Numbers: largest allowed value. Text: maximum length. */
  readonly max?: number
  /** `string`: column length (varchar). */
  readonly length?: number
  readonly precision?: number
  readonly scale?: number
  /** `enum`: allowed values, in order. */
  readonly values?: readonly string[]
  /** `belongsTo`: target model name. */
  readonly target?: string
  readonly pattern?: PatternDef
  /** Operators allowed in list filters. Empty = not filterable (the default). */
  readonly filterOperators: readonly FilterOperator[]
  readonly sortable: boolean
  readonly searchable: boolean
  /** Never returned by the API. */
  readonly hidden: boolean
  /** Returned but never writable through the API. */
  readonly readOnly: boolean
  /** Settable on create, never changeable afterwards. */
  readonly writeOnce: boolean
  /** Redacted in logs and audit diffs. */
  readonly sensitive: boolean
  readonly label?: string
  readonly help?: string
}

/** Operators that make sense per kind; `filterable()` with no arguments enables all of them. */
const OPERATORS_BY_KIND: Readonly<Record<FieldKind, readonly FilterOperator[]>> = {
  string: ['eq', 'ne', 'in', 'nin', 'isNull', 'isNotNull', 'contains', 'startsWith', 'endsWith'],
  text: ['isNull', 'isNotNull', 'contains', 'startsWith', 'endsWith'],
  email: ['eq', 'ne', 'in', 'nin', 'isNull', 'isNotNull', 'contains', 'startsWith', 'endsWith'],
  url: ['eq', 'ne', 'isNull', 'isNotNull', 'contains', 'startsWith', 'endsWith'],
  uuid: ['eq', 'ne', 'in', 'nin', 'isNull', 'isNotNull'],
  integer: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between', 'isNull', 'isNotNull'],
  bigInteger: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between', 'isNull', 'isNotNull'],
  decimal: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
  float: ['gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
  boolean: ['eq', 'ne', 'isNull', 'isNotNull'],
  enum: ['eq', 'ne', 'in', 'nin', 'isNull', 'isNotNull'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
  datetime: ['gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
  json: ['isNull', 'isNotNull'],
  belongsTo: ['eq', 'ne', 'in', 'nin', 'isNull', 'isNotNull'],
}

/** The operators a field kind supports (used to validate `filterable(...)` and list queries). */
export function operatorsFor(kind: FieldKind): readonly FilterOperator[] {
  return OPERATORS_BY_KIND[kind]
}

/** Kinds whose values are text (min/max apply to length). */
const TEXT_KINDS: ReadonlySet<FieldKind> = new Set(['string', 'text', 'email', 'url'])
/** Kinds whose values are numbers (min/max apply to the value). */
const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set(['integer', 'bigInteger', 'decimal', 'float'])

/** Whether min/max constrain the value (numbers) rather than the length (text). */
export function isNumericKind(kind: FieldKind): boolean {
  return NUMERIC_KINDS.has(kind)
}

/** Whether min/max constrain the length. */
export function isTextKind(kind: FieldKind): boolean {
  return TEXT_KINDS.has(kind)
}

/** A column field builder. See the module docs for the meaning of the type parameters. */
export class FieldBuilder<
  T,
  R extends boolean = true,
  D extends boolean = false,
  W extends boolean = true,
> {
  /** The resolved field definition. */
  readonly def: FieldDef
  /** @internal phantom types for inference; never set at runtime. */
  declare readonly __types?: { value: T; required: R; hasDefault: D; writable: W }

  constructor(def: FieldDef) {
    this.def = Object.freeze({ ...def })
  }

  private with<NR extends boolean = R, ND extends boolean = D, NW extends boolean = W>(
    patch: Partial<FieldDef>,
  ): FieldBuilder<T, NR, ND, NW> {
    return new FieldBuilder<T, NR, ND, NW>({ ...this.def, ...patch })
  }

  /** NOT NULL (the default). */
  required(): FieldBuilder<T, true, D, W> {
    return this.with<true>({ required: true })
  }

  /** May be missing / null. */
  optional(): FieldBuilder<T, false, D, W> {
    return this.with<false>({ required: false })
  }

  /** Alias of {@link FieldBuilder.optional}. */
  nullable(): FieldBuilder<T, false, D, W> {
    return this.optional()
  }

  /** Unique (per tenant on tenant-scoped models). */
  unique(): FieldBuilder<T, R, D, W> {
    return this.with({ unique: true })
  }

  /** Add a database index. */
  index(): FieldBuilder<T, R, D, W> {
    return this.with({ index: true })
  }

  /** A default value, stored in the schema. Makes the field optional on create. */
  default(value: T & DefaultValue): FieldBuilder<T, R, true, W> {
    if (
      this.def.kind === 'enum' &&
      (typeof value !== 'string' || !this.def.values?.includes(value))
    ) {
      throw new TypeError(
        `default("${String(value)}") is not one of the enum values [${this.def.values?.join(', ')}]`,
      )
    }
    if (this.def.kind === 'json' || this.def.kind === 'belongsTo') {
      throw new TypeError(`${this.def.kind} fields cannot have a schema default`)
    }
    return this.with<R, true>({ default: value })
  }

  /** Numbers: minimum value. Text: minimum length. */
  min(value: number): FieldBuilder<T, R, D, W> {
    return this.bound('min', value)
  }

  /** Numbers: maximum value. Text: maximum length. */
  max(value: number): FieldBuilder<T, R, D, W> {
    return this.bound('max', value)
  }

  /** Text must match a regular expression. */
  regex(pattern: RegExp): FieldBuilder<T, R, D, W> {
    if (!isTextKind(this.def.kind))
      throw new TypeError(`regex() is only for text fields, not ${this.def.kind}`)
    return this.with({ pattern: { source: pattern.source, flags: pattern.flags.replace('g', '') } })
  }

  /** Include in free-text search (`?search=`). Text fields only. */
  searchable(): FieldBuilder<T, R, D, W> {
    if (!isTextKind(this.def.kind))
      throw new TypeError(`searchable() is only for text fields, not ${this.def.kind}`)
    return this.with({ searchable: true })
  }

  /**
   * Allow filtering. With no arguments, every operator that suits the kind is allowed; pass a list
   * to restrict it. Unsupported operators are rejected here, not at request time.
   */
  filterable(...operators: FilterOperator[]): FieldBuilder<T, R, D, W> {
    const supported = operatorsFor(this.def.kind)
    const chosen = operators.length > 0 ? operators : supported
    const bad = chosen.filter((op) => !supported.includes(op))
    if (bad.length > 0) {
      throw new TypeError(
        `${this.def.kind} fields don't support filter operator(s): ${bad.join(', ')}`,
      )
    }
    return this.with({ filterOperators: [...new Set(chosen)] })
  }

  /** Allow sorting by this field. */
  sortable(): FieldBuilder<T, R, D, W> {
    if (this.def.kind === 'json' || this.def.kind === 'text') {
      throw new TypeError(`${this.def.kind} fields cannot be sortable`)
    }
    return this.with({ sortable: true })
  }

  /** Never returned by the API (e.g. internal flags). */
  hidden(): FieldBuilder<T, R, D, W> {
    return this.with({ hidden: true })
  }

  /** Returned but never writable through the API. */
  readOnly(): FieldBuilder<T, R, D, false> {
    return this.with<R, D, false>({ readOnly: true })
  }

  /** Settable on create, never changeable afterwards. */
  writeOnce(): FieldBuilder<T, R, D, W> {
    return this.with({ writeOnce: true })
  }

  /** Redacted in logs and audit diffs. */
  sensitive(): FieldBuilder<T, R, D, W> {
    return this.with({ sensitive: true })
  }

  /** Human label shown in the UI and messages (default: derived from the key). */
  label(text: string): FieldBuilder<T, R, D, W> {
    return this.with({ label: nonEmpty('label', text) })
  }

  /** Help text shown under form inputs. */
  help(text: string): FieldBuilder<T, R, D, W> {
    return this.with({ help: nonEmpty('help', text) })
  }

  private bound(which: 'min' | 'max', value: number): FieldBuilder<T, R, D, W> {
    const kind = this.def.kind
    if (!isNumericKind(kind) && !isTextKind(kind))
      throw new TypeError(`${which}() is not supported on ${kind} fields`)
    if (!Number.isFinite(value)) throw new RangeError(`${which}() needs a finite number`)
    if (isTextKind(kind) && (!Number.isInteger(value) || value < 0)) {
      throw new RangeError(`${which}() on text fields is a length: a non-negative integer`)
    }
    const next = { ...this.def, [which]: value }
    if (next.min !== undefined && next.max !== undefined && next.min > next.max) {
      throw new RangeError(`min (${next.min}) cannot be greater than max (${next.max})`)
    }
    if (kind === 'string' && which === 'max' && value > (this.def.length ?? 255)) {
      throw new RangeError(`max(${value}) exceeds the column length (${this.def.length ?? 255})`)
    }
    return new FieldBuilder<T, R, D, W>(next)
  }
}

/** A to-many relation (not a column). Used for includes and the manifest. */
export class HasManyBuilder {
  readonly kind = 'hasMany' as const
  readonly target: string
  readonly foreignKey: string | undefined
  constructor(target: string, foreignKey?: string) {
    this.target = target
    this.foreignKey = foreignKey
  }
}

/** Any column builder. */
// biome-ignore lint/suspicious/noExplicitAny: the generic parameters are erased for storage.
export type AnyFieldBuilder = FieldBuilder<any, boolean, boolean, boolean>

function nonEmpty(name: string, text: string): string {
  if (text.trim().length === 0) throw new TypeError(`${name}() needs a non-empty string`)
  return text
}

const base = <T>(kind: FieldKind, extra: Partial<FieldDef> = {}): FieldBuilder<T> =>
  new FieldBuilder<T>({
    kind,
    required: true,
    unique: false,
    index: false,
    filterOperators: [],
    sortable: false,
    searchable: false,
    hidden: false,
    readOnly: false,
    writeOnce: false,
    sensitive: false,
    ...extra,
  })

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`)
  return value
}

/** Field builders. */
export const field = {
  /** Short text (varchar). Default length 255. */
  string: (length: number = 255): FieldBuilder<string> =>
    base<string>('string', { length: positiveInt('length', length) }),
  /** Long text. */
  text: (): FieldBuilder<string> => base<string>('text'),
  /** An email address (validated). */
  email: (): FieldBuilder<string> => base<string>('email', { length: 320 }),
  /** An absolute http(s) URL (validated). */
  url: (): FieldBuilder<string> => base<string>('url', { length: 2048 }),
  /** A UUID value (not a relation). */
  uuid: (): FieldBuilder<string> => base<string>('uuid'),
  /** A 32-bit integer. */
  integer: (): FieldBuilder<number> => base<number>('integer'),
  /** A 64-bit integer, exchanged as a decimal string to keep precision. */
  bigInteger: (): FieldBuilder<string> => base<string>('bigInteger'),
  /** An exact decimal, exchanged as a string (e.g. `"1250.50"`) to keep precision. */
  decimal: (precision: number = 12, scale: number = 2): FieldBuilder<string> => {
    positiveInt('precision', precision)
    if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
      throw new RangeError('decimal(precision, scale) needs 0 <= scale <= precision')
    }
    return base<string>('decimal', { precision, scale })
  },
  /** A floating-point number (not exact; use decimal for money). */
  float: (): FieldBuilder<number> => base<number>('float'),
  boolean: (): FieldBuilder<boolean> => base<boolean>('boolean'),
  /** One of a fixed list of values. Stored as text with a CHECK constraint (ADR-0009). */
  enum: <const V extends readonly [string, ...string[]]>(values: V): FieldBuilder<V[number]> => {
    if (new Set(values).size !== values.length) throw new RangeError('enum values must be unique')
    if (values.some((v) => v.length === 0 || v.length > 64))
      throw new RangeError('enum values must be 1-64 characters')
    return base<V[number]>('enum', { values: [...values] })
  },
  /** A calendar date, exchanged as `YYYY-MM-DD`. */
  date: (): FieldBuilder<string> => base<string>('date'),
  /** A point in time, exchanged as an ISO-8601 UTC string. */
  datetime: (): FieldBuilder<string> => base<string>('datetime'),
  /** Arbitrary JSON (objects/arrays). */
  json: <T = unknown>(): FieldBuilder<T> => base<T>('json'),
  /** A foreign key to another model; the value is the related record's id. */
  belongsTo: (target: string): FieldBuilder<string> => {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(target))
      throw new TypeError(`belongsTo("${target}") needs a PascalCase model name`)
    return base<string>('belongsTo', { target })
  },
  /** A to-many relation (not a column), e.g. an invoice's lines. */
  hasMany: (target: string, foreignKey?: string): HasManyBuilder => {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(target))
      throw new TypeError(`hasMany("${target}") needs a PascalCase model name`)
    return new HasManyBuilder(target, foreignKey)
  },
} as const
