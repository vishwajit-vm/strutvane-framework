/**
 * The active tenant, carried with the async call chain.
 *
 * The HTTP layer resolves the tenant once per request and wraps the handler in
 * {@link runWithTenant}; every model call below it is scoped automatically. Nothing in app code
 * passes tenant ids around, so nothing in app code can pass the wrong one.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { OrmUsageError } from './errors.ts'

const storage = new AsyncLocalStorage<string>()
/**
 * The reason work runs with no tenant on purpose (a console command, migrations, seeders), or
 * `undefined`. Kept apart from the tenant id: a tenant inside such a scope is still a tenant.
 */
const tenantFree = new AsyncLocalStorage<string | undefined>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Run `fn` as tenant `tenantId`. The id must be a UUID (ADR-0007 rule 5): it ends up in
 * `set_config`, and a malformed id should fail here, loudly, not deep inside Postgres.
 *
 * @example
 * await runWithTenant(acme.id, () => Project.query().get())
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  if (!UUID.test(tenantId)) {
    throw new OrmUsageError(
      'invalid_tenant_id',
      `"${tenantId}" is not a valid tenant id. Tenant ids are UUIDs, such as the id of a row in your tenants table.`,
    )
  }
  return storage.run(tenantId.toLowerCase(), fn)
}

/**
 * Internal: run `fn` in a scope where hand-written SQL may name tenant tables with no tenant
 * active. Apps call `runWithoutTenant(reason, fn)` (tenant-scope.ts), which checks the reason
 * and reports it; this is only the storage.
 *
 * @example
 * enterTenantFreeScope('migrations', () => runner())
 */
export function enterTenantFreeScope<T>(reason: string, fn: () => T): T {
  return tenantFree.run(reason, fn)
}

/**
 * Internal: run `fn` with no tenant-free scope, whatever the caller had. Every HTTP request
 * starts here, so a server started by a console command (`node strut serve`) never hands that
 * command's scope to the requests it serves.
 *
 * @example
 * leaveTenantFreeScope(() => handle(request))
 */
export function leaveTenantFreeScope<T>(fn: () => T): T {
  return tenantFree.run(undefined, fn)
}

/**
 * The reason of the enclosing tenant-free scope, or `undefined` when there is none.
 *
 * @example
 * tenantFreeReason() // 'node strut migrate' inside a migration run
 */
export function tenantFreeReason(): string | undefined {
  return tenantFree.getStore()
}

/**
 * The active tenant id, or `undefined` outside a tenant context.
 *
 * @example
 * currentTenant() // '0190…' inside runWithTenant, undefined outside
 */
export function currentTenant(): string | undefined {
  return storage.getStore()
}
