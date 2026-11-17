/**
 * Relations: eager loading without N+1 (proved by counting queries), nesting, constraints,
 * withCount, whereHas, lazy-loading prevention, relation writes, and the guard that stops a
 * relation name from calling an arbitrary model method.
 */
import { describe, expect, test } from 'vitest'
import {
  configureOrm,
  LazyLoadingError,
  loadMany,
  OrmUsageError,
} from '../../../src/database/index.ts'
import { Post } from './fixtures/app/models/post.ts'
import { User } from './fixtures/app/models/user.ts'
import { type Engine, engines, engineTitle, useEngine } from './support/engines.ts'
import { makePost, makeTag, makeUser } from './support/seed.ts'

/** Run `fn` and return how many SQL statements it sent. */
async function countQueries(
  connection: () => import('../../../src/database/index.ts').Connection,
  fn: () => Promise<unknown>,
): Promise<number> {
  let count = 0
  const stop = connection().onQuery(() => {
    count += 1
  })
  try {
    await fn()
  } finally {
    stop()
  }
  return count
}

/** Three authors with two posts each, every post tagged with two tags. */
async function seedBlog(): Promise<void> {
  const news = await makeTag('news')
  const tech = await makeTag('tech')
  for (const name of ['Ada', 'Grace', 'Linus']) {
    const author = await makeUser(name)
    for (const title of [`${name} one`, `${name} two`]) {
      const post = await makePost(author, title, title.endsWith('one') ? 'published' : 'draft')
      await post.tags().attach([news.id, tech.id])
    }
  }
}

function suite(engine: Engine): void {
  const connection = useEngine(engine)

  test('belongsTo eager loading: 6 posts and their authors in exactly 2 queries', async () => {
    await seedBlog()
    let posts: Awaited<ReturnType<typeof loadPostsWithAuthor>> = []
    const queries = await countQueries(connection, async () => {
      posts = await loadPostsWithAuthor()
    })
    expect(queries).toBe(2)
    expect(posts).toHaveLength(6)
    for (const post of posts) expect(post.author?.name).toBe(post.title.split(' ')[0])
  })

  test('the N+1 it replaces: loading one by one costs 1 + N queries (and is refused by default)', async () => {
    await seedBlog()
    configureOrm({ preventLazyLoading: false })
    try {
      const queries = await countQueries(connection, async () => {
        const posts = await Post.query().get()
        for (const post of posts) await post.load('author')
      })
      expect(queries).toBe(7)
    } finally {
      configureOrm({ preventLazyLoading: true })
    }
    const posts = await Post.query().get()
    const [first] = posts
    await expect(first?.load('author')).rejects.toBeInstanceOf(LazyLoadingError)
  })

  test('a single model may load lazily; a list loads with loadMany in one query', async () => {
    await seedBlog()
    const one = await Post.query().where('title', 'Ada one').firstOrFail()
    const loaded = await one.load('author')
    expect(loaded.author?.name).toBe('Ada')
    const posts = await Post.query().get()
    const queries = await countQueries(connection, () => loadMany(posts, 'author'))
    expect(queries).toBe(1)
  })

  test('hasMany + nested belongsToMany: users → posts → tags in 3 queries', async () => {
    await seedBlog()
    let users: Awaited<ReturnType<typeof loadUsersDeep>> = []
    const queries = await countQueries(connection, async () => {
      users = await loadUsersDeep()
    })
    expect(queries).toBe(3)
    expect(users.map((user) => user.posts.length)).toEqual([2, 2, 2])
    for (const user of users)
      for (const post of user.posts)
        expect(post.tags.map((tag) => tag.name).sort()).toEqual(['news', 'tech'])
  })

  test('constrained eager loading only loads matching related rows', async () => {
    await seedBlog()
    const users = await User.query()
      .with({ posts: (query) => query.where('status', 'published') })
      .orderBy('name')
      .get()
    expect(users.map((user) => user.posts.map((post) => post.title))).toEqual([
      ['Ada one'],
      ['Grace one'],
      ['Linus one'],
    ])
  })

  test('withCount adds <relation>_count in the same query', async () => {
    await seedBlog()
    const ada = await makeUser('Zed')
    let users: Awaited<ReturnType<typeof countPosts>> = []
    const queries = await countQueries(connection, async () => {
      users = await countPosts()
    })
    expect(queries).toBe(1)
    expect(users.map((user) => [user.name, user.posts_count])).toEqual([
      ['Ada', 2],
      ['Grace', 2],
      ['Linus', 2],
      [ada.name, 0],
    ])
    const tagged = await Post.query().withCount('tags').orderBy('id').first()
    expect(tagged?.tags_count).toBe(2)
  })

  test('withCount and whereHas respect the related model scopes (soft-deleted posts do not count)', async () => {
    await seedBlog()
    const ada = await User.query().where('name', 'Ada').firstOrFail()
    for (const post of await ada.posts().get()) await post.delete()
    const counts = await User.query().withCount('posts').orderBy('name').get()
    expect(counts.map((user) => user.posts_count)).toEqual([0, 2, 2])
    const withPosts = await User.query().whereHas('posts').orderBy('name').get()
    expect(withPosts.map((user) => user.name)).toEqual(['Grace', 'Linus'])
  })

  test('whereHas with a constraint compiles to EXISTS and loads nothing', async () => {
    await seedBlog()
    const draftless = await makeUser('Nobody')
    await makePost(draftless, 'Only published', 'published')
    const usersWithDrafts = await User.query()
      .whereHas('posts', (query) => query.where('status', 'draft'))
      .orderBy('name')
      .get()
    expect(usersWithDrafts.map((user) => user.name)).toEqual(['Ada', 'Grace', 'Linus'])
    expect(User.query().whereHas('posts').toSql().sql).toMatch(/EXISTS \(SELECT/)
  })

  test('orWhere never widens a relation past its parent (every relation path)', async () => {
    await seedBlog()
    const ada = await User.query().where('name', 'Ada').firstOrFail()
    const grace = await User.query().where('name', 'Grace').firstOrFail()
    const either = (query: ReturnType<typeof ada.posts>) =>
      query.where('title', 'nothing').orWhere('status', 'draft')
    // hasMany query: only Ada's drafts, never Grace's or Linus's.
    expect((await either(ada.posts()).get()).map((post) => post.title)).toEqual(['Ada two'])
    // belongsTo query.
    const graceOne = await Post.query().where('title', 'Grace one').firstOrFail()
    const authors = await graceOne.author().where('name', 'nothing').orWhere('name', 'Ada').get()
    expect(authors).toEqual([])
    // belongsToMany query: only this post's tags.
    const tags = await graceOne.tags().where('name', 'nothing').orWhere('name', 'news').get()
    expect(tags.map((tag) => tag.name)).toEqual(['news'])
    const untagged = await makePost(grace, 'Grace untagged', 'draft')
    expect(await untagged.tags().where('name', 'x').orWhere('name', 'news').count()).toBe(0)
    // Constrained eager loading: each user still gets only their own posts.
    const users = await User.query()
      .with({ posts: (query) => query.where('title', 'nothing').orWhere('status', 'draft') })
      .orderBy('name')
      .get()
    expect(users.map((user) => user.posts.map((post) => post.title).sort())).toEqual([
      ['Ada two'],
      ['Grace two', 'Grace untagged'],
      ['Linus two'],
    ])
    // whereHas: the correlation survives the OR (withCount builds the same correlated subquery).
    const nobody = await makeUser('Nobody')
    const having = await User.query()
      .whereHas('posts', (query) => query.where('title', 'nothing').orWhere('status', 'draft'))
      .orderBy('name')
      .get()
    expect(having.map((user) => user.name)).toEqual(['Ada', 'Grace', 'Linus'])
    expect(having.map((user) => user.id)).not.toContain(nobody.id)
    // A cursor page stays a seek even when the query ends in orWhere.
    const page = await Post.query()
      .where('status', 'published')
      .orWhere('status', 'draft')
      .orderBy('id')
      .cursorPaginate(2)
    const next = await Post.query()
      .where('status', 'published')
      .orWhere('status', 'draft')
      .orderBy('id')
      .cursorPaginate(2, page.nextCursor ?? undefined)
    const firstIds = page.data.map((post) => post.id)
    for (const post of next.data) expect(firstIds).not.toContain(post.id)
  })

  test('relation queries: user.posts() is a scoped query; create sets the foreign key', async () => {
    await seedBlog()
    const ada = await User.query().where('name', 'Ada').firstOrFail()
    expect(await ada.posts().count()).toBe(2)
    expect((await ada.posts().published().get()).map((post) => post.title)).toEqual(['Ada one'])
    const created = await ada.posts().create({ title: 'Ada three' })
    expect(created.author_id).toBe(ada.id)
    const author = await created.author().first()
    expect(author?.id).toBe(ada.id)
  })

  test('belongsToMany attach is idempotent, detach and sync converge on the wanted set', async () => {
    const ada = await makeUser('Ada')
    const post = await makePost(ada, 'Tagged')
    const [a, b, c] = [await makeTag('a'), await makeTag('b'), await makeTag('c')]
    await post.tags().attach([a.id, b.id])
    await post.tags().attach([a.id]) // retry-safe
    expect((await post.tags().get()).map((tag) => tag.name).sort()).toEqual(['a', 'b'])
    expect(await post.tags().sync([b.id, c.id])).toEqual({ attached: 1, detached: 1 })
    expect((await post.tags().get()).map((tag) => tag.name).sort()).toEqual(['b', 'c'])
    expect(await post.tags().detach()).toBe(2)
  })

  test('a relation name can never invoke a built-in or non-relation method', async () => {
    await seedBlog()
    const before = await Post.query().count()
    // What `?include=delete` would do if a controller passed request input straight through.
    for (const name of [
      'delete',
      'save',
      'forceDelete',
      'constructor',
      'toJSON',
      'isPublished',
      'nope',
    ]) {
      expect(() => Reflect.apply(Post.query().with, Post.query(), [name])).toThrow(OrmUsageError)
    }
    expect(await Post.query().count()).toBe(before)
    expect(() => Reflect.apply(Post.query().with, Post.query(), ['autor'])).toThrow(
      /Did you mean "author"\?/,
    )
  })

  test('loaded relations serialise nested, with hidden fields removed at every level', async () => {
    await seedBlog()
    const post = await Post.query().with('author').where('title', 'Ada one').firstOrFail()
    const json = JSON.parse(JSON.stringify(post))
    expect(json.author.name).toBe('Ada')
    expect(json.author).not.toHaveProperty('password')
  })
}

function loadPostsWithAuthor() {
  return Post.query().with('author').orderBy('id').get()
}

function loadUsersDeep() {
  return User.query().with('posts.tags').orderBy('name').get()
}

function countPosts() {
  return User.query().withCount('posts').orderBy('id').get()
}

describe.each(engines)('relations on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => suite(engine))
})
