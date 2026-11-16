import { Model } from '#orm'
import { Post } from '#app/models/post'

/** A tag, shared by many posts. */
export class Tag extends Model('tags', { fillable: ['name'] }) {
  /** Posts with this tag. */
  posts() {
    return this.belongsToMany(Post, 'post_tag')
  }
}
