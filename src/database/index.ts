/**
 * The Strutvane ORM: connections and drivers, grammars, models, the query builder, relations,
 * casts and tenancy. Re-exported by `@strutvane/framework/database` (src/entries/database.ts).
 *
 * @module
 */
export { Connection, type QueryEvent } from './db/connection.ts'
export type { Driver, DriverSession, QueryResult, Row } from './db/driver.ts'
export { defaultConnection, transaction, useConnection } from './db/manager.ts'
export {
  connectMysqlFamily,
  detectMysqlServer,
  type MysqlPoolOptions,
  type MysqlServer,
  mysqlDriver,
} from './db/mysql-driver.ts'
export { type PgPoolSettings, pgDriver } from './db/pg-driver.ts'
export { pgliteDriver } from './db/pglite-driver.ts'
export { sqliteDriver } from './db/sqlite-driver.ts'
export { Builder, type FilterOperator } from './orm/builder.ts'
export { type Cast, cast, json } from './orm/casts.ts'
export { configureOrm, type OrmConfig, type UnsafeTenancyEvent } from './orm/config.ts'
export {
  CastError,
  LazyLoadingError,
  MassAssignmentError,
  ModelNotFoundError,
  OrmError,
  OrmUsageError,
  TenantMismatchError,
  TenantRequiredError,
} from './orm/errors.ts'
export { loadMany, Model, ModelBase, type ModelClass, type ModelInstance } from './orm/model.ts'
export type { CursorPage, Page } from './orm/pagination.ts'
export type { BelongsTo, BelongsToMany, HasMany } from './orm/relations.ts'
export { currentTenant, runWithTenant } from './orm/tenancy.ts'
export { TenantScopeMissingError, unsafeRaw } from './orm/tenant-scope.ts'
export type {
  JsonOf,
  QueryBuilder,
  RelationPath,
  ScopeQuery,
  Scopes,
  WithCounts,
  WithRelations,
} from './orm/types.ts'
export {
  type ColumnOf,
  type JsonValue,
  type RowOf,
  registerSchema,
  type TableName,
} from './schema/registry.ts'
export type { SchemaSnapshot } from './schema/snapshot.ts'
export { SqlFragment, type SqlTag, sql } from './sql/fragment.ts'
export {
  type Dialect,
  type Grammar,
  grammarFor,
  isMysqlFamily,
  mariadbGrammar,
  mysqlGrammar,
  postgresGrammar,
  type RenderedSql,
  type ServerCapabilities,
  sqliteGrammar,
} from './sql/grammar.ts'
