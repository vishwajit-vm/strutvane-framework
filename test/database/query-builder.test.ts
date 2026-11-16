/**
 * The query builder: conditions, NULL semantics, ordering, scopes, request-driven
 * search/filter/sort, raw SQL, injection attempts and pagination, on every engine.
 */
import { describe, expect, test } from 'vitest'
import { configureOrm, OrmUsageError, sql } from '#orm'
import { Post, PublishedPost } from '#app/models/post'
import { User } from '#app/models/user'
import { type Engine, engines, engineTitle, useEngine } from './support/engines.ts'
import { makePost, makeUser } from './support/seed.ts'

/** Titles of a list of posts, for readable assertions. */
const titles = (posts: readonly { readonly title: string }[]): string[] => posts.map((post) => post.title)

async function seedPosts(): Promise<void> {
  const ada = await makeUser('Ada')
  const grace = await makeUser('Grace')
  await makePost(ada, 'Alpha', 'published')
  await makePost(ada, 'Beta', 'draft')
  await makePost(grace, 'Gamma', 'published')
  await makePost(grace, 'Delta 100%', 'draft')
  // Give one post an empty optional column and another a value, to test NULL semantics.
  const alpha = await Post.query().where('title', 'Alpha').firstOrFail()
  alpha.body = 'has a body'
  await alpha.save()
}

function suite(engine: Engine): void {
  useEngine(engine)

  test('where / orWhere / whereIn / whereNull / orderBy / limit / offset', async () => {
    await seedPosts()
    expect(titles(await Post.where('status', 'published').orderBy('title').get())).toEqual(['Alpha', 'Gamma'])
    expect(titles(await Post.query().where('title', 'Alpha').orWhere('title', 'Beta').orderBy('title', 'desc').get())).toEqual(['Beta', 'Alpha'])
    expect(titles(await Post.query().whereIn('title', ['Gamma', 'Alpha', 'Nope']).orderBy('title').get())).toEqual(['Alpha', 'Gamma'])
    expect(titles(await Post.query().whereIn('title', []).get())).toEqual([])
    expect(titles(await Post.query().whereNotNull('body').get())).toEqual(['Alpha'])
    expect(await Post.query().whereNull('body').count()).toBe(3)
    expect(titles(await Post.query().orderBy('title').limit(2).offset(1).get())).toEqual(['Beta', 'Delta 100%'])
    expect(titles(await Post.query().orderBy('title').offset(3).get())).toEqual(['Gamma'])
    expect(titles(await Post.query().where('view_count', '>=', 0).where('id', '>', 0).orderBy('title').limit(1).get())).toEqual(['Alpha'])
  })

  test('grouped conditions keep their parentheses', async () => {
    await seedPosts()
    const rows = await Post.query()
      .where('status', 'published')
      .where((query) => query.where('title', 'Alpha').orWhere('title', 'Beta'))
      .get()
    expect(titles(rows)).toEqual(['Alpha'])
  })

  test('!= and whereNotIn are NULL-safe: rows with NULL match, like JavaScript !==', async () => {
    await seedPosts()
    // body is NULL for Beta, Gamma and Delta. Plain SQL `body <> 'has a body'` would drop them all.
    expect(titles(await Post.query().where('body', '!=', 'has a body').orderBy('title').get())).toEqual(['Beta', 'Delta 100%', 'Gamma'])
    expect(await Post.query().whereNotIn('body', ['has a body']).count()).toBe(3)
    expect(await Post.query().where('body', null).count()).toBe(3)
    expect(await Post.query().where('body', '!=', null).count()).toBe(1)
  })

  test('local scopes become builder methods, with arguments', async () => {
    await seedPosts()
    expect(titles(await Post.query().published().orderBy('title').get())).toEqual(['Alpha', 'Gamma'])
    expect(titles(await Post.query().ofStatus('draft').orderBy('title').get())).toEqual(['Beta', 'Delta 100%'])
  })

  test('global scopes apply automatically, wrap OR conditions, and can be removed by name', async () => {
    await seedPosts()
    expect(titles(await PublishedPost.query().orderBy('title').get())).toEqual(['Alpha', 'Gamma'])
    // Without parentheses this would be `title = Beta OR title = Alpha AND status = published` → Beta leaks.
    expect(titles(await PublishedPost.query().where('title', 'Beta').orWhere('title', 'Alpha').get())).toEqual(['Alpha'])
    expect(await PublishedPost.query().withoutGlobalScope('published').count()).toBe(4)
    expect(() => PublishedPost.query().withoutGlobalScope('nope')).toThrow(OrmUsageError)
  })

  test('request-driven search, filter and sort (the ResourceController surface)', async () => {
    await seedPosts()
    // Literal search: "%" is a character, not a wildcard; matching is case-insensitive everywhere.
    expect(titles(await Post.query().search('100%', ['title', 'body']).get())).toEqual(['Delta 100%'])
    expect(titles(await Post.query().search('ALP', ['title']).get())).toEqual(['Alpha'])
    expect(await Post.query().search('%', ['title']).count()).toBe(1)
    expect(await Post.query().search('_', ['title']).count()).toBe(0)
    expect(titles(await Post.query().filter('status', 'in', ['draft']).sort('-title').get())).toEqual(['Delta 100%', 'Beta'])
    expect(titles(await Post.query().filter('title', 'startsWith', 'ga').get())).toEqual(['Gamma'])
    expect(await Post.query().filter('body', 'null', true).count()).toBe(3)
    expect(await Post.query().filter('view_count', 'gte', 0).filter('status', 'ne', 'draft').count()).toBe(2)
  })

  test('request input can never become SQL: unknown columns, operators and directions are refused', async () => {
    await seedPosts()
    const hostile = ['title; DROP TABLE posts', 'title"', 'title`', 'posts.title', '1=1']
    for (const column of hostile) {
      expect(() => Post.query().sort(column)).toThrow(OrmUsageError)
      expect(() => Post.query().filter(column, 'eq', 'x')).toThrow(OrmUsageError)
      expect(() => Post.query().search('x', [column])).toThrow(OrmUsageError)
    }
    expect(() => Reflect.apply(Post.query().where, Post.query(), ['title', 'LIKE', '%'])).toThrow(/not a supported operator/)
    expect(() => Reflect.apply(Post.query().orderBy, Post.query(), ['title', 'asc; DROP TABLE posts'])).toThrow(/must be "asc" or "desc"/)
    expect(() => Reflect.apply(Post.query().filter, Post.query(), ['title', 'regex', '.*'])).toThrow(/not a filter operator/)
    // Hostile *values* are just data.
    const payload = "x' OR '1'='1"
    expect(await Post.query().where('title', payload).count()).toBe(0)
    expect(await Post.query().search(payload, ['title']).count()).toBe(0)
    expect(await Post.query().count()).toBe(4)
  })

  test('in-lists are capped (default 1,000, configurable) with a friendly error before any SQL', async () => {
    // filter[id][in]=1,2,…,100000 became one statement with 100,000 placeholders: over SQLite's
    // and PostgreSQL's parameter limits (a 500) and heavy for MySQL. The cap is checked first.
    const many = Array.from({ length: 1001 }, (_, index) => index + 1)
    for (const attempt of [() => Post.query().whereIn('id', many), () => Post.query().whereNotIn('id', many), () => Post.query().filter('id', 'in', many)]) {
      expect(attempt).toThrow(OrmUsageError)
      expect(attempt).toThrow(/at most 1000 values/)
    }
    expect(await Post.query().whereIn('id', many.slice(0, 1000)).count()).toBe(0)
    try {
      configureOrm({ maxInValues: 2 })
      expect(() => Post.query().filter('id', 'in', [1, 2, 3])).toThrow(/at most 2 values/)
      expect(await Post.query().filter('id', 'in', [1, 2]).count()).toBe(0)
    } finally {
      configureOrm({ maxInValues: 1000 })
    }
  })

  test('case-insensitive search folds non-ASCII letters on every engine (SQLite included)', async () => {
    // SQLite's built-in lower() only folds A-Z, so 'émile' never found 'Émile' there while
    // PostgreSQL and MySQL did. The SQLite driver now registers a Unicode-aware lower().
    for (const name of ['Émile Zola', 'Жанна Öberg']) await makeUser(name.replace(/\s.*/, '')).then((user) => user.fill({ name }).save())
    expect(await User.query().search('émile', ['name']).count()).toBe(1)
    expect(await User.query().search('ZOLA', ['name']).count()).toBe(1)
    expect(await User.query().filter('name', 'contains', 'ÖBERG').count()).toBe(1)
    expect(await User.query().filter('name', 'startsWith', 'жан').count()).toBe(1)
    expect(await User.query().filter('name', 'startsWith', 'ÉMI').count()).toBe(1)
  })

  test('hidden columns are never filterable, sortable or searchable, and never named in hints', async () => {
    const ada = await makeUser('Ada')
    expect(ada.toJSON()).not.toHaveProperty('password')
    // Request-driven methods: a hidden column answers exactly like a column that doesn't exist,
    // so filter[password][startsWith]=a can't extract it one character at a time (F-03, F-13).
    const attempts: readonly [string, () => unknown][] = [
      ['filter startsWith', () => User.query().filter('password', 'startsWith', 'n')],
      ['filter eq', () => User.query().filter('password', 'eq', 'not-a-real-secret')],
      ['filter null', () => User.query().filter('password', 'null', false)],
      ['sort', () => User.query().sort('-password')],
      ['search', () => User.query().search('secret', ['name', 'password'])],
      ['whereContains', () => User.query().whereContains('password', 'x')],
      ['whereStartsWith', () => User.query().whereStartsWith('password', 'x')],
    ]
    const nowhere = (() => {
      try {
        User.query().filter('nowhere', 'eq', 'x')
      } catch (error) {
        return error
      }
      return undefined
    })()
    for (const [label, attempt] of attempts) {
      let thrown: unknown
      try {
        attempt()
      } catch (error) {
        thrown = error
      }
      expect(thrown, label).toBeInstanceOf(OrmUsageError)
      expect((thrown as OrmUsageError).code, label).toBe((nowhere as OrmUsageError).code)
      expect((thrown as Error).message, label).not.toMatch(/Did you mean/)
    }
    // Typos never suggest a hidden column, in queries or in mass assignment.
    for (const typo of [() => User.query().sort('passwor'), () => User.query().filter('pasword', 'eq', 'x'), () => User.make().fill(JSON.parse('{"passwrd": "x"}'))]) {
      expect(typo).toThrow()
      expect(() => typo()).not.toThrow(/password/)
    }
    // Trusted, typed code may still use it (e.g. a login lookup by a token column).
    expect(await User.query().where('password', 'not-a-real-secret').count()).toBe(1)
  })

  test('raw SQL only through the sql tag, values always bound', async () => {
    await seedPosts()
    const minimum = 5
    const rows = await Post.query()
      .whereRaw(sql`length(${sql.id('title')}) >= ${minimum}`)
      .orderBy('title')
      .get()
    expect(titles(rows)).toEqual(['Alpha', 'Delta 100%', 'Gamma'])
    const rendered = Post.query().whereRaw(sql`${sql.id('title')} = ${"'; DROP TABLE posts; --"}`).toSql()
    expect(rendered.sql).not.toContain('DROP TABLE')
    expect(rendered.params).toContain("'; DROP TABLE posts; --")
    expect(() => Reflect.apply(Post.query().whereRaw, Post.query(), ["1=1; DROP TABLE posts"])).toThrow(/needs a sql`…` fragment/)
    expect(() => Reflect.apply(sql, undefined, [['SELECT 1']])).toThrow(/tagged template/)
    expect(() => sql.id('posts; DROP TABLE users')).toThrow(OrmUsageError)
  })

  test('pagination: offset with totals, and validation of page sizes', async () => {
    await seedPosts()
    const page = await Post.query().orderBy('title').paginate(3, 2)
    expect(page).toMatchObject({ total: 4, perPage: 3, currentPage: 2, lastPage: 2 })
    expect(titles(page.data)).toEqual(['Gamma'])
    const empty = await Post.query().where('title', 'Nope').paginate(10)
    expect(empty).toMatchObject({ total: 0, lastPage: 1, data: [] })
    await expect(Post.query().paginate(0)).rejects.toThrow(/between 1 and 100/)
    await expect(Post.query().paginate(10, 0)).rejects.toThrow(/start at 1/)
  })

  test('pagination: cursors walk every row exactly once, even with equal sort values', async () => {
    const ada = await makeUser('Ada')
    for (let index = 0; index < 7; index += 1) await makePost(ada, `Post ${index}`, index % 2 === 0 ? 'published' : 'draft')
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      // Sorting by status has many ties: the id tie-breaker keeps pages disjoint.
      const page = await Post.query().orderBy('status', 'desc').cursorPaginate(3, cursor)
      seen.push(...titles(page.data))
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  test('pagination: tampered or mismatched cursors and nullable sort columns are refused', async () => {
    await seedPosts()
    const first = await Post.query().orderBy('title').cursorPaginate(2)
    const cursor = first.nextCursor ?? ''
    await expect(Post.query().orderBy('title', 'desc').cursorPaginate(2, cursor)).rejects.toThrow(/different sort order/)
    await expect(Post.query().orderBy('title').cursorPaginate(2, `${cursor}x`)).rejects.toThrow(OrmUsageError)
    const forged = Buffer.from(JSON.stringify({ f: 'posts:title:asc,id:asc', v: [{ $gt: '' }, 1] })).toString('base64url')
    await expect(Post.query().orderBy('title').cursorPaginate(2, forged)).rejects.toThrow(/invalid/)
    await expect(Post.query().orderBy('body').cursorPaginate(2)).rejects.toThrow(/can be NULL/)
  })

  test('typos in column names get a suggestion', () => {
    expect(() => Reflect.apply(User.query().where, User.query(), ['emial', 'x'])).toThrow(/Did you mean "email"\?/)
  })
}

describe.each(engines)('query builder on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => suite(engine))
})
