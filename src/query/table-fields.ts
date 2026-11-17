/**
 * The queryable fields of a migration-defined table, for policy filters on ORM queries.
 *
 * Policies (ADR-0008/0017) are written against field names and bound before they reach SQL. For
 * an ORM model the fields are its columns, named as in the migration (snake_case, like the rest
 * of the ORM), each mapped to the v1 field kind whose canonical values and operators the binder
 * already knows. One mapping means a policy binds identically for a v1 model and an ORM model.
 *
 * @module
 */

import { type FieldDef, type FieldKind, operatorsFor } from '../model/field.ts'
import type { ColumnDef, ColumnKind, TableState } from '../schema/columns.ts'
import type { QueryField } from './fields.ts'

const KIND: Readonly<Record<ColumnKind, FieldKind>> = {
  id: 'integer',
  integer: 'integer',
  bigInteger: 'bigInteger',
  foreignId: 'integer',
  string: 'string',
  slug: 'string',
  text: 'text',
  uuid: 'uuid',
  decimal: 'decimal',
  double: 'float',
  boolean: 'boolean',
  enum: 'enum',
  date: 'date',
  timestamp: 'datetime',
  json: 'json',
}

function definition(column: ColumnDef): FieldDef {
  const kind = KIND[column.kind]
  return {
    kind,
    required: !column.nullable,
    unique: false,
    index: false,
    filterOperators: operatorsFor(kind),
    sortable: kind !== 'json',
    searchable: false,
    hidden: column.hidden === true || column.secret === true,
    readOnly: false,
    writeOnce: false,
    sensitive: column.secret === true,
    ...(column.scale === undefined ? {} : { scale: column.scale }),
    ...(column.values === undefined ? {} : { values: column.values }),
  }
}

/**
 * Every column of `table` as a {@link QueryField}, keyed by column name. Hidden and secret
 * columns are left out unless `includeHidden` is set: a filter on a column the caller may not
 * read is a value oracle (`filter[password][startsWith]=a`), so only trusted policy code gets them.
 *
 * @example
 * const fields = tableQueryFields(tableState('posts'), { includeHidden: true })
 * bindFilter(policy, { fields, operators: 'any', actor })
 */
export function tableQueryFields(
  table: TableState,
  options: { readonly includeHidden: boolean },
): ReadonlyMap<string, QueryField> {
  const out = new Map<string, QueryField>()
  for (const column of table.columns) {
    const def = definition(column)
    if (def.hidden && !options.includeHidden) continue
    out.set(column.name, { key: column.name, column: column.name, def, system: false })
  }
  return out
}
