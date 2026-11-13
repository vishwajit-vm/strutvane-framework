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
import type { AnyModel, ModelDefinition } from './define-model.ts'
import { columnName } from './define-model.ts'
import type { FieldKind } from './field.ts'

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

/** Build the {@link PolicySchema} of a model (system columns included). */
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
  return Object.freeze({ table: def.table, columns: Object.freeze(columns) })
}
