/**
 * `@strutvane/framework`: the backend and database core of Strutvane.
 *
 * Declare models as fields and types; get migrations, a secured CRUD API with OpenAPI docs and
 * a manifest, tenancy with Postgres row-level security, and storage with safe uploads.
 *
 * Built on its own kernel and contracts (`/core`, `/contracts`).
 *
 * The application core (Laravel's flow) is exported here too: `Application.configure()` for
 * `bootstrap/app.ts`, `Route` and `defineRoutes` for routes files, the `route()`/`config()`/`app()`
 * helpers, middleware and protections, form requests, the exception handler, the security kit,
 * maintenance mode, the cache and the session store. Facades live on their own subpath,
 * `@strutvane/framework/facades`, because the `Route` facade would shadow the `Route` builder.
 *
 * @packageDocumentation
 */

// Authorization: policies and the gate (deny by default), for apps and add-ons
export {
  type Ability,
  allows,
  authorize,
  hasAdminRole,
  type Policy,
  PolicyDenial,
  type PolicyResult,
} from './auth/gate.ts'
export {
  POLICIES_FOLDER,
  PolicyRegistry,
  PolicyRegistryToken,
  type PolicyTarget,
} from './auth/policies.ts'
export { type CacheManager, CacheManagerToken, type CacheStore } from './cache/contract.ts'
export {
  BUILT_IN_CACHE_DRIVERS,
  type CacheDriverContext,
  type CacheDriverFactory,
  CacheDriverRegistry,
  CacheDriverRegistryToken,
} from './cache/drivers.ts'
export {
  FILE_CACHE_FOLDER,
  FileCacheStore,
  type FileCacheStoreOptions,
} from './cache/file-store.ts'
// Application core (v2): bootstrap/app.ts, routes, middleware, exceptions, security, stores
export {
  type CacheConfig,
  type CacheDriver,
  type CacheManagerOptions,
  type CacheStoreConfig,
  createCacheManager,
  StoreCacheManager,
} from './cache/store.ts'
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
  type WriteOptions,
} from './data/repository.ts'
export {
  connectDatabase,
  type DatabaseConfig,
  DEFAULT_CONNECTION_TIMEOUT_MS,
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
export {
  type ErrorClass,
  ExceptionHandler,
  ExceptionHandlerToken,
  type ExceptionRenderCallback,
  type ExceptionReporter,
  ExceptionsConfig,
  report,
} from './exceptions/index.ts'
export {
  Application,
  ApplicationBuilder,
  type BindableModel,
  type RequestInfo,
  type RoutingOptions,
} from './foundation/application.ts'
export { BootError, isBootError } from './foundation/boot-error.ts'
export {
  ConfigError,
  type ConfigFiles,
  type ConfigOf,
  ConfigRepository,
  ConfigRepositoryToken,
  defineConfig,
} from './foundation/config.ts'
export { DatabaseConnectionToken } from './foundation/database.ts'
export { APP_ENVIRONMENTS, Env } from './foundation/env.ts'
export { app, config, now, redirect } from './foundation/helpers.ts'
export { loadApplication } from './foundation/load.ts'
export { type NavigationItem, NavigationRegistry } from './foundation/navigation.ts'
export { type AnyProvider, ServiceProvider } from './foundation/provider.ts'
export type {
  AuthUser,
  ConfigRegistry,
  RouteRegistry,
  UserRegistry,
} from './foundation/registry.ts'
export { defer, type HttpContext } from './http/app/context.ts'
export { ResponseError } from './http/app/errors.ts'
export { MaintenanceCheckToken } from './http/app/kernel.ts'
export { MemoryCacheStore } from './http/app/memory-cache.ts'
export {
  type Middleware,
  type MiddlewareClass,
  MiddlewareConfig,
  type Next,
} from './http/app/middleware.ts'
export {
  auth,
  can,
  csrf,
  csrf_field,
  csrf_meta,
  idempotent,
  signed,
  throttle,
  withAuth,
  withCan,
  withCsrf,
  withIdempotency,
  withSigned,
  withThrottle,
} from './http/app/protections.ts'
export { Controller, ResourceController } from './http/app/resource-controller.ts'
export type { ResourceModel } from './http/app/resource-model.ts'
// The rate limiter's counter store: bind a shared store (Redis) here for limits across servers.
export { RateLimitStoreToken } from './http/app/throttle.ts'
// HTTP, OpenAPI and manifest
export {
  createHttpApp,
  type HttpApp,
  type HttpAppOptions,
  type HttpRequestHookPayload,
  type HttpResponseHookPayload,
} from './http/create-http-app.ts'
export {
  CSRF_ERROR_CODE,
  type CsrfOptions,
  csrfToken,
  exactOrigin,
  matchesPathPattern,
} from './http/csrf.ts'
export {
  type BeginOutcome,
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyStore,
  IdempotencyStoreToken,
  MemoryIdempotencyStore,
  type StoredResponse,
} from './http/idempotency.ts'
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
  type WriteChange,
  type WriteContext,
} from './http/resource.ts'
export {
  type HttpBindings,
  MAX_INCLUDED_CHILDREN,
  MAX_OFFSET,
  type ResourceAfterCommitPayload,
  type ResourceOnWritePayload,
} from './http/resource-routes.ts'
export type {
  RouteContext,
  RouteDefinition,
  RouteHandler,
  RouteMethod,
  RouteOptions,
} from './http/route.ts'
export { PERMISSIONS_POLICY, securityHeaders } from './http/security.ts'
export {
  DEFAULT_SESSION_COOKIE,
  type SessionCookie,
  SessionCookieToken,
  sessionCookieName,
  sessionCookieValue,
  XSRF_COOKIE,
} from './http/session-cookie.ts'
export {
  LOOPBACK_HOSTS,
  resolveTrustedHosts,
  type TrustedHosts,
  UNTRUSTED_HOST_CODE,
} from './http/trusted-hosts.ts'
export {
  checkMaintenance,
  maintenanceRedirect,
} from './maintenance/maintenance.ts'
export {
  clearMaintenance,
  type MaintenanceState,
  readMaintenance,
  writeMaintenance,
} from './maintenance/state.ts'
export {
  APPLICATION_ERRORS,
  APPLICATION_MESSAGES_EN,
  applicationMessages,
  FRAMEWORK_ERRORS,
  FRAMEWORK_MESSAGES_EN,
  registerApplicationErrors,
  withFrameworkMessages,
} from './messages.ts'
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
export { registerModelSensitiveKeys, sensitiveFieldKeys } from './model/sensitive-keys.ts'
export { buildOpenApiDocument, type OpenApiDocument } from './openapi/document.ts'
export { buildManifest } from './openapi/manifest.ts'
export { type FrameworkProviderOptions, frameworkProvider } from './provider.ts'
export { andAll, type BoundFilter, bindFilter, FilterError } from './query/bind.ts'
export { compileFilter } from './query/compile.ts'
export { evaluateFilter, MissingFieldError } from './query/evaluate.ts'
export {
  clientQueryFields,
  narrowQueryFields,
  type QueryField,
  queryFields,
} from './query/fields.ts'
export { CursorError, SortError } from './query/sort.ts'
export {
  defineRoutes,
  Route,
  type RouteEntry,
  RouteList,
  type Router,
  type RoutesCallback,
  type RoutesSource,
} from './routing/route.ts'
// The callable route() URL helper; it keeps the v1 route.get/post/… builders (deprecated).
export { type RouteHelper, route } from './routing/route-helper.ts'
export type { RoutesOf } from './routing/types.ts'
export { UrlGenerator, UrlGeneratorToken, url } from './routing/url.ts'
export { firstAppEnv, normaliseAppEnv } from './runtime/app-env.ts'
export {
  type ApiConfig,
  apiBasePath,
  type BootedProject,
  bootProject,
  mergeResources,
  type SessionConfig,
} from './runtime/boot.ts'
export { type AppDatabaseConfig, databaseConfigFrom } from './runtime/database-config.ts'
export {
  type MigrateProjectOptions,
  type MigrateProjectResult,
  type MigrationTarget,
  migrateProject,
  migrationTarget,
  type PackagedMigration,
  type PackageMigrationDir,
  type ProjectMigrationStatus,
  projectMigrationStatus,
  readPackageMigrations,
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
export {
  type StartApplicationOptions,
  type StartedApplication,
  type StartedServer,
  type StartServerOptions,
  startApplication,
  startProject,
  startServer,
} from './runtime/server.ts'
// Schema and migrations
export {
  compilePg,
  compileSqlite,
  defaultNaming,
  type Naming,
  shortenIdentifier,
} from './schema/compile.ts'
export { DecryptError } from './security/aead.ts'
export { decrypt, Encrypter, EncrypterToken, encrypt } from './security/encrypter.ts'
export { HttpClient, HttpClientToken } from './security/http.ts'
export { HttpClientError, safeFetch } from './security/http-client.ts'
export { Keyring, KeyringToken, keyProblem } from './security/keyring.ts'
export { Redirector, safeRedirectTarget } from './security/redirect.ts'
export { type ResolvedSecurity, SecurityToken } from './security/settings.ts'
export {
  MemoryUsedSignatureStore,
  type MemoryUsedSignatureStoreOptions,
  UrlSigner,
  UrlSignerToken,
  type UsedSignatureStore,
  UsedSignatureStoreToken,
} from './security/signer.ts'
export { type SessionStore, SessionStoreToken } from './session/contract.ts'
export { FileSessionStore, SESSION_FOLDER } from './session/file-store.ts'
export { FileNotFoundError } from './storage/body.ts'
export { assertSafeKey, sanitizeFileName, UnsafeKeyError } from './storage/keys.ts'
export { createLocalDisk, type LocalDiskOptions } from './storage/local-disk.ts'
// Storage and uploads
export { createStorageManager, type StorageManager } from './storage/manager.ts'
export { createMemoryDisk, type MemoryDiskOptions } from './storage/memory-disk.ts'
export { ACTIVE_CONTENT, detectMime, isActiveContent, mimeMatches } from './storage/mime.ts'
export { type MultipartLimits, type MultipartResult, parseMultipart } from './storage/multipart.ts'
export {
  type PublicDiskSettings,
  type PublicMount,
  publicMounts,
  servePublicFile,
} from './storage/public-files.ts'
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
export { FormRequest } from './validation/form-request.ts'
