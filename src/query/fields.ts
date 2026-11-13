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
