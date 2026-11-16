import { json, Model, type Scopes } from '#orm'
import { Tag } from '#app/models/tag'
import { User } from '#app/models/user'

/** The shape of the `meta` JSON column, declared once and checked by the compiler everywhere. */
export interface PostMeta {
  readonly tags: readonly string[]
  readonly pinned?: boolean
}

/** A blog post: slug from the title, soft deletes, JSON meta, an author and tags. */
export class Post extends Model('posts', {
  fillable: ['title', 'body', 'status', 'published_on', 'meta'],
  casts: { meta: json<PostMeta>() },
}) {
  /** Local scopes: `Post.query().published()`, `Post.query().ofStatus('draft')`. */
  static readonly scopes = {
    published: (query) => query.where('status', 'published'),
    ofStatus: (query, status: 'draft' | 'published') => query.where('status', status),
  } satisfies Scopes<'posts'>

  /** The user who wrote the post. */
  author() {
    return this.belongsTo(User, 'author_id')
  }

  /** Tags, through the post_tag pivot table. */
  tags() {
    return this.belongsToMany(Tag, 'post_tag')
  }

  /** An accessor: plain TypeScript, computed from columns, not stored. */
  get isPublished(): boolean {
    return this.status === 'published'
  }
}

/** The same table seen through a global scope: only published posts, unless the scope is removed. */
export class PublishedPost extends Model('posts', { fillable: ['title'] }) {
  static readonly globalScopes = {
    published: (query) => query.where('status', 'published'),
  } satisfies Scopes<'posts'>
}
