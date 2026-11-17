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

/**
 * Statements that enable tenant isolation on a table. `column` is the app's tenant column
 * (`tenant_id`, or `team_id` for teams); v1 models always use `tenant_id`.
 *
 * @example
 * enableTenantRls('projects') // ['ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;', …]
 */
export function enableTenantRls(table: string, column = 'tenant_id'): string[] {
  const t = ident(table)
  const c = ident(column)
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "tenant_isolation" ON ${t} AS RESTRICTIVE FOR ALL USING (${c} = ${TENANT_EXPR}) WITH CHECK (${c} = ${TENANT_EXPR});`,
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

/**
 * A deparsed expression reduced to its tokens: lower case, no whitespace, parentheses or `::text`
 * casts, so `pg_get_expr` output compares equal across Postgres versions' formatting.
 */
function normaliseExpr(expr: string): string {
  return expr
    .toLowerCase()
    .replaceAll('::text', '')
    .replace(/[\s()]/g, '')
}

const TENANT_CHECK = normaliseExpr(`"tenant_id" = ${TENANT_EXPR}`.replaceAll('"', ''))

/**
 * Whether a restrictive policy's `USING` and `WITH CHECK` (joined by a newline) are both exactly
 * the tenant comparison. Matching the whole expression, not a substring, matters: a policy that
 * mentions the tenant setting but ORs anything else in (`… OR true`) isolates nothing.
 */
function isTenantPolicy(expressions: string): boolean {
  const [using = '', check = ''] = expressions.split('\n')
  return normaliseExpr(using) === TENANT_CHECK && normaliseExpr(check) === TENANT_CHECK
}

/** One problem found by {@link tenancyAudit}. */
export interface TenancyFinding {
  /** The table, view or function concerned (`*` for the connection's role). */
  readonly table: string
  readonly problem:
    | 'rls-disabled'
    | 'rls-not-forced'
    | 'no-restrictive-policy'
    | 'tenant-policy-mismatch'
    | 'role-owns-table'
    | 'view-bypasses-rls'
    | 'security-definer-function'
    | 'role-bypasses-rls'
}

/**
 * Audit the connected Postgres database (the basis of `node strut doctor`). Every way tenant isolation is
 * commonly lost is checked, because RLS is only as strong as its weakest path around it:
 *
 * - every table with a `tenant_id` column has RLS **enabled** and **forced**;
 * - it has a **restrictive** policy for all commands whose `USING` and `WITH CHECK` are both
 *   exactly `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
 *   (`tenant-policy-mismatch` otherwise: a restrictive policy on something else, or one that ORs
 *   anything into the comparison, isolates nothing);
 * - the current role does not **own** a tenant table (an owner can `ALTER TABLE … DISABLE ROW
 *   LEVEL SECURITY` or drop the policies) and is neither superuser nor `BYPASSRLS`;
 * - no **view** over a tenant table runs with its owner's rights: views need
 *   `security_invoker = true`, and materialized views never apply RLS at all;
 * - no **`SECURITY DEFINER`** function sits in the schema: it runs as its owner, so a function
 *   owned by a privileged role reads every tenant's rows.
 *
 * Returns an empty list when everything is protected.
 */
export async function tenancyAudit(db: Database): Promise<TenancyFinding[]> {
  if (db.dialect !== 'postgres') return []
  const rows = await db.query<{
    table_name: string
    enabled: boolean
    forced: boolean
    restrictive: boolean
    policies: string[]
    owned: boolean
  }>(
    `SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive) AS restrictive,
            ARRAY(
              SELECT coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || chr(10) ||
                     coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
                FROM pg_catalog.pg_policy p
               WHERE p.polrelid = c.oid AND NOT p.polpermissive AND p.polcmd = '*'
            ) AS policies,
            pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owned
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname = current_schema()
      ORDER BY 1`,
  )
  const [role] = await db.query<{ bypass: boolean }>(
    'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_catalog.pg_roles WHERE rolname = current_user',
  )
  const bypass = role?.bypass === true
  const findings: TenancyFinding[] = []
  for (const r of rows) {
    if (!r.enabled) findings.push({ table: r.table_name, problem: 'rls-disabled' })
    if (!r.forced) findings.push({ table: r.table_name, problem: 'rls-not-forced' })
    if (!r.restrictive) findings.push({ table: r.table_name, problem: 'no-restrictive-policy' })
    else if (!r.policies.some(isTenantPolicy))
      findings.push({ table: r.table_name, problem: 'tenant-policy-mismatch' })
    // A bypassing role is reported once below; ownership adds nothing to that finding.
    if (r.owned && !bypass) findings.push({ table: r.table_name, problem: 'role-owns-table' })
  }
  const views = await db.query<{ view_name: string }>(
    `SELECT DISTINCT v.relname AS view_name
       FROM pg_catalog.pg_class v
       JOIN pg_catalog.pg_namespace n ON n.oid = v.relnamespace
       JOIN pg_catalog.pg_rewrite r ON r.ev_class = v.oid
       JOIN pg_catalog.pg_depend d ON d.objid = r.oid AND d.classid = 'pg_catalog.pg_rewrite'::regclass
       JOIN pg_catalog.pg_class t ON t.oid = d.refobjid AND t.oid <> v.oid
       JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE v.relkind IN ('v', 'm') AND n.nspname = current_schema()
        AND (v.relkind = 'm'
             OR coalesce(array_to_string(v.reloptions, ','), '') !~* 'security_invoker=(true|on|1|yes)')
      ORDER BY 1`,
  )
  for (const v of views) findings.push({ table: v.view_name, problem: 'view-bypasses-rls' })
  const functions = await db.query<{ name: string }>(
    `SELECT p.proname AS name FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname = current_schema()
      ORDER BY 1`,
  )
  for (const f of functions) findings.push({ table: f.name, problem: 'security-definer-function' })
  if (bypass) findings.push({ table: '*', problem: 'role-bypasses-rls' })
  return findings
}
