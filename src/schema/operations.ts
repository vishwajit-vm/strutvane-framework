/**
 * The recorded operations of a migration.
 *
 * Running a migration's `up()` against the recorder doesn't touch a database. It produces this
 * list of plain-data operations. The same list is then:
 * - folded into a {@link SchemaState} (types, metadata and the ORM's runtime snapshot), and
 * - compiled to SQL for a real database (the migrator).
 *
 * Because both paths start from the same list, the types can't drift from the SQL that runs.
 * Operations are plain JSON, so the replay sandbox can send them from its child process.
 *
 * @module
 */
import type { ColumnDef, IndexDef, SchemaState } from './columns.ts'

/**
 * One change inside `schema.create(…)` or `schema.table(…)`.
 *
 * @example
 * const action: TableAction = { type: 'renameColumn', from: 'body', to: 'content' }
 */
export type TableAction =
  | { readonly type: 'addColumn'; readonly column: ColumnDef }
  | { readonly type: 'renameColumn'; readonly from: string; readonly to: string }
  | { readonly type: 'dropColumn'; readonly name: string }
  | { readonly type: 'addIndex'; readonly index: IndexDef }
  | { readonly type: 'dropIndex'; readonly name: string }

/**
 * The third argument of `schema.create(name, define, options)`.
 *
 * - `global`: shared reference data, deliberately visible to every tenant (security review F-04).
 * - `internal`: framework bookkeeping; no API resource, UI screen or sidebar entry.
 *
 * @example
 * schema.create('countries', (t) => { t.id(); t.string('name') }, { global: true })
 */
export interface CreateTableOptions {
  readonly global?: true
  readonly internal?: true
}

/**
 * One schema-level operation, in the order the migration called it.
 *
 * @example
 * const op: SchemaOperation = { type: 'dropTable', table: 'posts', ifExists: true }
 */
export type SchemaOperation =
  | {
      readonly type: 'createTable'
      readonly table: string
      readonly actions: readonly TableAction[]
      /** Present only when `schema.create` got options. */
      readonly options?: CreateTableOptions
    }
  | {
      readonly type: 'alterTable'
      readonly table: string
      readonly actions: readonly TableAction[]
    }
  | { readonly type: 'dropTable'; readonly table: string; readonly ifExists: boolean }
  | { readonly type: 'renameTable'; readonly from: string; readonly to: string }

/**
 * One replayed migration as plain data: its name, what `up()` and `down()` recorded, and the
 * schema before and after it. This is what the replay sandbox sends back from its child process.
 *
 * @example
 * const step: ReplayedStep = { name: '2026_01_01_000000_create_tags_table', up: [], down: [], before: EMPTY_SCHEMA, after: EMPTY_SCHEMA }
 */
export interface ReplayedStep {
  readonly name: string
  readonly up: readonly SchemaOperation[]
  readonly down: readonly SchemaOperation[]
  readonly before: SchemaState
  readonly after: SchemaState
}
