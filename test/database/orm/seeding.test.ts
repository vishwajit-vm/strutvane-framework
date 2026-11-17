/**
 * Factories, seeders and policy scopes on the ORM, on every engine: `defineFactory` (count,
 * state, for, has, recycle, seed, raw, foreign-key factories), `runSeeders` (once per run, one
 * transaction, inside a tenant), `Builder.wherePolicy` (ADR-0008 through the grammar), and the
 * tenancy switch failing closed (#90).
 */
import { describe, expect, test } from 'vitest'
import {
  configureOrm,
  createFaker,
  defineFactory,
  defineSeeder,
  OrmUsageError,
  runSeeders,
  runWithTenant,
  seederNameForFile,
} from '../../../src/entries/database.ts'
import { Post } from './fixtures/app/models/post.ts'
import { Project } from './fixtures/app/models/project.ts'
import { User } from './fixtures/app/models/user.ts'
import { engines, engineTitle, useEngine } from './support/engines.ts'

const TENANT = '0193a0b2-7c1e-7d4f-8a9b-0c1d2e3f4a5b'
const OTHER = '0193a0b2-7c1e-7d4f-8a9b-0c1d2e3f4a5c'

const UserFactory = defineFactory(User, ({ faker, sequence }) => ({
  name: `${faker.firstName()} ${sequence}`,
  email: faker.email(),
}))
const PostFactory = defineFactory(Post, ({ faker }) => ({
  title: faker.sentence(),
  status: faker.pick(['draft', 'published'] as const),
  author_id: UserFactory,
}))
const ProjectFactory = defineFactory(Project, ({ faker }) => ({
  name: faker.words(2),
  budget: faker.decimal({ max: 500 }),
}))

describe('faker', () => {
  test('a seed reproduces the values; values fit common column rules', () => {
    const a = createFaker(7)
    const b = createFaker(7)
    expect([a.word(), a.sentence(), a.number({ min: 1, max: 9 })]).toEqual([
      b.word(),
      b.sentence(),
      b.number({ min: 1, max: 9 }),
    ])
    const f = createFaker(1)
    expect(f.email()).toMatch(/^[a-z]+\.[a-z]+\d+\.\d{3}@example\.com$/)
    expect(f.decimal({ min: 1, max: 2, scale: 3 })).toMatch(/^[12]\.\d{3}$/)
    expect(f.date()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(f.pastDate({ days: 1 }).getTime()).toBeLessThanOrEqual(Date.now())
    expect(f.paragraph().split('.').length).toBeGreaterThan(2)
    expect(f.uuid()).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof f.boolean()).toBe('boolean')
    expect(f.name()).toContain(' ')
    expect(f.lastName().length).toBeGreaterThan(1)
    expect(f.words(4).split(' ')).toHaveLength(4)
  })

  test('factory and seeder misuse is refused with a hint', () => {
    expect(() => UserFactory.count(0)).toThrow(OrmUsageError)
    expect(() => defineFactory(User, 42 as never)).toThrow(/definition function/)
    expect(() => defineSeeder({ after: ['Not A Table'], run() {} })).toThrow(/table names/)
    expect(seederNameForFile('invoice-line.seeder.ts')).toBe('InvoiceLineSeeder')
    expect(UserFactory.seed(3).count(2).raw()).toEqual(UserFactory.seed(3).count(2).raw())
    expect(PostFactory.raw()[0]?.['author_id']).toBeUndefined()
  })
})

describe.each(engines)('factories and seeders on $name', (engine) => {
  const connection = useEngine(engine)

  describe(engineTitle(engine), () => {
    test.skipIf(engine.skipped !== undefined)('count, state, for, has and recycle', async () => {
      const users = await UserFactory.count(2).create()
      expect(users).toHaveLength(2)
      const single = await UserFactory.state({ name: 'Ada' }).create()
      expect(single.name).toBe('Ada')
      const posts = await PostFactory.count(4).recycle(users).create()
      expect(new Set(posts.map((p) => p.author_id)).size).toBeLessThanOrEqual(2)
      expect(await User.query().count()).toBe(3) // recycled: no new users
      const mine = await PostFactory.count(2).for(single, 'author_id').create()
      expect(mine.every((p) => p.author_id === single.id)).toBe(true)
      await PostFactory.create() // a foreign-key factory creates its own author
      expect(await User.query().count()).toBe(4)
      const withPosts = await UserFactory.has(PostFactory.count(3), 'author_id').create()
      expect(await Post.query().where('author_id', withPosts.id).count()).toBe(3)
      const published = await PostFactory.state((attributes) => ({
        title: `${String(attributes['title'])} (published)`,
        status: 'published',
      }))
        .recycle(single)
        .create()
      expect(published.title.endsWith('(published)')).toBe(true)
    })

    test.skipIf(engine.skipped !== undefined)(
      'seeders run once per run, in one transaction, inside a tenant',
      async () => {
        const order: string[] = []
        const ProjectsSeeder = defineSeeder({
          after: ['users'],
          async run({ tenantId }) {
            order.push(`projects:${tenantId}`)
            await ProjectFactory.count(2).create()
          },
        })
        const DatabaseSeeder = defineSeeder({
          async run({ call, env }) {
            order.push(`database:${env}`)
            await call([ProjectsSeeder, ProjectsSeeder])
            await call(ProjectsSeeder)
          },
        })
        const ran = await runSeeders(DatabaseSeeder, {
          connection: connection(),
          env: 'local',
          tenantId: TENANT,
          names: new Map([[ProjectsSeeder, 'ProjectsSeeder']]),
        })
        expect(ran).toEqual(['DatabaseSeeder', 'ProjectsSeeder'])
        expect(order).toEqual(['database:local', `projects:${TENANT}`])
        expect(await runWithTenant(TENANT, () => Project.query().count())).toBe(2)
        expect(await runWithTenant(OTHER, () => Project.query().count())).toBe(0)
        // A failing seeder leaves nothing behind.
        const Broken = defineSeeder({
          async run() {
            await ProjectFactory.create()
            throw new Error('boom')
          },
        })
        await expect(
          runSeeders(Broken, { connection: connection(), env: 'local', tenantId: TENANT }),
        ).rejects.toThrow('boom')
        expect(await runWithTenant(TENANT, () => Project.query().count())).toBe(2)
        await expect(
          runSeeders(defineSeeder({ run: ({ call }) => call([42 as never]) }), {
            connection: connection(),
            env: 'local',
          }),
        ).rejects.toThrow(/call\(\) takes seeders/)
      },
    )

    test.skipIf(engine.skipped !== undefined)(
      'wherePolicy filters with ADR-0008 semantics; a null actor value matches nothing',
      async () => {
        const ada = await UserFactory.state({ name: 'Ada' }).create()
        const bob = await UserFactory.state({ name: 'Bob' }).create()
        await PostFactory.count(2).for(ada, 'author_id').create()
        await PostFactory.count(3).for(bob, 'author_id').create()
        const actor = (id: number | null) => ({
          id: 'u',
          type: 'user' as const,
          roles: [],
          attrs: { userId: id },
        })
        const own = {
          field: 'author_id',
          op: 'eq' as const,
          value: { $actor: 'attrs.userId' as const },
        }
        expect(
          await Post.query()
            .wherePolicy(own, { actor: actor(ada.id) })
            .count(),
        ).toBe(2)
        expect(
          await Post.query()
            .wherePolicy(own, { actor: actor(null) })
            .count(),
        ).toBe(0)
        const notOwn = { op: 'not' as const, filter: own }
        expect(
          await Post.query()
            .wherePolicy(notOwn, { actor: actor(ada.id) })
            .count(),
        ).toBe(3)
        // Case-insensitive matching folds ASCII only, the same in SQL and in memory.
        const named = { field: 'name', op: 'contains' as const, value: 'AD', caseSensitive: false }
        expect(await User.query().wherePolicy(named, { actor: null }).count()).toBe(1)
        expect(() =>
          Post.query().wherePolicy({ field: 'nope', op: 'eq', value: 1 }, { actor: null }),
        ).toThrow()
      },
    )

    test.skipIf(engine.skipped !== undefined)(
      'tenancy off: a t.tenant() table is refused instead of read unscoped (#90)',
      async () => {
        configureOrm({ tenancy: false })
        try {
          await expect(Project.query().count()).rejects.toMatchObject({
            code: 'tenancy_not_configured',
          })
          expect(await User.query().count()).toBe(0)
        } finally {
          configureOrm({ tenancy: { column: 'tenant_id' } })
        }
      },
    )
  })
})
