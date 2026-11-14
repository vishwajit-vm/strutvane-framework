/**
 * Validation derived from a model: one definition → `create`, `update` and `read` Zod schemas, plus
 * the translation of Zod issues into RFC-0003 issue codes (`required`, `too_small`, `invalid_email`…)
 * that the message catalogs render.
 *
 * Rules (each one prevents a class of bugs):
 * - `create`/`update` are **strict**: unknown keys are rejected (`unknown_field`), never ignored.
 * - `readOnly` fields are never writable; `writeOnce` fields are writable on create only.
 * - `hidden` fields never appear in `read` (the API response) and are never writable either:
 *   set them in hooks or through the repository.
 * - Decimals and big integers are strings, so no precision is ever lost in JSON.
 *
 * @module
 */

import { z } from 'zod'
import type { IssueInput } from '../core/index.ts'
import { columnName, type ModelDefinition } from './define-model.ts'
import { type FieldDef, isNumericKind, isTextKind } from './field.ts'

/** The three schemas derived from a model. */
export interface ModelSchemas {
  readonly create: z.ZodObject
  readonly update: z.ZodObject
  readonly read: z.ZodObject
}

/** Build the value schema for one field (no optional/nullable wrapping). */
export function valueSchema(def: FieldDef): z.ZodType {
  switch (def.kind) {
    case 'string':
    case 'text':
      return withTextBounds(z.string(), def)
    case 'email':
      return withTextBounds(z.email(), def)
    case 'url':
      return withTextBounds(z.url({ protocol: /^https?$/ }), def)
    case 'uuid':
    case 'belongsTo':
      return z.uuid()
    case 'integer':
      return withNumberBounds(z.int().min(-2147483648).max(2147483647), def)
    case 'float':
      return withNumberBounds(z.number(), def)
    case 'bigInteger':
      return withDecimalBounds(z.string().regex(/^-?(0|[1-9]\d{0,18})$/, 'invalid_format'), def)
    case 'decimal':
      return withDecimalBounds(decimalString(def.precision ?? 12, def.scale ?? 2), def)
    case 'boolean':
      return z.boolean()
    case 'enum':
      return z.enum((def.values ?? []) as [string, ...string[]])
    case 'date':
      return z.iso.date()
    case 'datetime':
      return z.iso.datetime({ offset: true })
    case 'json':
      return z.json()
  }
}

function withTextBounds(schema: z.ZodString | z.ZodEmail | z.ZodURL, def: FieldDef): z.ZodType {
  // NUL characters: PostgreSQL text cannot store them (the insert would fail as a 500).
  let s = (schema as z.ZodString).refine((v) => !v.includes(String.fromCharCode(0)), {
    message: 'invalid_format',
  })
  const max = def.max ?? def.length
  if (def.min !== undefined) s = s.min(def.min)
  if (max !== undefined) s = s.max(max)
  if (def.pattern) s = s.regex(new RegExp(def.pattern.source, def.pattern.flags))
  // A required text field needs real content: "" or only whitespace is as missing as null.
  if (def.required && (def.kind === 'string' || def.kind === 'text'))
    return s.refine((v) => v.trim() !== '', { message: 'required' })
  return s
}

function withNumberBounds(schema: z.ZodNumber, def: FieldDef): z.ZodType {
  let s = schema
  if (def.min !== undefined) s = s.min(def.min)
  if (def.max !== undefined) s = s.max(def.max)
  return s
}

/** An exact decimal as a string, limited to the column's precision and scale. */
function decimalString(precision: number, scale: number): z.ZodString {
  const intDigits = Math.max(precision - scale, 1)
  const fraction = scale > 0 ? `(\\.\\d{1,${scale}})?` : ''
  return z.string().regex(new RegExp(`^-?\\d{1,${intDigits}}${fraction}$`), 'invalid_decimal')
}

function withDecimalBounds(schema: z.ZodString, def: FieldDef): z.ZodType {
  if (def.min === undefined && def.max === undefined) return schema
  const { min, max } = def
  return schema.superRefine((value, ctx) => {
    const n = Number(value)
    if (min !== undefined && n < min) {
      ctx.addIssue({
        code: 'too_small',
        origin: 'number',
        minimum: min,
        inclusive: true,
        input: value,
      })
    }
    if (max !== undefined && n > max) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'number',
        maximum: max,
        inclusive: true,
        input: value,
      })
    }
  })
}

/** Build the create / update / read schemas for a model. */
export function modelSchemas(model: ModelDefinition): ModelSchemas {
  const createShape: Record<string, z.ZodType> = {}
  const updateShape: Record<string, z.ZodType> = {}
  const readShape: Record<string, z.ZodType> = { id: z.uuid() }

  for (const [key, def] of Object.entries(model.fields)) {
    const value = valueSchema(def)
    // Hidden fields are server-controlled (password hashes, internal flags): never writable
    // through the API, so a client sending one gets `unknown_field`, like any other unknown key.
    if (!def.readOnly && !def.hidden) {
      const optionalOnCreate = !def.required || def.default !== undefined
      createShape[key] = optionalOnCreate ? value.nullable().optional() : value
      if (!def.writeOnce) updateShape[key] = (def.required ? value : value.nullable()).optional()
    }
    if (!def.hidden) readShape[key] = def.required ? value : value.nullable()
  }
  if (model.options.timestamps) {
    Object.assign(readShape, {
      createdAt: z.iso.datetime({ offset: true }),
      updatedAt: z.iso.datetime({ offset: true }),
    })
  }
  if (model.options.softDeletes) {
    Object.assign(readShape, { deletedAt: z.iso.datetime({ offset: true }).nullable() })
  }

  return {
    create: z.strictObject(createShape),
    update: z.strictObject(updateShape),
    read: z.object(readShape),
  }
}

/** Field labels by key, including system fields, used as `{attribute}` in messages. */
export function modelLabels(model: ModelDefinition): Record<string, string> {
  const labels: Record<string, string> = {
    id: 'ID',
    createdAt: 'Created at',
    updatedAt: 'Updated at',
    deletedAt: 'Deleted at',
  }
  for (const [key, def] of Object.entries(model.fields)) labels[key] = def.label ?? key
  return labels
}

type ZodIssue = z.core.$ZodIssue

/** The value at a path in parsed input, or `undefined` when any step is missing. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = input
  for (const p of path) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, p)) return undefined
    cur = (cur as Record<PropertyKey, unknown>)[p]
  }
  return cur
}

/**
 * Translate Zod issues into RFC-0003 issue inputs (codes + params; the catalog renders messages).
 * `prefix` is prepended to every path (e.g. `['query']`). Pass the validated `input` so a
 * missing value (`required`) can be told apart from a wrongly typed one (`invalid_type`).
 */
export function issuesFromZod(
  issues: readonly ZodIssue[],
  prefix: readonly (string | number)[] = [],
  input?: unknown,
): IssueInput[] {
  const out: IssueInput[] = []
  for (const issue of issues) {
    const path = [...prefix, ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))]
    switch (issue.code) {
      case 'invalid_type': {
        const value = input === undefined ? issue.input : valueAt(input, issue.path)
        out.push({ path, code: value === undefined ? 'required' : 'invalid_type' })
        break
      }
      case 'too_small': {
        const min = Number(issue.minimum)
        out.push({
          path,
          code: issue.origin === 'string' ? 'too_short' : 'too_small',
          params: { min },
        })
        break
      }
      case 'too_big': {
        const max = Number(issue.maximum)
        out.push({
          path,
          code: issue.origin === 'string' ? 'too_long' : 'too_big',
          params: { max },
        })
        break
      }
      case 'invalid_format': {
        const formats: Record<string, string> = {
          email: 'invalid_email',
          url: 'invalid_url',
          uuid: 'invalid_uuid',
          date: 'invalid_date',
          datetime: 'invalid_date',
        }
        out.push({
          path,
          code:
            formats[issue.format] ??
            (issue.message === 'invalid_decimal' ? 'invalid_decimal' : 'invalid_format'),
        })
        break
      }
      case 'invalid_value':
        out.push({
          path,
          code: 'not_in_list',
          params: { options: issue.values.map(String).join(', ') },
        })
        break
      case 'unrecognized_keys':
        for (const key of issue.keys) out.push({ path: [...path, key], code: 'unknown_field' })
        break
      case 'custom':
        out.push({
          path,
          code:
            issue.message === 'required' || issue.message === 'invalid_format'
              ? issue.message
              : 'invalid',
        })
        break
      default:
        out.push({ path, code: 'invalid' })
    }
  }
  return out
}

/** Column names of a model's writable/readable fields, by field key. */
export function columnMap(model: ModelDefinition): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [key, def] of Object.entries(model.fields)) map[key] = columnName(key, def)
  return map
}

/** Whether a field's values can be ordered (gt/lt/between/sort) safely and identically everywhere. */
export function isOrderable(def: FieldDef): boolean {
  return isNumericKind(def.kind) || def.kind === 'date' || def.kind === 'datetime'
}

/** Whether a field holds text (contains/startsWith/endsWith apply). */
export function isTextual(def: FieldDef): boolean {
  return isTextKind(def.kind)
}
