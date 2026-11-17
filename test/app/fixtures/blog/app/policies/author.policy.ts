import { hasAdminRole, type Policy } from '../../../../../../src/auth/gate.ts'
import type { AuthUser } from '../../../../../../src/foundation/registry.ts'
import type { Author } from '../models/author.ts'

/** Author profiles are public; creating and editing them is for admins (named export, discovered). */
export class AuthorPolicy implements Policy<Author> {
  before(user: AuthUser | null): boolean | undefined {
    return hasAdminRole(user) ? true : undefined
  }

  viewAny(): boolean {
    return true
  }

  view(): boolean {
    return true
  }
}
