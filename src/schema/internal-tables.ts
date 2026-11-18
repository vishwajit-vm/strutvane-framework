/**
 * Framework and identity tables that never get an automatic API or UI: no resource in
 * `.strutvane/resources.json` (so no sidebar entry), and no auto resource controller (security
 * review F-01). Blueprint §5: "internal tables never get an auto API or UI".
 *
 * The schema flag `{ internal: true }` is the primary rule; this list is the safety net for the
 * tables every Laravel-style app shares, so a migration that forgot the flag (or a package's
 * `CREATE TABLE`) can't expose sessions, tokens or users. An app that wants a screen for one of
 * them writes a purpose-built controller with explicit fields.
 *
 * @module
 */

/**
 * The tables on the safety-net list.
 *
 * @example
 * INTERNAL_TABLES.has('sessions') // true
 */
export const INTERNAL_TABLES: ReadonlySet<string> = new Set([
  'migrations',
  'seeders',
  'users',
  'sessions',
  'cache',
  'cache_locks',
  'jobs',
  'job_batches',
  'failed_jobs',
  'password_reset_tokens',
  'personal_access_tokens',
  'passkeys',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'team_members',
  'team_invitations',
  'teams',
  'audit_events',
  'strutvane_migrations',
])

/**
 * `true` for a table on the list or a `team_*` membership table (whatever the schema says).
 *
 * @example
 * isInternalTable('team_members') // true
 * isInternalTable('posts')        // false
 */
export function isInternalTable(name: string): boolean {
  return INTERNAL_TABLES.has(name) || name.startsWith('team_')
}
