/**
 * Global ORM switches (Laravel's `Model::preventLazyLoading()` and friends), set once at boot.
 */

/**
 * The ORM's global settings.
 *
 * @example
 * configureOrm({ preventLazyLoading: true })
 */
export interface OrmConfig {
  /**
   * Throw when a relation is loaded on one model that came from a list (the N+1 pattern).
   * Default: on everywhere except `NODE_ENV=production`, like Laravel's recommended setup.
   */
  readonly preventLazyLoading: boolean
  /** The largest page size `paginate()`/`cursorPaginate()` accept (protects the database). */
  readonly maxPerPage: number
  /**
   * The longest list `whereIn`, `whereNotIn` and `filter(…, 'in', …)` accept. A request-driven
   * `filter[id][in]=…` with 100,000 values would exceed SQLite's and PostgreSQL's parameter limits.
   */
  readonly maxInValues: number
  /**
   * Multi-tenancy: the one canonical tenant column for the whole app (`tenant_id`, or `team_id`
   * for "teams"), or `false` for a single-tenant app (the default; `config/tenancy.ts`'s
   * `enabled` turns it on, CONSISTENCY #90). With tenancy on, every table either has that column
   * (scoped), is marked `global` (shared data), or is refused (fail closed). With tenancy off, a
   * table whose migration declared `t.tenant()` is refused too: its rows would be unscoped.
   */
  readonly tenancy: { readonly column: string } | false
  /** Called for every deliberate tenancy bypass (`unsafeWithoutTenancy`, `unsafeRaw`): wire it to the audit log. */
  readonly onUnsafeTenancy: (event: UnsafeTenancyEvent) => void
}

/**
 * One deliberate tenancy bypass, for the audit log.
 *
 * @example
 * configureOrm({ onUnsafeTenancy: (event) => audit.write('tenancy.bypass', event) })
 */
export interface UnsafeTenancyEvent {
  readonly kind: 'query' | 'raw'
  readonly tables: readonly string[]
  readonly reason: string
}

let config: OrmConfig = {
  preventLazyLoading: process.env['NODE_ENV'] !== 'production',
  maxPerPage: 100,
  maxInValues: 1000,
  tenancy: false,
  onUnsafeTenancy: () => undefined,
}

/**
 * Change some settings; the others keep their values.
 *
 * @example
 * configureOrm({ maxPerPage: 500 })
 */
export function configureOrm(changes: Partial<OrmConfig>): void {
  config = { ...config, ...changes }
}

/**
 * The current settings.
 *
 * @example
 * ormConfig().maxPerPage // 100
 */
export function ormConfig(): OrmConfig {
  return config
}
