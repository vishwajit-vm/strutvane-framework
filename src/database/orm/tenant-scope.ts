/**
 * Tenant isolation: the rules, and the one check every statement passes before it runs.
 *
 * On MySQL and SQLite there is no row-level security, so this module *is* the isolation
 * guarantee; on PostgreSQL it is the first of two layers (RLS is the second, ADR-0007). The
 * design follows the 2026-11-14 security review (F-04, F-05):
 *
 * - **One canonical tenant column** for the whole app (`configureOrm({ tenancy: { column } })`,
 *   `tenant_id` by default, `team_id` for teams). Not a hard-coded name.
 * - **Every table is classified:** `scoped` (has the column), `global` (marked as shared data in
 *   its migration) or `unscopable` (neither). Unscopable tables are refused outright: a child
 *   table such as `invoice_lines` without the column would otherwise be readable across tenants.
 * - **One choke point on the SQL tree.** Before a builder query is rendered, every tenant table it
 *   touches (FROM, JOIN, subqueries, EXISTS, UPDATE, DELETE, INSERT) must carry
 *   `<alias>.<tenant column> = <the active tenant>` as a top-level AND condition. A missing scope
 *   is a bug in the ORM or in app code, and it throws instead of leaking.
 * - **Raw SQL is guarded too.** In a tenant context, any statement that did not come out of this
 *   check and mentions a tenant table is refused, unless wrapped in `unsafeRaw(reason, …)`.
 * - **Bypasses are explicit, named `unsafe…`, need a reason, and are reported** to
 *   `onUnsafeTenancy` for the audit log.
 */

import { setStatementGuard } from '../db/guard.ts'
import { allTables, tableState } from '../schema/registry.ts'
import type { ColumnRef, SelectAst, WhereNode } from '../sql/ast.ts'
import type { SqlFragment } from '../sql/fragment.ts'
import { ormConfig } from './config.ts'
import { OrmError, OrmUsageError, TenantRequiredError } from './errors.ts'
import { currentTenant } from './tenancy.ts'

/**
 * A statement would touch tenant data without being limited to the active tenant.
 *
 * @example
 * throw new TenantScopeMissingError('projects', 'the JOIN on projects has no tenant condition')
 */
export class TenantScopeMissingError extends OrmError {
  override readonly name = 'TenantScopeMissingError'

  constructor(table: string, detail: string) {
    super(
      'tenant_scope_missing',
      `Refusing to run SQL on "${table}": ${detail}. Tenant data may only be read or written for the active tenant. ` +
        'If this really must cross tenants (a maintenance job), use unsafeWithoutTenancy(reason) or unsafeRaw(reason, …): both are audited.',
    )
  }
}

/** How a table relates to tenancy. */
export type TenantMode = 'scoped' | 'global' | 'unscopable'

/**
 * The configured tenant column, or `undefined` when the app is single-tenant.
 *
 * @example
 * tenantColumn() // 'tenant_id'
 */
export function tenantColumn(): string | undefined {
  const tenancy = ormConfig().tenancy
  return tenancy === false ? undefined : tenancy.column
}

function tenancyOff(table: string, column: string): OrmUsageError {
  return new OrmUsageError(
    'tenancy_not_configured',
    `"${table}" has a tenant column (${column}, from t.tenant()), but tenancy is off, so its rows would not be scoped. ` +
      `Turn tenancy on in config/tenancy.ts ({ enabled: true, column: '${column}' }), or call configureOrm({ tenancy: { column: '${column}' } }) at boot.`,
  )
}

/**
 * Classify a table. Computed live (not cached) so changing the configuration takes effect at once.
 *
 * @example
 * tenantMode('projects') // 'scoped'
 */
export function tenantMode(table: string): TenantMode {
  const column = tenantColumn()
  const state = tableState(table)
  if (column === undefined) {
    // Fail closed: a table built for tenancy (`t.tenant()`) must never be read unscoped because
    // the app's tenancy switch is missing.
    const declared = state.columns.find((candidate) => candidate.tenant === true)
    if (declared !== undefined) throw tenancyOff(table, declared.name)
    return 'global'
  }
  if (state.columns.some((candidate) => candidate.name === column)) return 'scoped'
  return state.global === true ? 'global' : 'unscopable'
}

/**
 * The active tenant for a statement on `table`, or the right error: no tenant at all
 * (`TenantRequiredError`), or a table tenancy can't protect (`TenantScopeMissingError`).
 *
 * @example
 * const tenant = requireTenant('projects')
 */
export function requireTenant(table: string): string {
  if (tenantMode(table) === 'unscopable') throw unscopable(table)
  const tenant = currentTenant()
  if (tenant === undefined) throw new TenantRequiredError(table)
  return tenant
}

/**
 * The condition that limits `alias` (a reference to `table`) to the active tenant, or
 * `undefined` for global tables. Throws for unscopable tables and outside a tenant context.
 *
 * @example
 * tenantCondition('projects', 'projects') // projects.tenant_id = '<active tenant>'
 */
export function tenantCondition(table: string, alias: string): WhereNode | undefined {
  const mode = tenantMode(table)
  if (mode === 'global') return undefined
  const tenant = requireTenant(table)
  return {
    kind: 'compare',
    conjunction: 'and',
    column: { alias, column: tenantColumnOrThrow() },
    operator: '=',
    value: tenant,
  }
}

/**
 * Check a whole SELECT tree: every tenant table reference must be scoped to the active tenant.
 * `bypass` lists aliases a builder deliberately unscoped with `unsafeWithoutTenancy`.
 *
 * @example
 * assertSelectScoped(ast, new Set())
 */
export function assertSelectScoped(ast: SelectAst, bypass: ReadonlySet<string>): void {
  const references = [
    { table: ast.table, alias: ast.alias },
    ...ast.joins.map((join) => ({ table: join.table, alias: join.alias })),
  ]
  for (const reference of references) {
    if (bypass.has(reference.alias)) continue
    assertScopedBy(reference.table, reference.alias, ast.where)
  }
  for (const item of ast.select)
    if (item.kind === 'subquery') assertSelectScoped(item.query, bypass)
  for (const query of nestedQueries(ast.where)) assertSelectScoped(query, bypass)
  assertRawConditionsScoped(ast.where)
}

/**
 * Raw conditions (`whereRaw`) inside a builder query get the same rule as hand-written statements:
 * in a tenant context, one that names a tenant table is refused unless it came from
 * {@link unsafeRaw}. Without this, the builder's own "checked" mark on the compiled statement
 * would wave through a `whereRaw` of `EXISTS (SELECT 1 FROM projects WHERE name = …)`: an existence
 * oracle over every tenant's rows.
 */
function assertRawConditionsScoped(nodes: readonly WhereNode[]): void {
  if (tenantColumn() === undefined || currentTenant() === undefined) return
  for (const node of nodes) {
    if (node.kind === 'group') assertRawConditionsScoped(node.nodes)
    if (node.kind !== 'raw' || checked.has(node.fragment)) continue
    const [first] = tenantTablesIn(node.fragment)
    if (first !== undefined) {
      throw new TenantScopeMissingError(
        first,
        'a raw condition (whereRaw) names a tenant table, and raw SQL cannot be checked for a tenant condition; use whereHas, or wrap the fragment in unsafeRaw(reason, …)',
      )
    }
  }
}

/**
 * Check an UPDATE or DELETE: on a tenant table its WHERE must pin the active tenant.
 *
 * @example
 * assertWriteScoped('projects', where)
 */
export function assertWriteScoped(table: string, where: readonly WhereNode[]): void {
  assertScopedBy(table, table, where)
  for (const query of nestedQueries(where)) assertSelectScoped(query, new Set())
}

/**
 * Check an INSERT: on a tenant table the row must belong to the active tenant.
 *
 * @example
 * assertInsertScoped('projects', { tenant_id: tenant, name: 'X' })
 */
export function assertInsertScoped(table: string, record: Readonly<Record<string, unknown>>): void {
  const mode = tenantMode(table)
  if (mode === 'global') return
  const tenant = requireTenant(table)
  if (record[tenantColumnOrThrow()] !== tenant)
    throw new TenantScopeMissingError(table, 'the new row does not belong to the active tenant')
}

const checked = new WeakSet<SqlFragment>()

/**
 * Remember that a fragment came out of the scope checks above, so the statement guard lets it
 * through. Only the ORM's own compile paths call this.
 *
 * @example
 * markScoped(compileSelect(ast, grammar))
 */
export function markScoped(fragment: SqlFragment): SqlFragment {
  checked.add(fragment)
  return fragment
}

/**
 * Run hand-written SQL that mentions tenant tables, on purpose, with a reason for the audit log.
 *
 * @example
 * await connection.run(unsafeRaw('nightly usage report', sql`SELECT tenant_id, COUNT(*) FROM projects GROUP BY tenant_id`))
 */
export function unsafeRaw(reason: string, fragment: SqlFragment): SqlFragment {
  assertReason(reason)
  ormConfig().onUnsafeTenancy({ kind: 'raw', tables: tenantTablesIn(fragment), reason })
  return markScoped(fragment)
}

/**
 * Validate the reason given to an `unsafe…` bypass (it ends up in the audit log).
 *
 * @example
 * assertReason('nightly report') // ok
 */
export function assertReason(reason: string): void {
  if (reason.trim().length < 3) {
    throw new OrmUsageError(
      'unsafe_reason_required',
      'Tenancy bypasses need a short reason for the audit log, e.g. unsafeWithoutTenancy("nightly usage report").',
    )
  }
}

// The guard every statement passes (installed once, when this module loads).
setStatementGuard((fragment) => {
  if (checked.has(fragment) || tenantColumn() === undefined || currentTenant() === undefined) return
  const tables = tenantTablesIn(fragment)
  const [first] = tables
  if (first !== undefined)
    throw new TenantScopeMissingError(
      first,
      'hand-written SQL that names a tenant table cannot be checked for a tenant condition',
    )
})

/** Tenant (or unscopable) tables a fragment mentions, as an identifier or as a word in its text. */
function tenantTablesIn(fragment: SqlFragment): string[] {
  const sensitive = allTables().filter((table) => tenantMode(table) !== 'global')
  const found = new Set<string>()
  for (const part of fragment.parts) {
    for (const table of sensitive) {
      // Case-insensitive: SQLite (always) and MySQL on Windows/macOS resolve `PROJECTS` to `projects`.
      if (part.kind === 'identifier' && part.name.toLowerCase() === table.toLowerCase())
        found.add(table)
      if (part.kind === 'text' && new RegExp(`\\b${table}\\b`, 'i').test(part.text))
        found.add(table)
    }
  }
  return [...found]
}

function tenantColumnOrThrow(): string {
  const column = tenantColumn()
  if (column === undefined)
    throw new OrmUsageError(
      'tenancy_off',
      'Tenancy is turned off (configureOrm({ tenancy: false })), so there is no tenant column.',
    )
  return column
}

function unscopable(table: string): TenantScopeMissingError {
  return new TenantScopeMissingError(
    table,
    `it has no "${tenantColumn() ?? ''}" column and is not marked global, so tenancy cannot protect it. ` +
      `Add t.tenant() to its migration, or create it with { global: true } if every tenant may see all of it`,
  )
}

/** Fail unless `where` pins `alias.<tenant column>` to the active tenant as a top-level AND. */
function assertScopedBy(table: string, alias: string, where: readonly WhereNode[]): void {
  const mode = tenantMode(table)
  if (mode === 'global') return
  if (mode === 'unscopable') throw unscopable(table)
  const tenant = requireTenant(table)
  const column = tenantColumnOrThrow()
  const pinned = conjuncts(where).some(
    (node) =>
      node.kind === 'compare' &&
      node.operator === '=' &&
      sameColumn(node.column, alias, column) &&
      node.value === tenant,
  )
  if (!pinned)
    throw new TenantScopeMissingError(
      table,
      `the reference "${alias}" has no ${column} = <active tenant> condition`,
    )
}

/**
 * The conditions that must *all* hold: a list joined only by AND, flattening AND-only groups.
 * Anything inside an OR is not a guarantee, so it is not returned.
 */
function conjuncts(nodes: readonly WhereNode[]): WhereNode[] {
  const pureAnd = nodes.every((node, index) => index === 0 || node.conjunction === 'and')
  if (!pureAnd) return []
  const result: WhereNode[] = []
  for (const node of nodes) {
    if (node.kind === 'group') result.push(...conjuncts(node.nodes))
    else result.push(node)
  }
  return result
}

function sameColumn(ref: ColumnRef, alias: string, column: string): boolean {
  return ref.alias === alias && ref.column === column
}

/** Subqueries anywhere in a condition list (EXISTS inside groups included). */
function nestedQueries(nodes: readonly WhereNode[]): SelectAst[] {
  const queries: SelectAst[] = []
  for (const node of nodes) {
    if (node.kind === 'exists') queries.push(node.query)
    if (node.kind === 'group') queries.push(...nestedQueries(node.nodes))
  }
  return queries
}
