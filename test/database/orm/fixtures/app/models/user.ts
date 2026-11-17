import { cast, Model } from '../../../../../../src/database/index.ts'
import { Post } from './post.ts'

/** Emails are stored trimmed and lower-cased: a custom cast (Laravel's mutator). */
const email = cast<string>({
  get: (stored) => String(stored),
  set: (value) => value.trim().toLowerCase(),
})

/**
 * A user. Columns come from the migrations; this file only adds behaviour.
 * `password`, `api_token`, `backup_phrase` and `internal_note` are hidden by the migration (names
 * like secrets, `.secret()`, `.hidden()`): they never appear in toJSON(), and the JSON type has no
 * such keys, although this model lists no `hidden` of its own.
 */
export class User extends Model('users', {
  fillable: ['name', 'email'],
  casts: { email },
}) {
  /** The posts this user wrote. */
  posts() {
    return this.hasMany(Post, 'author_id')
  }
}
