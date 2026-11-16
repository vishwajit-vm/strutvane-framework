/**
 * Small, readable seed helpers for the tests (the product would use factories).
 */
import { Post } from '#app/models/post'
import { Tag } from '#app/models/tag'
import { User } from '#app/models/user'

/**
 * A user with a predictable name and email.
 *
 * @example
 * const ada = await makeUser('Ada')
 */
export function makeUser(name: string): Promise<User> {
  return User.create({ name, email: `${name.toLowerCase()}@example.test`, password: 'not-a-real-secret' })
}

/**
 * A post by `author` (the foreign key is set through the relation, not mass-assigned).
 *
 * @example
 * const post = await makePost(ada, 'Hello', 'published')
 */
export function makePost(author: User, title: string, status: 'draft' | 'published' = 'draft'): Promise<Post> {
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
