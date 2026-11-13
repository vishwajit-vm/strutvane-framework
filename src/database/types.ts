/**
 * The database driver contract used by migrations and repositories.
 *
 * Deliberately tiny: parameterised SQL in, rows out, plus transactions. Strutvane generates its
 * own SQL (schema compiler, filter compiler, repository) so behaviour is explicit, auditable and
 * identical across drivers; drivers only move bytes.
 *
 * @module
 */

/** SQL dialects with full support (ADR-0004 tiers). */
export type Dialect = 'postgres' | 'sqlite'

/** A row as returned by a driver: column name → value. */
export type Row = Record<string, unknown>

/** Options for {@link Database.transaction}. */
export interface TransactionOptions {
  /**
   * Tenant for row-level security (Postgres): set transaction-locally with
   * `set_config('app.tenant_id', id, true)` (ADR-0007 rule 3). Ignored on SQLite, where the
   * repository's `tenant_id` filter is the enforcement.
   */
  readonly tenantId?: string
}

/** A connection or pool. All methods are safe to call concurrently on a pool. */
export interface Database {
  readonly dialect: Dialect
  /** Run a query and return its rows. Parameters are always bound, never interpolated. */
  query<R extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<R[]>
  /** Run a statement and return the number of affected rows. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>
  /** Run `fn` in a transaction: commit if it resolves, roll back if it throws. */
  transaction<T>(fn: (tx: Database) => Promise<T>, options?: TransactionOptions): Promise<T>
  /** Release every resource. Idempotent. */
  close(): Promise<void>
}

/** The tenant setting name read by row-level-security policies. */
export const TENANT_SETTING = 'app.tenant_id'

/** Validate a tenant id before it reaches SQL (ADR-0007 rule 5). */
export function assertTenantId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new TypeError('tenantId must be a UUID')
  }
}
