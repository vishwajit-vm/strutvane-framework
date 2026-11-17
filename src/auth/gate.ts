/**
 * Policies and the gate: Laravel's authorization, with one deliberate change. **A missing policy
 * method denies** (deny by default, blueprint §5.2). `before()` runs first: `true`/`false` decides,
 * `undefined` falls through. Only a literal `true` from a method allows.
 *
 * This is the framework side of authorization (policies for records); roles, permissions and
 * policies compiled to SQL belong to `@strutvane/auth`, which plugs in through the contracts.
 *
 * @module
 */
import { ForbiddenError } from '../core/errors/errors.ts'
import type { AuthUser } from '../foundation/registry.ts'

/**
 * What a policy method may return: allowed or not, now or later.
 *
 * @example
 * const result: PolicyResult = Promise.resolve(true)
 */
export type PolicyResult = boolean | Promise<boolean>

/**
 * The abilities `ResourceController` checks, Laravel's policy vocabulary. Policies may define
 * more (`publish`, `archive`); `authorize()` takes any method name.
 *
 * @example
 * const ability: Ability = 'update'
 */
export type Ability = 'viewAny' | 'view' | 'create' | 'update' | 'delete'

/**
 * A policy for one model. Every method is optional, and an absent one means "deny".
 *
 * @example
 * export class PostPolicy implements Policy<Post> {
 *   viewAny() { return true }
 *   update(user: AuthUser | null, post: Post) { return user?.id === post.author_id }
 * }
 */
export interface Policy<TModel> {
  before?(user: AuthUser | null, ability: string): boolean | undefined
  viewAny?(user: AuthUser | null): PolicyResult
  view?(user: AuthUser | null, model: TModel): PolicyResult
  create?(user: AuthUser | null): PolicyResult
  update?(user: AuthUser | null, model: TModel): PolicyResult
  delete?(user: AuthUser | null, model: TModel): PolicyResult
}

/** Abilities that act on one record (the others act on the collection). */
const RECORD_ABILITIES: ReadonlySet<string> = new Set([
  'view',
  'update',
  'delete',
  'restore',
  'forceDelete',
])

/**
 * Decide an ability. Returns `true` only when `before()` says so, or a policy method exists and
 * returns exactly `true`.
 *
 * @example
 * await allows(new PostPolicy(), 'update', user, post) // false for someone else's post
 */
export async function allows<TModel>(
  policy: Policy<TModel>,
  ability: Ability | (string & {}),
  user: AuthUser | null,
  model?: TModel,
): Promise<boolean> {
  const early = policy.before?.(user, ability)
  if (early !== undefined) return early === true
  const method = (policy as Readonly<Record<string, unknown>>)[ability]
  // Own and inherited methods only: never Object.prototype members like `constructor`.
  if (typeof method !== 'function' || ability === 'constructor' || ability in Object.prototype)
    return false
  // A record ability without a record is a programming error, never a reason to allow.
  if (RECORD_ABILITIES.has(ability) && model === undefined) return false
  const result: unknown = await (method as (user: AuthUser | null, model?: TModel) => unknown).call(
    policy,
    user,
    model,
  )
  return result === true
}

/**
 * Why an authorization was denied, kept as the 403's `cause` (logged and shown on the developer
 * error page, never sent to the client).
 *
 * @example
 * error.cause instanceof PolicyDenial
 */
export class PolicyDenial extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyDenial'
  }
}

/**
 * Like {@link allows}, but throws a 403 `forbidden`. Laravel's `$this->authorize()`.
 *
 * @example
 * await authorize(new PostPolicy(), 'delete', ctx.user, post)
 */
export async function authorize<TModel>(
  policy: Policy<TModel>,
  ability: Ability | (string & {}),
  user: AuthUser | null,
  model?: TModel,
): Promise<void> {
  if (await allows(policy, ability, user, model)) return
  const name = policy.constructor.name
  const reason =
    typeof (policy as Readonly<Record<string, unknown>>)[ability] !== 'function'
      ? `${name} has no ${ability}() method, so this is denied (Strutvane denies by default). Add ${ability}(user${RECORD_ABILITIES.has(ability) ? ', model' : ''}) to the policy to allow it.`
      : `${name}.${ability}() did not return true for this user.`
  throw new ForbiddenError({ cause: new PolicyDenial(reason) })
}

/**
 * `true` when the user is an admin: an `is_admin` flag set to true, or `'admin'` in a `roles`
 * list (the contracts' `Actor.roles`). Generated policies use it in `before()`; apps with a real
 * role system replace it.
 *
 * @example
 * hasAdminRole({ id: '1', type: 'user', roles: ['admin'], attrs: {} }) // true
 */
export function hasAdminRole(user: AuthUser | null): boolean {
  if (user === null || typeof user !== 'object') return false
  if ('is_admin' in user && user.is_admin === true) return true
  return 'roles' in user && Array.isArray(user.roles) && user.roles.includes('admin')
}
