/**
 * `@strutvane/framework/database`: the Strutvane ORM and everything around it.
 *
 * - **Models and queries:** `Model('posts', { fillable })`, the typed query builder, relations,
 *   casts, scopes, soft deletes, slugs, pagination and the tenant scope (spike 11, ADR-0007/0008).
 * - **Connections:** drivers for MySQL 8.4+ (the default), MariaDB, PostgreSQL (node-postgres and
 *   PGlite) and SQLite (`node:sqlite`), transactions with savepoints, and the grammars.
 * - **Migrations:** the v2 runner (`runMigrations`, `rollbackMigrations`, …) over the operations
 *   replayed from `database/migrations` (in the F-06 sandbox), and schema introspection.
 * - **Seeders:** `defineSeeder` and v1's hand-written `defineMigration`.
 *
 * Generated `.strutvane/types/models.d.ts` augments {@link TableRegistry} in this module, which is
 * how `class Post extends Model('posts')` knows its columns without declaring them.
 *
 * @module
 */
export * from '../database/index.ts'
export type { JsonValue } from '../database/schema/registry.ts'

/**
 * Every table of the app, with its four shapes (`row`, `insert`, `update`, `json`). Empty here
 * on purpose: the generated `.strutvane/types/models.d.ts` fills it in through declaration
 * merging, so the framework never imports app code. It is declared in this module (not
 * re-exported) because TypeScript merges an augmentation only into the module that declares the
 * interface.
 *
 * @example
 * declare module '@strutvane/framework/database' {
 *   interface TableRegistry { posts: { row: Post; insert: NewPost; update: PostPatch; json: PostJson } }
 * }
 */
// biome-ignore lint/suspicious/noEmptyInterface: the declaration-merging target generated types augment
export interface TableRegistry {}
export {
  introspect as introspectDatabase,
  type LiveColumn,
  type LiveForeignKey,
  type LiveIndex,
  type LiveTable,
  schemaDrift,
} from '../migrations/introspect.ts'
export { MigrationError, type MigrationErrorCode } from '../migrations/migration-error.ts'
export {
  DEFAULT_LOCK_TIMEOUT_MS,
  fresh as freshMigrations,
  type MaintenanceOptions,
  MIGRATIONS_TABLE,
  type MigrateOptions,
  type MigrateResult,
  type MigrationDrift as SchemaMigrationDrift,
  type MigrationEvent,
  type MigrationStatus as SchemaMigrationStatus,
  type MigrationWarning,
  migrate as runMigrations,
  migrationStatus as schemaMigrationStatus,
  type PlannedMigration,
  type RanMigration,
  type RollbackOptions,
  type RollbackResult,
  refresh as refreshMigrations,
  reset as resetMigrations,
  rollback as rollbackMigrations,
} from '../migrations/runner.ts'
export {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  replayInSandbox,
  SandboxError,
  type SandboxErrorCode,
  type SandboxOptions,
} from '../migrations/sandbox.ts'
export {
  defineMigration,
  defineSeeder,
  type MigrationContext,
  type MigrationDefinition,
  type Seeder,
  type SeederContext,
  type SeedFactory,
} from '../runtime/seeders.ts'
