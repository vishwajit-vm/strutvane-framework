/**
 * Type-level tests. `npm test` runs `tsc` first: every `expectTypeOf` must hold and every
 * `@ts-expect-error` line must really be an error, or the run fails before Vitest starts.
 *
 * The checks live in functions that are never called: they exist to be compiled, not run
 * (several of them would rightly throw at runtime).
 */
import { describe, expectTypeOf, test } from 'vitest'
import { type BelongsTo, type HasMany, type JsonOf, Model, type Page } from '#orm'
import { Post, type PostMeta } from '#app/models/post'
import { Project } from '#app/models/project'
import type { Tag } from '#app/models/tag'
import { User } from '#app/models/user'

/** A model that never declared `fillable`. */
class Bare extends Model('tags') {}

async function columnsAndValues(): Promise<void> {
  Post.query().where('status', 'published').where('view_count', '>', 3).whereNull('body').orderBy('created_at', 'desc')
  // @ts-expect-error: no column "titel" (typo)
  Post.query().where('titel', 'x')
  // @ts-expect-error: "archived" is not one of the enum values
  Post.query().where('status', 'archived')
  // @ts-expect-error: view_count is a number
  Post.query().where('view_count', 'many')
  // @ts-expect-error: title is NOT NULL, so comparing it with null is a mistake
  Post.query().where('title', null)
  // @ts-expect-error: unknown sort column
  Post.query().orderBy('popularity')
  // @ts-expect-error: whereIn values must match the column
  Post.query().whereIn('id', ['1'])
  // @ts-expect-error: the primary key of posts is a number
  await Post.find('1')
  await Project.find('0193a0b2-0000-7000-8000-00000000000a')
}

async function pivotKeys(): Promise<void> {
  const project = await Project.findOrFail('0193a0b2-0000-7000-8000-00000000000a')
  await project.labels().attach([1, 2])
  await project.labels().detach([1])
  await project.labels().sync([3])
  // @ts-expect-error: labels have numeric keys
  await project.labels().attach(['1'])
  // @ts-expect-error: an object is not a key
  await project.labels().detach([{ id: 1 }])
  // @ts-expect-error: a list of lists is not a list of keys
  await project.labels().sync([[1]])
  const post = await Post.findOrFail(1)
  // @ts-expect-error: tags have numeric keys, not UUIDs
  await post.tags().attach(['0193a0b2-0000-7000-8000-00000000000a'])
}

async function massAssignment(): Promise<void> {
  await User.create({ name: 'Ada', email: 'ada@example.test' })
  // @ts-expect-error: is_admin is not fillable
  await User.create({ name: 'Ada', email: 'ada@example.test', is_admin: true })
  // @ts-expect-error: name is required
  await User.create({ email: 'ada@example.test' })
  // @ts-expect-error: tenant_id is never fillable, not even with forceCreate
  await Project.forceCreate({ name: 'x', tenant_id: 'y' })
  // @ts-expect-error: a model without `fillable` can't use create() at all (use forceCreate)
  await Bare.create({ name: 'news' })
  await Bare.forceCreate({ name: 'news' })
}

async function resultsAndCasts(): Promise<void> {
  const posts = await Post.query().where('status', 'published').get()
  expectTypeOf(posts).toEqualTypeOf<Post[]>()
  expectTypeOf(await Post.query().first()).toEqualTypeOf<Post | undefined>()
  expectTypeOf(await Post.findOrFail(1)).toEqualTypeOf<Post>()
  const post = await Post.findOrFail(1)
  expectTypeOf(post.title).toEqualTypeOf<string>()
  expectTypeOf(post.status).toEqualTypeOf<'draft' | 'published'>()
  expectTypeOf(post.created_at).toEqualTypeOf<Date | null>()
  // The JSON column has the type declared by the model cast, not a generic JSON value.
  expectTypeOf(post.meta).toEqualTypeOf<PostMeta | null>()
  expectTypeOf(post.isPublished).toEqualTypeOf<boolean>()
  expectTypeOf(await Project.query().paginate(10)).toEqualTypeOf<Page<Project>>()
  // Scopes are typed methods, arguments included.
  await Post.query().published().ofStatus('draft').get()
  // @ts-expect-error: not a valid status for the scope's parameter
  Post.query().ofStatus('archived')
}

async function relations(): Promise<void> {
  const post = await Post.findOrFail(1)
  expectTypeOf(post.author()).toEqualTypeOf<BelongsTo<typeof User>>()
  const user = await User.findOrFail(1)
  expectTypeOf(user.posts()).toEqualTypeOf<HasMany<typeof Post>>()
  const withAuthor = await Post.query().with('author').firstOrFail()
  expectTypeOf(withAuthor.author).toEqualTypeOf<User | null>()
  const deep = await User.query().with('posts.tags').firstOrFail()
  expectTypeOf(deep.posts[0]?.tags).toEqualTypeOf<Tag[] | undefined>()
  expectTypeOf(deep.posts[0]?.title).toEqualTypeOf<string | undefined>()
  const counted = await User.query().withCount('posts').firstOrFail()
  expectTypeOf(counted.posts_count).toEqualTypeOf<number>()
  await User.query().with({ posts: (query) => query.where('status', 'draft') }).get()
  // @ts-expect-error: no relation "autor"
  Post.query().with('autor')
  // @ts-expect-error: save() is a method, not a relation
  Post.query().with('save')
  // @ts-expect-error: the constraint is typed with the related model's columns
  User.query().with({ posts: (query) => query.where('email', 'x') })
  // @ts-expect-error: whereHas constraints are typed too
  User.query().whereHas('posts', (query) => query.where('status', 'archived'))
  // @ts-expect-error: before loading, `author` is the relation method: no N+1 by accident
  post.author.email
}

async function serialization(): Promise<void> {
  const user = await User.findOrFail(1)
  const json = user.toJSON()
  expectTypeOf(json).toEqualTypeOf<JsonOf<User>>()
  expectTypeOf(json).not.toHaveProperty('password')
  expectTypeOf(json.created_at).toEqualTypeOf<string | null>()
  expectTypeOf(json).not.toHaveProperty('posts')
  const post = await Post.query().with('author').firstOrFail()
  const postJson = post.toJSON()
  expectTypeOf(postJson.author).toEqualTypeOf<JsonOf<User> | null>()
  expectTypeOf(postJson).not.toHaveProperty('isPublished')
  // @ts-expect-error: hidden in the type as well as at runtime
  postJson.author?.password
}

describe('types', () => {
  test('the checks in this file compiled (tsc runs before vitest in npm test)', () => {
    expectTypeOf(columnsAndValues).toBeFunction()
    expectTypeOf(massAssignment).toBeFunction()
    expectTypeOf(pivotKeys).toBeFunction()
    expectTypeOf(resultsAndCasts).toBeFunction()
    expectTypeOf(relations).toBeFunction()
    expectTypeOf(serialization).toBeFunction()
  })
})
