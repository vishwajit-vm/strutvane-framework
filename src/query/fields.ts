/**
 * The queryable fields of a model: its declared fields plus the system fields every table has.
 * One resolver for the filter binder, the sort/cursor builder and the list-query parser.
 *
 * @module
 */
import { columnName, type ModelDefinition } from '../model/define-model.ts'
import { type FieldDef, operatorsFor } from '../model/field.ts'

/** A field that can appear in filters or sorts. */
export interface QueryField {
  /** API key (`dueDate`, `customer`). */
  readonly key: string
  readonly column: string
  readonly def: FieldDef
  /** System fields (`id`, timestamps) are always present and never user-declared. */
  readonly system: boolean
}

const systemDef = (kind: FieldDef['kind'], required: boolean, label: string): FieldDef => ({
  kind,
  required,
  unique: false,
  index: false,
  filterOperators: operatorsFor(kind),
  sortable: true,
  searchable: false,
  hidden: false,
  readOnly: true,
  writeOnce: false,
  sensitive: false,
  label,
})

/**
 * The fields clients may reference in list queries (filters, sorts, search): every queryable
 * field except hidden ones. Trusted policy filters use {@link queryFields} instead.
 */
export function clientQueryFields(model: ModelDefinition): ReadonlyMap<string, QueryField> {
  return new Map([...queryFields(model)].filter(([, f]) => !f.def.hidden))
}

/**
 * Narrow client query fields to those an actor may filter, sort and search on: the
 * intersection of `fields` with `allowed` (from `PermissionProvider.filterableFields`).
 * `undefined` means the provider does not narrow, so `fields` is returned unchanged.
 *
 * Why: a filter, sort order or search hit on a field the actor may not read is a value oracle
 * (it reveals the field's contents one query at a time), even if the field is never serialized.
 */
export function narrowQueryFields(
  fields: ReadonlyMap<string, QueryField>,
  allowed: ReadonlySet<string> | undefined,
): ReadonlyMap<string, QueryField> {
  if (allowed === undefined) return fields
  return new Map([...fields].filter(([key]) => allowed.has(key)))
}

/** Every queryable field of a model, by API key. */
export function queryFields(model: ModelDefinition): ReadonlyMap<string, QueryField> {
  const out = new Map<string, QueryField>()
  out.set('id', { key: 'id', column: 'id', def: systemDef('uuid', true, 'ID'), system: true })
  for (const [key, def] of Object.entries(model.fields)) {
    out.set(key, { key, column: columnName(key, def), def, system: false })
  }
  if (model.options.timestamps) {
    out.set('createdAt', {
      key: 'createdAt',
      column: 'created_at',
      def: systemDef('datetime', true, 'Created at'),
      system: true,
    })
    out.set('updatedAt', {
      key: 'updatedAt',
      column: 'updated_at',
      def: systemDef('datetime', true, 'Updated at'),
      system: true,
    })
  }
  if (model.options.softDeletes) {
    out.set('deletedAt', {
      key: 'deletedAt',
      column: 'deleted_at',
      def: systemDef('datetime', false, 'Deleted at'),
      system: true,
    })
  }
  return out
}
