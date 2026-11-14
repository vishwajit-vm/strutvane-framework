/**
 * `@strutvane/framework`: the backend and database core of Strutvane.
 *
 * Declare models as fields and types; get migrations, a secured CRUD API with OpenAPI docs and
 * a manifest, tenancy with Postgres row-level security, and storage with safe uploads.
 *
 * Depends only on `@strutvane/core` and `@strutvane/contracts`.
 *
 * @packageDocumentation
 */

// Data access and queries
export {
  createRepository,
  type DataRecord,
  type ListOptions,
  type ListPage,
  type PageSpec,
  PolicyViolationError,
  type Repository,
  type RepositoryOptions,
  type Scope,
  TenantRequiredError,
} from './data/repository.ts'
export {
  connectDatabase,
  type DatabaseConfig,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  NotImplementedError,
  type PostgresAuth,
  type PostgresConfig,
  pgPoolOptions,
} from './database/connect.ts'
export {
  type LibsqlLike,
  libsqlDatabase,
  type PgClientLike,
  type PgliteLike,
  type PgPoolLike,
  pgDatabase,
  pgliteDatabase,
} from './database/drivers.ts'
// Database
export type { Database, Dialect, Row, TransactionOptions } from './database/types.ts'
// HTTP, OpenAPI and manifest
export {
  createHttpApp,
  type HttpApp,
  type HttpAppOptions,
  type HttpRequestHookPayload,
  type HttpResponseHookPayload,
} from './http/create-http-app.ts'
export { type ListParams, parseListQuery, serializeListParams } from './http/list-query.ts'
export {
  allowAllPermissions,
  denyAllPermissions,
  MissingPermissionProviderError,
} from './http/permissions.ts'
export type { TrustProxy } from './http/proxy.ts'
export {
  defineResource,
  type ResourceAction,
  type ResourceConfig,
  type ResourceContext,
  type ResourceHooks,
} from './http/resource.ts'
export { type HttpBindings, MAX_OFFSET } from './http/resource-routes.ts'
export {
  type RouteContext,
  type RouteDefinition,
  type RouteHandler,
  type RouteMethod,
  type RouteOptions,
  route,
} from './http/route.ts'
export { PERMISSIONS_POLICY, securityHeaders } from './http/security.ts'
export { FRAMEWORK_ERRORS, FRAMEWORK_MESSAGES_EN, withFrameworkMessages } from './messages.ts'
export {
  answersResolver,
  checksumOf,
  type MigrationSource,
  migrationFileName,
  migrationSource,
  parseMigration,
  readMigrations,
  readSnapshot,
  renderMigration,
  type Snapshot,
  writeMigration,
} from './migrations/files.ts'
export {
  type AppliedMigration,
  detectSchemaDrift,
  MIGRATIONS_TABLE,
  type MigrationDrift,
  MigrationDriftError,
  type MigrationStatus,
  migrate,
  migrationStatus,
  type SchemaDrift,
} from './migrations/migrator.ts'
export {
  assertPromptFree,
  classifyChanges,
  type DestructiveChange,
  DestructiveChangeError,
  type DestructiveKind,
  describeRename,
  type MigrationPlan,
  type PlanInput,
  planMigration,
  type RenameCandidate,
  type RenameDecision,
  RenameResolutionRequiredError,
  type RenameResolver,
} from './migrations/planner.ts'
export {
  disableTenantRls,
  enableTenantRls,
  type TenancyFinding,
  tenancyAudit,
} from './migrations/rls.ts'
export {
  type AnyModel,
  type CreateInput,
  columnName,
  defineModel,
  type FieldMap,
  hiddenFieldProblem,
  type InferModel,
  type Model,
  type ModelDefinition,
  type ModelOptions,
  type RelationDef,
  type UpdateInput,
} from './model/define-model.ts'
// Models
export {
  FieldBuilder,
  type FieldDef,
  type FieldKind,
  field,
  HasManyBuilder,
  operatorsFor,
} from './model/field.ts'
export {
  type PolicyColumn,
  type PolicyColumnType,
  type PolicySchema,
  policySchema,
} from './model/policy-schema.ts'
export {
  createModelRegistry,
  dependencyOrder,
  type ModelRegistry,
  validateModels,
} from './model/registry.ts'
export {
  issuesFromZod,
  type ModelSchemas,
  modelLabels,
  modelSchemas,
  valueSchema,
} from './model/schemas.ts'
// Wiring
export {
  REDACT_KEYS_HOOK,
  type RedactKeysPayload,
  sensitiveFieldKeys,
} from './model/sensitive-keys.ts'
export { buildOpenApiDocument, type OpenApiDocument } from './openapi/document.ts'
export { buildManifest } from './openapi/manifest.ts'
export { type FrameworkProviderOptions, frameworkProvider } from './provider.ts'
export { andAll, type BoundFilter, bindFilter, FilterError } from './query/bind.ts'
export { compileFilter } from './query/compile.ts'
export { evaluateFilter, MissingFieldError } from './query/evaluate.ts'
export { clientQueryFields, type QueryField, queryFields } from './query/fields.ts'
export { CursorError, SortError } from './query/sort.ts'
export {
  type ApiConfig,
  apiBasePath,
  type BootedProject,
  bootProject,
  mergeResources,
} from './runtime/boot.ts'
export { type AppDatabaseConfig, databaseConfigFrom } from './runtime/database-config.ts'
export {
  type MigrateProjectOptions,
  type MigrateProjectResult,
  type MigrationTarget,
  migrateProject,
  migrationTarget,
  projectMigrationStatus,
} from './runtime/migrations.ts'
export {
  type LoadedProject,
  type LoadProjectOptions,
  loadProject,
  ProjectLoadError,
} from './runtime/project.ts'
export { runSeeder } from './runtime/seeders.ts'
export {
  type FetchHandler,
  type RunningServer,
  type ServeBindings,
  type ServeOptions,
  serve,
} from './runtime/serve.ts'
export { type StartedServer, type StartServerOptions, startServer } from './runtime/server.ts'
// Schema and migrations
export {
  compilePg,
  compileSqlite,
  defaultNaming,
  type Naming,
  shortenIdentifier,
} from './schema/compile.ts'
export { FileNotFoundError } from './storage/body.ts'
export { assertSafeKey, sanitizeFileName, UnsafeKeyError } from './storage/keys.ts'
export { createLocalDisk, type LocalDiskOptions } from './storage/local-disk.ts'
// Storage and uploads
export { createStorageManager, type StorageManager } from './storage/manager.ts'
export { createMemoryDisk, type MemoryDiskOptions } from './storage/memory-disk.ts'
export { ACTIVE_CONTENT, detectMime, mimeMatches } from './storage/mime.ts'
export { type MultipartLimits, type MultipartResult, parseMultipart } from './storage/multipart.ts'
export {
  type SignedFileOptions,
  serveSignedFile,
  signedFilePrefix,
} from './storage/serve-signed.ts'
export { signUrl, verifySignedUrl } from './storage/signing.ts'
export { tenantDisk, tenantPrefix } from './storage/tenant-disk.ts'
export {
  type FileRules,
  parseBytes,
  type StoreOptions,
  UploadedFile,
} from './storage/uploaded-file.ts'
export {
  DatabaseToken,
  ModelRegistryToken,
  ProjectModelsToken,
  StorageManagerToken,
} from './tokens.ts'
