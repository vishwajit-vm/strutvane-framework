/**
 * Describe a model the way a policy engine sees it: SQL table, columns and portable column types.
 *
 * `@strutvane/auth`'s `definePolicy(resource, { schema }, rules)` needs this to type-check rule
 * predicates and compile them to SQL. The framework never imports auth (product packages don't
 * import each other), so this returns plain data in auth's `ModelSchema` shape (structurally typed):
 *
 * ```ts
 * import { definePolicy } from '@strutvane/auth'
 * import { policySchema } from '@strutvane/framework'
 * import Invoice from '../models/invoice.model.ts'
 * export default definePolicy('invoice', { schema: policySchema(Invoice) }, ({ allow }) => { … })
 * ```
 *
 * @module
 */
import type { AnyModel, FieldMap, Model, ModelDefinition, ModelOptions } from './define-model.ts'
import { columnName } from './define-model.ts'
import type { FieldBuilder, FieldKind } from './field.ts'

/** Portable column types understood by policy compilers. */
export type PolicyColumnType = 'text' | 'uuid' | 'int4' | 'float8' | 'bool'

/** One column of a {@link PolicySchema}. */
export interface PolicyColumn {
  readonly column: string
  readonly type: PolicyColumnType
}

/** A model as a policy engine sees it. Field names are API names (`ownerId`). */
export interface PolicySchema {
  readonly table: string
  readonly columns: Readonly<Record<string, PolicyColumn>>
}

/**
 * Field kind → policy column type. Kinds without an exact counterpart compare as text, which is
 * correct for equality and set membership; numeric decimals map to float8 so range rules work.
 */
const TYPE: Readonly<Record<FieldKind, PolicyColumnType>> = Object.freeze({
  string: 'text',
  text: 'text',
  email: 'text',
  url: 'text',
  uuid: 'uuid',
  integer: 'int4',
  bigInteger: 'text',
  decimal: 'float8',
  float: 'float8',
  boolean: 'bool',
  enum: 'text',
  date: 'text',
  datetime: 'text',
  json: 'text',
  belongsTo: 'uuid',
})

/** Field kind → policy column type, at the type level (mirrors `TYPE` below). */
export type PolicyTypeOfKind<K> = K extends 'uuid' | 'belongsTo'
  ? 'uuid'
  : K extends 'integer'
    ? 'int4'
    : K extends 'decimal' | 'float'
      ? 'float8'
      : K extends 'boolean'
        ? 'bool'
        : 'text'

type KindOf<B> = B extends FieldBuilder<unknown, boolean, boolean, boolean, infer K> ? K : never
type PolicyKeys<F> = {
  [K in keyof F]: KindOf<F[K]> extends never ? never : KindOf<F[K]> extends 'json' ? never : K
}[keyof F]
type Col<T extends PolicyColumnType> = { readonly column: string; readonly type: T }
type TenantColumns<O> = O extends { tenant: true } ? { readonly tenantId: Col<'uuid'> } : unknown
type TimestampColumns<O> = O extends { timestamps: false }
  ? unknown
  : { readonly createdAt: Col<'text'>; readonly updatedAt: Col<'text'> }

/**
 * The exact {@link PolicySchema} type of a model: one column per field (json fields excluded) with
 * its policy type, plus `id`, `tenantId` (tenant models) and the timestamps. A policy rule on a
 * misspelt field, or comparing a decimal with text, does not compile.
 */
export type PolicySchemaOf<M> =
  M extends Model<string, infer F extends FieldMap, infer O extends ModelOptions>
    ? {
        readonly table: string
        readonly columns: { readonly id: Col<'uuid'> } & TenantColumns<O> &
          TimestampColumns<O> & {
            readonly [K in PolicyKeys<F>]: Col<PolicyTypeOfKind<KindOf<F[K]>>>
          }
      }
    : PolicySchema

/** Build the {@link PolicySchema} of a model (system columns included). */
export function policySchema<M extends AnyModel>(model: M): PolicySchemaOf<M>
export function policySchema(model: ModelDefinition): PolicySchema
export function policySchema(model: AnyModel | ModelDefinition): PolicySchema {
  const def = 'definition' in model ? model.definition : model
  const columns: Record<string, PolicyColumn> = { id: { column: 'id', type: 'uuid' } }
  if (def.options.tenant) columns['tenantId'] = { column: 'tenant_id', type: 'uuid' }
  for (const [key, field] of Object.entries(def.fields)) {
    if (field.kind === 'json') continue // not comparable in policies
    columns[key] = { column: columnName(key, field), type: TYPE[field.kind] }
  }
  if (def.options.timestamps) {
    columns['createdAt'] = { column: 'created_at', type: 'text' }
    columns['updatedAt'] = { column: 'updated_at', type: 'text' }
  }
  return Object.freeze({ table: def.table, columns: Object.freeze(columns) }) as PolicySchema
}
