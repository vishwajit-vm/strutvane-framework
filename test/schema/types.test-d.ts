/**
 * Type-level tests, checked by `tsc --noEmit` and Vitest's typecheck:
 * every `expectTypeOf` must hold, and every `@ts-expect-error` line must really be an error
 * (an unused `@ts-expect-error` is itself a compile error, so misuse that silently compiled
 * would fail the build).
 *
 * Misuse lives inside functions that are never called, so it is only ever type-checked, never run.
 */
import { describe, expectTypeOf, test } from 'vitest'
import type {
  Blueprint,
  ColumnBuilder,
  ForeignIdColumnBuilder,
  SlugColumnBuilder,
} from '../../src/schema/blueprint.ts'
import type {
  NewPost,
  PostJson,
  PostPatch,
  Post as PostRow,
  Tables,
  User,
  UserJson,
} from './fixtures/blog/.strutvane/types/models.d.ts'
import type { JsonValue, TableRegistry } from './fixtures/registry.ts'

describe('migration builder types', () => {
  test('each column builder carries its value type', () => {
    const shapes = (t: Blueprint) => ({
      title: t.string('title'),
      status: t.enum('status', ['draft', 'published']),
      price: t.decimal('price', 12, 2),
      featured: t.boolean('featured'),
      slug: t.slug('slug'),
      author: t.foreignId('author_id'),
    })
    type Shapes = ReturnType<typeof shapes>
    expectTypeOf<Shapes['title']>().toEqualTypeOf<ColumnBuilder<string>>()
    expectTypeOf<Shapes['status']>().toEqualTypeOf<ColumnBuilder<'draft' | 'published'>>()
    expectTypeOf<Shapes['price']>().toEqualTypeOf<ColumnBuilder<number | string>>()
    expectTypeOf<Shapes['featured']>().toEqualTypeOf<ColumnBuilder<boolean>>()
    expectTypeOf<Shapes['slug']>().toEqualTypeOf<SlugColumnBuilder>()
    expectTypeOf<Shapes['author']>().toEqualTypeOf<ForeignIdColumnBuilder>()
  })

  test('valid chains compile', () => {
    const valid = (t: Blueprint): void => {
      t.enum('status', ['draft', 'published']).default('draft')
      t.decimal('price', 12, 2).default(0)
      t.decimal('price', 12, 2).default('0.00')
      t.slug('slug').nullable().from('title').unique()
      t.foreignId('author_id').constrained('users').cascadeOnDelete()
      t.string('subtitle').nullable().default(null)
      t.json('meta').nullable().default(null)
      t.uuid('id').primary()
      t.tenant()
      t.tenant('team_id')
      t.foreignUuid('project_id').constrained('projects').cascadeOnDelete()
      t.string('api_key').nullable().secret()
      t.text('notes').nullable().hidden()
    }
    expectTypeOf(valid).toBeFunction()
  })

  test('misuse fails to compile', () => {
    const misuse = (t: Blueprint): void => {
      // @ts-expect-error 'archived' isn't one of the enum's values
      t.enum('status', ['draft', 'published']).default('archived')
      // @ts-expect-error an enum needs at least one value
      t.enum('status', [])
      // @ts-expect-error a boolean column can't default to text
      t.boolean('featured').default('yes')
      // @ts-expect-error a decimal can't default to a boolean
      t.decimal('price').default(true)
      // @ts-expect-error only foreignId columns can be constrained
      t.integer('author_id').constrained('users')
      // @ts-expect-error only slug columns are built from another column
      t.string('code').from('title')
      // @ts-expect-error JSON defaults differ per database, so only null is allowed
      t.json('meta').default({})
      // @ts-expect-error cascadeOnDelete is a foreign key modifier
      t.string('name').cascadeOnDelete()
      // @ts-expect-error only UUID columns can be a UUID primary key
      t.string('code').primary()
      // @ts-expect-error a plain UUID is not a foreign key; use foreignUuid
      t.uuid('project_id').constrained('projects')
      // @ts-expect-error a UUID foreign key holds text, not a number
      t.foreignUuid('project_id').default(1)
    }
    expectTypeOf(misuse).toBeFunction()
  })
})

describe('generated model types (fixtures/blog/.strutvane/types/models.d.ts)', () => {
  test('rows have the right types and nullability, straight from the migrations', () => {
    expectTypeOf<PostRow['id']>().toEqualTypeOf<number>()
    expectTypeOf<PostRow['title']>().toEqualTypeOf<string>()
    expectTypeOf<PostRow['content']>().toEqualTypeOf<string | null>()
    expectTypeOf<PostRow['price']>().toEqualTypeOf<string>()
    expectTypeOf<PostRow['status']>().toEqualTypeOf<'draft' | 'published'>()
    expectTypeOf<PostRow['featured']>().toEqualTypeOf<boolean>()
    expectTypeOf<PostRow['published_on']>().toEqualTypeOf<string | null>()
    expectTypeOf<PostRow['meta']>().toEqualTypeOf<JsonValue | null>()
    expectTypeOf<PostRow['created_at']>().toEqualTypeOf<Date | null>()
    expectTypeOf<PostRow['category_id']>().toEqualTypeOf<number | null>()
    expectTypeOf<User['password']>().toEqualTypeOf<string | null>()
  })

  test('renamed and dropped columns are gone', () => {
    expectTypeOf<PostRow>().not.toHaveProperty('body')
    expectTypeOf<PostRow>().not.toHaveProperty('excerpt')
    expectTypeOf<Tables>().not.toHaveProperty('labels')
    expectTypeOf<Tables>().toHaveProperty('tags')
  })

  test('the generated file registers every table with the ORM module', () => {
    expectTypeOf<TableRegistry['posts']['row']>().toEqualTypeOf<PostRow>()
    expectTypeOf<TableRegistry['posts']['insert']>().toEqualTypeOf<NewPost>()
    expectTypeOf<keyof TableRegistry>().toEqualTypeOf<'users' | 'posts' | 'categories' | 'tags'>()
  })

  test('JSON shapes use strings for timestamps and never contain secrets', () => {
    expectTypeOf<PostJson['created_at']>().toEqualTypeOf<string | null>()
    expectTypeOf<UserJson>().not.toHaveProperty('password')
  })

  test("NewPost requires exactly what the database can't fill in", () => {
    const minimal: NewPost = { title: 'Hello', author_id: 1 }
    const full: NewPost = {
      title: 'Hello',
      author_id: 1,
      price: '12.50',
      status: 'published',
      subtitle: null,
      published_on: '2026-11-14',
    }
    const patch: PostPatch = {}
    expectTypeOf([minimal, full, patch]).toBeArray()
    const misuse = (): NewPost[] => [
      // @ts-expect-error author_id is required (not nullable, no default)
      { title: 'Hello' },
      // @ts-expect-error id is set by the database
      { title: 'Hello', author_id: 1, id: 5 },
      // @ts-expect-error created_at is set by the framework
      { title: 'Hello', author_id: 1, created_at: new Date() },
      // @ts-expect-error status must be one of the enum values
      { title: 'Hello', author_id: 1, status: 'archived' },
      // @ts-expect-error title can't be null
      { title: null, author_id: 1 },
    ]
    expectTypeOf(misuse).toBeFunction()
  })
})
