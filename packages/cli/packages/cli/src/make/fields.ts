/**
 * The field mini-language used by `sv make:model` (docs/09 §3.1):
 *
 * ```
 * name:type[(args)][:modifier[(args)]]…
 *
 * title:string(200):required:searchable
 * amount:decimal(12,2):min(0):sortable
 * status:enum(draft,sent,paid):default(draft):filterable
 * customer:belongsTo(Customer)
 * label:string:label("Due date, local")      # quote args containing , ( ) : or spaces
 * ```
 *
 * Design rules:
 * - **Precise errors.** Every error has a stable `code` and the 1-based column where the problem
 *   starts, so the CLI can underline it. Parsing stops at the first syntax error; semantic checks
 *   (unknown type, bad arguments, default not in the enum…) run on a well-formed spec.
 * - **Round-trip.** {@link formatFieldSpec} prints a canonical spelling that parses back to the
 *   same {@link FieldSpec} (property-tested), so tools can rewrite field lists safely.
 * - **Never executes anything.** Arguments are data; they are validated against the catalogue and
 *   rendered into generated code only through quoting helpers.
 *
 * The catalogue mirrors the `field.*` builders in docs/05 §4.3.
 *
 * @module
 */
import { suggest } from '../framework/router.ts'

/** One parsed field. */
export interface FieldSpec {
  readonly name: string
  readonly type: string
  readonly typeArgs: readonly string[]
  readonly modifiers: readonly FieldModifier[]
}

/** One modifier, e.g. `default(draft)`. */
export interface FieldModifier {
  readonly name: string
  readonly args: readonly string[]
}

/** Stable error codes for field specs. */
export type FieldErrorCode =
  | 'EMPTY_SPEC'
  | 'INVALID_NAME'
  | 'RESERVED_NAME'
  | 'MISSING_TYPE'
  | 'EMPTY_SEGMENT'
  | 'UNEXPECTED_CHARACTER'
  | 'UNCLOSED_PARENTHESIS'
  | 'UNTERMINATED_QUOTE'
  | 'EMPTY_ARGUMENT'
  | 'UNKNOWN_TYPE'
  | 'UNKNOWN_MODIFIER'
  | 'WRONG_ARGUMENT_COUNT'
  | 'INVALID_ARGUMENT'
  | 'DUPLICATE_MODIFIER'
  | 'CONFLICTING_MODIFIERS'
  | 'MODIFIER_NOT_APPLICABLE'
  | 'INVALID_DEFAULT'
  | 'DUPLICATE_FIELD'

/** A field spec could not be parsed or is invalid. */
export class FieldSpecError extends Error {
  readonly code: FieldErrorCode
  /** 1-based column of the problem in the spec. */
  readonly column: number
  readonly spec: string

  constructor(code: FieldErrorCode, message: string, spec: string, column: number) {
    super(message)
    this.name = 'FieldSpecError'
    this.code = code
    this.spec = spec
    this.column = column
  }
}

/** How a type or modifier argument is checked. */
type ArgKind =
  | 'length'
  | 'integer'
  | 'number'
  | 'model'
  | 'identifier'
  | 'option'
  | 'currency'
  | 'text'
  | 'regex'
  | 'version'
  | 'permission'
  | 'value'

/** The broad family of a type: decides which modifiers and defaults make sense. */
export type FieldCategory =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'choice'
  | 'temporal'
  | 'identifier'
  | 'structured'
  | 'relation'
  | 'collection-relation'
  | 'file'
  | 'computed'

interface Arity {
  readonly min: number
  readonly max: number
  readonly kind: ArgKind
  /** Kind for the 2nd and later arguments, when it differs. */
  readonly restKind?: ArgKind
}

interface TypeInfo {
  readonly category: FieldCategory
  readonly args: Arity
}

const none: Arity = { min: 0, max: 0, kind: 'text' }
const t = (category: FieldCategory, args: Arity = none): TypeInfo => ({ category, args })

/** Every field type (docs/05 §4.3) with its accepted arguments. */
export const FIELD_TYPES: Readonly<Record<string, TypeInfo>> = Object.freeze({
  string: t('string', { min: 0, max: 1, kind: 'length' }),
  text: t('string'),
  email: t('string'),
  url: t('string'),
  phone: t('string'),
  slug: t('string', { min: 0, max: 1, kind: 'identifier' }),
  password: t('string'),
  richText: t('string'),
  markdown: t('string'),
  color: t('string'),
  integer: t('integer'),
  bigInteger: t('integer'),
  decimal: t('number', { min: 0, max: 2, kind: 'length', restKind: 'integer' }),
  float: t('number'),
  money: t('number', { min: 0, max: 1, kind: 'currency' }),
  percent: t('number'),
  boolean: t('boolean'),
  enum: t('choice', { min: 1, max: 100, kind: 'option' }),
  set: t('choice', { min: 1, max: 100, kind: 'option' }),
  date: t('temporal'),
  time: t('temporal'),
  datetime: t('temporal'),
  timestamp: t('temporal'),
  duration: t('temporal'),
  id: t('identifier'),
  uuid: t('identifier'),
  ulid: t('identifier'),
  json: t('structured'),
  array: t('structured', { min: 0, max: 1, kind: 'identifier' }),
  address: t('structured'),
  geoPoint: t('structured'),
  belongsTo: t('relation', { min: 1, max: 1, kind: 'model' }),
  hasOne: t('collection-relation', { min: 1, max: 1, kind: 'model' }),
  hasMany: t('collection-relation', { min: 1, max: 1, kind: 'model' }),
  manyToMany: t('collection-relation', { min: 1, max: 2, kind: 'model' }),
  morphTo: t('relation', { min: 0, max: 1, kind: 'identifier' }),
  morphMany: t('collection-relation', { min: 1, max: 2, kind: 'model', restKind: 'identifier' }),
  file: t('file'),
  image: t('file'),
  files: t('file'),
  computed: t('computed'),
})

interface ModifierInfo {
  readonly args: Arity
  /** Categories the modifier applies to (`undefined` = all column-backed types). */
  readonly only?: readonly FieldCategory[]
}

const m = (args: Arity = none, only?: readonly FieldCategory[]): ModifierInfo =>
  only === undefined ? { args } : { args, only }
const NUMERIC_OR_STRING: readonly FieldCategory[] = ['integer', 'number', 'string']

/** Every modifier with its accepted arguments and applicable type families. */
export const FIELD_MODIFIERS: Readonly<Record<string, ModifierInfo>> = Object.freeze({
  required: m(),
  optional: m(),
  nullable: m(),
  unique: m(),
  index: m(),
  default: m({ min: 1, max: 100, kind: 'value' }),
  min: m({ min: 1, max: 1, kind: 'number' }, NUMERIC_OR_STRING),
  max: m({ min: 1, max: 1, kind: 'number' }, NUMERIC_OR_STRING),
  length: m({ min: 1, max: 2, kind: 'integer' }, ['string']),
  regex: m({ min: 1, max: 1, kind: 'regex' }, ['string']),
  searchable: m(none, ['string', 'choice', 'identifier']),
  filterable: m(),
  sortable: m(),
  hidden: m(),
  readOnly: m(),
  writeOnce: m(),
  sensitive: m(),
  label: m({ min: 1, max: 1, kind: 'text' }),
  help: m({ min: 1, max: 1, kind: 'text' }),
  placeholder: m({ min: 1, max: 1, kind: 'text' }),
  widget: m({ min: 1, max: 1, kind: 'identifier' }),
  since: m({ min: 1, max: 1, kind: 'version' }),
  deprecated: m({ min: 0, max: 1, kind: 'text' }),
  permission: m({ min: 1, max: 1, kind: 'permission' }),
})

/** Modifiers that need a database column (not valid on hasMany/manyToMany/computed…). */
const COLUMN_MODIFIERS = new Set(['unique', 'index', 'default', 'nullable', 'sortable'])
const COLUMNLESS: ReadonlySet<FieldCategory> = new Set(['collection-relation', 'computed'])

/** Field names the framework adds itself. */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'tenantId',
  'version',
])

const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/
const HEAD_CHAR = /[A-Za-z0-9_]/

interface Located<T> {
  readonly value: T
  readonly column: number
}

interface RawSegment {
  readonly head: Located<string>
  readonly args: readonly Located<string>[] | undefined
}

/** Low-level scanner: splits a spec into `head(args)` segments with positions. */
function scan(spec: string): RawSegment[] {
  let i = 0
  const error = (code: FieldErrorCode, message: string, at: number): FieldSpecError =>
    new FieldSpecError(code, message, spec, at + 1)

  const readArgs = (open: number): Located<string>[] => {
    const args: Located<string>[] = []
    const skipSpaces = (): void => {
      while (spec[i] === ' ' || spec[i] === '\t') i++
    }
    skipSpaces()
    if (spec[i] === ')') return args
    for (;;) {
      skipSpaces()
      const start = i
      const ch = spec[i]
      let value: string
      if (ch === '"' || ch === "'") {
        i++
        let out = ''
        for (;;) {
          if (i >= spec.length)
            throw error('UNTERMINATED_QUOTE', `Unterminated ${ch} quote.`, start)
          const c = spec[i] ?? ''
          if (c === '\\' && i + 1 < spec.length) {
            out += spec[i + 1] ?? ''
            i += 2
            continue
          }
          if (c === ch) {
            i++
            break
          }
          out += c
          i++
        }
        value = out
      } else {
        while (i < spec.length && spec[i] !== ',' && spec[i] !== ')') {
          const c = spec[i] ?? ''
          if (c === '(' || c === '"' || c === "'") {
            throw error(
              'UNEXPECTED_CHARACTER',
              `Unexpected "${c}" in an argument; quote arguments that contain it.`,
              i,
            )
          }
          i++
        }
        value = spec.slice(start, i).trim()
        if (value === '' && i >= spec.length) {
          throw error('UNCLOSED_PARENTHESIS', 'Missing ")".', open)
        }
        if (value === '') throw error('EMPTY_ARGUMENT', 'Empty argument.', start)
      }
      args.push({ value, column: start + 1 })
      skipSpaces()
      if (i >= spec.length) throw error('UNCLOSED_PARENTHESIS', 'Missing ")".', open)
      if (spec[i] === ',') {
        i++
        continue
      }
      if (spec[i] === ')') return args
      throw error('UNEXPECTED_CHARACTER', `Unexpected "${spec[i]}" after an argument.`, i)
    }
  }

  const segments: RawSegment[] = []
  for (;;) {
    const start = i
    while (i < spec.length && HEAD_CHAR.test(spec[i] ?? '')) i++
    const head = spec.slice(start, i)
    if (head === '') {
      if (i >= spec.length || spec[i] === ':') {
        throw error('EMPTY_SEGMENT', 'Empty part between colons.', start)
      }
      throw error('UNEXPECTED_CHARACTER', `Unexpected "${spec[i]}".`, i)
    }
    let args: Located<string>[] | undefined
    if (spec[i] === '(') {
      const open = i
      i++
      args = readArgs(open)
      i++ // the closing parenthesis
    }
    segments.push({ head: { value: head, column: start + 1 }, args })
    if (i >= spec.length) return segments
    if (spec[i] !== ':') throw error('UNEXPECTED_CHARACTER', `Unexpected "${spec[i]}".`, i)
    i++
    if (i >= spec.length) throw error('EMPTY_SEGMENT', 'Nothing after the last ":".', i - 1)
  }
}

const KIND_PATTERNS: Readonly<Record<Exclude<ArgKind, 'regex' | 'text' | 'value'>, RegExp>> = {
  length: /^[1-9]\d{0,4}$/,
  integer: /^(0|[1-9]\d{0,4})$/,
  number: /^-?(0|[1-9]\d*)(\.\d+)?$/,
  model: /^[A-Z][A-Za-z0-9]*$/,
  identifier: /^[A-Za-z][A-Za-z0-9_]*$/,
  option: /^[A-Za-z0-9_][A-Za-z0-9_-]*$/,
  currency: /^[A-Z]{3}$/,
  version: /^(\d+\.\d+(\.\d+)?|\d{4}-\d{2}-\d{2})$/,
  permission: /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/,
}

const KIND_LABEL: Readonly<Record<ArgKind, string>> = {
  length: 'a positive whole number',
  integer: 'a whole number',
  number: 'a number',
  model: 'a PascalCase model name',
  identifier: 'an identifier',
  option: 'a value of letters, digits, "_" or "-"',
  currency: 'a three-letter currency code like EUR',
  text: 'text',
  regex: 'a valid regular expression',
  version: 'a version like 1.2 or a date like 2026-01-31',
  permission: 'a permission like "invoice.approve"',
  value: 'a value',
}

function checkKind(kind: ArgKind, value: string): boolean {
  if (kind === 'text' || kind === 'value') return value.length > 0 || kind === 'text'
  if (kind === 'regex') {
    try {
      new RegExp(value)
      return true
    } catch {
      return false
    }
  }
  return KIND_PATTERNS[kind].test(value)
}

function checkArity(
  spec: string,
  what: string,
  arity: Arity,
  args: readonly Located<string>[],
  column: number,
): void {
  if (args.length < arity.min || args.length > arity.max) {
    const expected =
      arity.min === arity.max
        ? `${arity.min}`
        : arity.max >= 100
          ? `at least ${arity.min}`
          : `${arity.min} to ${arity.max}`
    throw new FieldSpecError(
      'WRONG_ARGUMENT_COUNT',
      `${what} takes ${expected} argument(s), got ${args.length}.`,
      spec,
      column,
    )
  }
  args.forEach((arg, index) => {
    const kind = index > 0 && arity.restKind !== undefined ? arity.restKind : arity.kind
    if (!checkKind(kind, arg.value)) {
      throw new FieldSpecError(
        'INVALID_ARGUMENT',
        `${what}: "${arg.value}" is not ${KIND_LABEL[kind]}.`,
        spec,
        arg.column,
      )
    }
  })
}

/** Validate a `default(...)` value against the field's type. */
function checkDefault(
  spec: string,
  type: string,
  typeArgs: readonly string[],
  args: readonly Located<string>[],
  column: number,
): void {
  const info = FIELD_TYPES[type]
  const fail = (message: string, at = column): FieldSpecError =>
    new FieldSpecError('INVALID_DEFAULT', message, spec, at)
  if (info === undefined) return
  const multi = type === 'set'
  if (!multi && args.length !== 1) {
    throw new FieldSpecError('WRONG_ARGUMENT_COUNT', 'default takes 1 argument.', spec, column)
  }
  for (const arg of args) {
    switch (info.category) {
      case 'integer':
        if (!/^-?(0|[1-9]\d*)$/.test(arg.value))
          throw fail(`default "${arg.value}" is not a whole number.`, arg.column)
        break
      case 'number':
        if (!KIND_PATTERNS.number.test(arg.value))
          throw fail(`default "${arg.value}" is not a number.`, arg.column)
        break
      case 'boolean':
        if (arg.value !== 'true' && arg.value !== 'false')
          throw fail('default must be true or false.', arg.column)
        break
      case 'choice':
        if (!typeArgs.includes(arg.value)) {
          throw fail(`default "${arg.value}" is not one of: ${typeArgs.join(', ')}.`, arg.column)
        }
        break
      case 'temporal':
        if (
          arg.value !== 'now' &&
          !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$|^\d{2}:\d{2}(:\d{2})?$|^P[\dYMWDTHS]+$/.test(
            arg.value,
          )
        ) {
          throw fail(`default "${arg.value}" must be "now" or an ISO date/time.`, arg.column)
        }
        break
      case 'string':
      case 'identifier':
        break
      default:
        throw new FieldSpecError(
          'MODIFIER_NOT_APPLICABLE',
          `${type} fields cannot have a default.`,
          spec,
          column,
        )
    }
  }
}

/**
 * Parse and validate one field spec. Throws {@link FieldSpecError} with a stable code and the
 * column of the problem.
 */
export function parseFieldSpec(spec: string): FieldSpec {
  if (spec.trim() === '')
    throw new FieldSpecError('EMPTY_SPEC', 'The field spec is empty.', spec, 1)
  const segments = scan(spec)
  const [nameSeg, typeSeg, ...modifierSegs] = segments
  if (nameSeg === undefined)
    throw new FieldSpecError('EMPTY_SPEC', 'The field spec is empty.', spec, 1)
  const name = nameSeg.head.value
  if (nameSeg.args !== undefined || !FIELD_NAME.test(name)) {
    throw new FieldSpecError(
      'INVALID_NAME',
      `Field name "${name}" must be lower camelCase (e.g. "dueDate").`,
      spec,
      nameSeg.head.column,
    )
  }
  if (RESERVED_FIELD_NAMES.has(name)) {
    throw new FieldSpecError(
      'RESERVED_NAME',
      `"${name}" is added by the framework; choose another name.`,
      spec,
      nameSeg.head.column,
    )
  }
  if (typeSeg === undefined) {
    throw new FieldSpecError(
      'MISSING_TYPE',
      `Field "${name}" needs a type, e.g. "${name}:string".`,
      spec,
      spec.length + 1,
    )
  }
  const type = typeSeg.head.value
  const info = FIELD_TYPES[type]
  if (info === undefined) {
    const close = suggest(type, Object.keys(FIELD_TYPES))
    throw new FieldSpecError(
      'UNKNOWN_TYPE',
      `Unknown field type "${type}".${close.length > 0 ? ` Did you mean ${close.join(', ')}?` : ''}`,
      spec,
      typeSeg.head.column,
    )
  }
  const typeArgs = typeSeg.args ?? []
  checkArity(spec, type, info.args, typeArgs, typeSeg.head.column)
  const typeValues = typeArgs.map((a) => a.value)
  if (info.category === 'choice' && new Set(typeValues).size !== typeValues.length) {
    throw new FieldSpecError(
      'INVALID_ARGUMENT',
      `${type} values must be unique.`,
      spec,
      typeSeg.head.column,
    )
  }
  if (type === 'decimal' && typeValues.length === 1) {
    throw new FieldSpecError(
      'WRONG_ARGUMENT_COUNT',
      'decimal takes 0 or 2 arguments (precision, scale).',
      spec,
      typeSeg.head.column,
    )
  }
  if (type === 'decimal' && typeValues.length === 2) {
    const [precision = 0, scale = 0] = typeValues.map(Number)
    if (precision > 65 || scale > precision) {
      throw new FieldSpecError(
        'INVALID_ARGUMENT',
        `decimal(${precision},${scale}): precision must be 1-65 and scale at most the precision.`,
        spec,
        typeSeg.head.column,
      )
    }
  }

  const seen = new Set<string>()
  const modifiers: FieldModifier[] = []
  for (const seg of modifierSegs) {
    const modifier = seg.head.value
    const mod = FIELD_MODIFIERS[modifier]
    if (mod === undefined) {
      const close = suggest(modifier, Object.keys(FIELD_MODIFIERS))
      throw new FieldSpecError(
        'UNKNOWN_MODIFIER',
        `Unknown modifier "${modifier}".${close.length > 0 ? ` Did you mean ${close.join(', ')}?` : ''}`,
        spec,
        seg.head.column,
      )
    }
    if (seen.has(modifier)) {
      throw new FieldSpecError(
        'DUPLICATE_MODIFIER',
        `"${modifier}" is given twice.`,
        spec,
        seg.head.column,
      )
    }
    seen.add(modifier)
    const columnless =
      COLUMNLESS.has(info.category) && (COLUMN_MODIFIERS.has(modifier) || mod.only !== undefined)
    if (columnless || (mod.only !== undefined && !mod.only.includes(info.category))) {
      throw new FieldSpecError(
        'MODIFIER_NOT_APPLICABLE',
        `"${modifier}" does not apply to ${type} fields.`,
        spec,
        seg.head.column,
      )
    }
    const args = seg.args ?? []
    if (modifier === 'default') checkDefault(spec, type, typeValues, args, seg.head.column)
    else checkArity(spec, modifier, mod.args, args, seg.head.column)
    if (modifier === 'min' || modifier === 'max') {
      const value = Number(args[0]?.value)
      if (
        info.category !== 'number' &&
        info.category !== 'integer' &&
        !(Number.isInteger(value) && value >= 0)
      ) {
        throw new FieldSpecError(
          'INVALID_ARGUMENT',
          `${modifier} on a ${type} field is a length: use a whole number of characters.`,
          spec,
          args[0]?.column ?? seg.head.column,
        )
      }
    }
    modifiers.push({ name: modifier, args: args.map((a) => a.value) })
  }

  if (seen.has('required') && seen.has('optional')) {
    throw new FieldSpecError(
      'CONFLICTING_MODIFIERS',
      '"required" and "optional" cannot both be set.',
      spec,
      modifierSegs.find((s) => s.head.value === 'optional')?.head.column ?? 1,
    )
  }
  const min = modifiers.find((x) => x.name === 'min')?.args[0]
  const max = modifiers.find((x) => x.name === 'max')?.args[0]
  if (min !== undefined && max !== undefined && Number(min) > Number(max)) {
    throw new FieldSpecError(
      'CONFLICTING_MODIFIERS',
      `min (${min}) is greater than max (${max}).`,
      spec,
      modifierSegs.find((s) => s.head.value === 'max')?.head.column ?? 1,
    )
  }
  return { name, type, typeArgs: typeValues, modifiers }
}

/** Parse several specs and reject duplicate field names. */
export function parseFieldSpecs(specs: readonly string[]): FieldSpec[] {
  const fields: FieldSpec[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    const field = parseFieldSpec(spec)
    if (seen.has(field.name)) {
      throw new FieldSpecError(
        'DUPLICATE_FIELD',
        `Field "${field.name}" is defined twice.`,
        spec,
        1,
      )
    }
    seen.add(field.name)
    fields.push(field)
  }
  return fields
}

/** Arguments that can be written without quotes and parse back unchanged. */
const BARE_ARG = /^[A-Za-z0-9_.+-]+$/

/** Print one argument, quoting it when needed. */
export function formatArg(value: string): string {
  return BARE_ARG.test(value) ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const formatArgs = (args: readonly string[]): string =>
  args.length === 0 ? '' : `(${args.map(formatArg).join(',')})`

/** The canonical spelling of a field spec (parses back to an equal {@link FieldSpec}). */
export function formatFieldSpec(field: FieldSpec): string {
  return [
    field.name,
    `${field.type}${formatArgs(field.typeArgs)}`,
    ...field.modifiers.map((mod) => `${mod.name}${formatArgs(mod.args)}`),
  ].join(':')
}

/** The category of a field's type. */
export function categoryOf(field: FieldSpec): FieldCategory {
  return FIELD_TYPES[field.type]?.category ?? 'string'
}
