import { cast, Model } from '#orm'
import { Post } from '#app/models/post'

/** Emails are stored trimmed and lower-cased: a custom cast (Laravel's mutator). */
const email = cast<string>({
  get: (stored) => String(stored),
  set: (value) => value.trim().toLowerCase(),
})

/**
 * A user. Columns come from the migrations; this file only adds behaviour.
 * `password` is hidden: it never appears in toJSON(), and the JSON type has no such key.
 */
export class User extends Model('users', {
  fillable: ['name', 'email', 'password'],
  hidden: ['password'],
  casts: { email },
}) {
  /** The posts this user wrote. */
  posts() {
    return this.hasMany(Post, 'author_id')
  }
}
