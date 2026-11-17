import { Model } from '../../../../../../src/database/index.ts'
import { Post } from './post.ts'

/** A tag, shared by many posts. */
export class Tag extends Model('tags', { fillable: ['name'] }) {
  /** Posts with this tag. */
  posts() {
    return this.belongsToMany(Post, 'post_tag')
  }
}
