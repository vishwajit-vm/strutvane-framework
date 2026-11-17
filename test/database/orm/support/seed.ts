/**
 * Small, readable seed helpers for the tests (the product would use factories).
 */
import type { Post } from '../fixtures/app/models/post.ts'
import { Tag } from '../fixtures/app/models/tag.ts'
import { User } from '../fixtures/app/models/user.ts'

/**
 * A user with a predictable name and email.
 *
 * @example
 * const ada = await makeUser('Ada')
 */
export async function makeUser(name: string): Promise<User> {
  // Secrets are never mass-assigned: set them from trusted code (here, the seed).
  const user = new User().fill({ name, email: `${name.toLowerCase()}@example.test` })
  user.forceFill({ password: 'not-a-real-secret', api_token: `token-${name}` })
  await user.save()
  return user
}

/**
 * A post by `author` (the foreign key is set through the relation, not mass-assigned).
 *
 * @example
 * const post = await makePost(ada, 'Hello', 'published')
 */
export function makePost(
  author: User,
  title: string,
  status: 'draft' | 'published' = 'draft',
): Promise<Post> {
  return author.posts().create({ title, status })
}

/**
 * A tag.
 *
 * @example
 * const news = await makeTag('news')
 */
export function makeTag(name: string): Promise<Tag> {
  return Tag.create({ name })
}
