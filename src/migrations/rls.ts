/**
 * Row-level security for tenant tables on Postgres, following the five rules of ADR-0007.
 *
 * Two policies per tenant table:
 * - `tenant_isolation`: **RESTRICTIVE**, with `USING` and `WITH CHECK`, reading the tenant with
 *   `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Restrictive policies are AND-ed
 *   with everything else, so no permissive policy added later (an RBAC rule, an "admin" rule)
 *   can ever widen access across tenants. An unset tenant reads as `''` → NULL → zero rows.
 * - `tenant_access`: a permissive `USING (true)` policy. A restrictive policy alone grants
 *   nothing; this is the slot `@strutvane/auth` can replace with RBAC/ABAC policies. Table
 *   privileges (GRANTs) still decide which roles may touch the table at all.
 *
 * `FORCE ROW LEVEL SECURITY` makes the policies apply to the table owner too. The runtime role
 * must still never be a superuser or `BYPASSRLS` (rule 4); {@link tenancyAudit} checks for it.
 *
 * @module
 */

import { ident } from '../database/sql.ts'
import type { Database } from '../database/types.ts'

const TENANT_EXPR = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`

/** Statements that enable tenant isolation on a table. */
export function enableTenantRls(table: string): string[] {
  const t = ident(table)
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "tenant_isolation" ON ${t} AS RESTRICTIVE FOR ALL USING ("tenant_id" = ${TENANT_EXPR}) WITH CHECK ("tenant_id" = ${TENANT_EXPR});`,
    `CREATE POLICY "tenant_access" ON ${t} AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);`,
  ]
}

/** Statements that remove tenant isolation (when a model stops being tenant-scoped). */
export function disableTenantRls(table: string): string[] {
  const t = ident(table)
  return [
    `DROP POLICY IF EXISTS "tenant_access" ON ${t};`,
    `DROP POLICY IF EXISTS "tenant_isolation" ON ${t};`,
    `ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
  ]
}

/** One problem found by {@link tenancyAudit}. */
export interface TenancyFinding {
  readonly table: string
  readonly problem:
    | 'rls-disabled'
    | 'rls-not-forced'
    | 'no-restrictive-policy'
    | 'role-bypasses-rls'
}

/**
 * Audit the connected Postgres database (the basis of `sv doctor`): every table with a
 * `tenant_id` column must have RLS enabled and forced and a restrictive policy, and the current
 * role must not bypass RLS. Returns an empty list when everything is protected.
 */
export async function tenancyAudit(db: Database): Promise<TenancyFinding[]> {
  if (db.dialect !== 'postgres') return []
  const rows = await db.query<{
    table_name: string
    enabled: boolean
    forced: boolean
    restrictive: boolean
  }>(
    `SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive) AS restrictive
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname = current_schema()
      ORDER BY 1`,
  )
  const findings: TenancyFinding[] = []
  for (const r of rows) {
    if (!r.enabled) findings.push({ table: r.table_name, problem: 'rls-disabled' })
    if (!r.forced) findings.push({ table: r.table_name, problem: 'rls-not-forced' })
    if (!r.restrictive) findings.push({ table: r.table_name, problem: 'no-restrictive-policy' })
  }
  const [role] = await db.query<{ bypass: boolean }>(
    'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_catalog.pg_roles WHERE rolname = current_user',
  )
  if (role?.bypass) findings.push({ table: '*', problem: 'role-bypasses-rls' })
  return findings
}
