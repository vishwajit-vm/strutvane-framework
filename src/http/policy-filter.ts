/**
 * The row filter an actor's action is limited to: the one place that turns a PermissionProvider
 * filter into a bound filter, shared by the CRUD routes and custom routes (`scopeFor`) so the two
 * can never apply different rules.
 *
 * - The provider's filter for `<model>.<action>` is ANDed with whatever the
 *   `resource.beforeQuery` hook returns: a hook can only narrow the policy, never replace or widen
 *   it (a buggy or hostile hook returning `{ op: 'true' }` changes nothing).
 * - Policy filters are trusted code, so any operator a field supports may be used.
 * - A policy that cannot be bound (an unknown field, an actor attribute the identity provider did
 *   not set) is a server bug: it fails closed as a plain `Error` (500, logged), never as a client
 *   validation problem that would blame the caller and name the policy's fields.
 *
 * @module
 */
import type { Actor, PermissionProvider, QueryFilter } from '../contracts/index.ts'
import type { HookRegistry } from '../core/index.ts'
import type { ModelDefinition } from '../model/define-model.ts'
import { andAll, type BoundFilter, bindFilter } from '../query/bind.ts'
import { queryFields } from '../query/fields.ts'
import { permissionFor } from './permissions.ts'

/** What {@link policyFilterFor} needs. */
export interface PolicyFilterDeps {
  readonly permissions: PermissionProvider
  readonly hooks: HookRegistry<Record<string, unknown>>
}

/** The bound row filter for `actor` performing `<target>.<action>` (e.g. `view`, `update`). */
export async function policyFilterFor(
  deps: PolicyFilterDeps,
  target: ModelDefinition,
  actor: Actor | null,
  action: string,
): Promise<BoundFilter> {
  const raw = await deps.permissions.filterFor(
    actor,
    permissionFor(target.permission, action),
    target.permission,
  )
  const hooked = (await deps.hooks.run('resource.beforeQuery', {
    resource: target.name,
    action,
    actor,
    filter: raw,
  })) as { filter?: QueryFilter } | undefined
  const extra = hooked?.filter
  try {
    const options = { fields: queryFields(target), operators: 'any' as const, actor }
    const policy = bindFilter(raw, options)
    if (extra === undefined || extra === raw) return policy
    return andAll([policy, bindFilter(extra, options)])
  } catch (error) {
    // Not the client's fault: surface as a 500 (logged), never as a 4xx the client could probe.
    throw new Error(`Invalid policy filter for ${target.name}.${action}`, { cause: error })
  }
}
