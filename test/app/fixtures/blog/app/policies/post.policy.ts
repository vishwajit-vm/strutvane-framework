import { hasAdminRole, type Policy } from '../../../../../../src/auth/gate.ts'
import type { AuthUser } from '../../../../../../src/foundation/registry.ts'
import type { Constraint } from '../../../../../../src/http/app/resource-model.ts'
import type { Post } from '../models/post.ts'

/**
 * Who may do what with posts. Discovered by name (Post → post.policy.ts, default export). A
 * missing method denies, so `delete` is admin-only through `before()`.
 */
export default class PostPolicy implements Policy<Post> {
  before(user: AuthUser | null): boolean | undefined {
    return hasAdminRole(user) ? true : undefined
  }

  viewAny(): boolean {
    return true
  }

  view(user: AuthUser | null, post: Post): boolean {
    return post.status === 'published' || user?.id === String(post.author_id)
  }

  /** `view` as list conditions: published posts, plus the user's own drafts. */
  viewScope(user: AuthUser | null): Constraint[] {
    const visible: Constraint[] = [{ column: 'status', equals: 'published' }]
    if (user !== null) visible.push({ column: 'author_id', equals: Number(user.id) })
    return [{ anyOf: visible }]
  }

  create(user: AuthUser | null): boolean {
    return user !== null
  }

  update(user: AuthUser | null, post: Post): boolean {
    return user?.id === String(post.author_id)
  }
}
