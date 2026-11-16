/**
 * `@strutvane/framework/schema`: what migration files import.
 *
 * ```ts
 * import { migration } from '@strutvane/framework/schema'
 *
 * export default migration({
 *   up(schema) {
 *     schema.create('posts', (t) => {
 *       t.id()
 *       t.string('title', 200)
 *       t.slug('slug').from('title')
 *       t.timestamps()
 *     })
 *   },
 *   down(schema) {
 *     schema.dropIfExists('posts')
 *   },
 * })
 * ```
 *
 * Deliberately small and free of drivers and the ORM: migrations are replayed in a sandboxed
 * child process to generate types, and this is the only package module they may import there.
 *
 * @module
 */
export type {
  Blueprint,
  ColumnBuilder,
  EnumValues,
  ForeignIdColumnBuilder,
  ForeignUuidColumnBuilder,
  SlugColumnBuilder,
  UuidColumnBuilder,
} from '../schema/blueprint.ts'
export type {
  ColumnDef,
  ColumnKind,
  DefaultValue,
  ForeignKeyDef,
  IndexDef,
  ReferentialAction,
  SchemaSnapshot,
  SchemaState,
  TableState,
  TenantKeyDef,
} from '../schema/columns.ts'
export { SchemaError, type SchemaErrorCode } from '../schema/errors.ts'
export { type Migration, migration, type SchemaBuilder } from '../schema/migration.ts'
export type { CreateTableOptions, SchemaOperation, TableAction } from '../schema/operations.ts'
