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
      'INVALID_TENANT_ID',
      `"${tenantId}" is not a valid tenant id. Tenant ids are UUIDs, such as the id of a row in your tenants table.`,
    )
  }
  return storage.run(tenantId.toLowerCase(), fn)
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
