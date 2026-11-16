/**
 * Resource metadata derived from the migrations: what the CRUD API and the UI consume.
 */
import { describe, expect, test } from 'vitest'
import { applyOperations } from '../../src/schema/apply.ts'
import { EMPTY_SCHEMA } from '../../src/schema/columns.ts'
import {
  type FieldMetadata,
  generateMetadata,
  type ResourceMetadata,
} from '../../src/schema/generate/metadata.ts'
import { recordOperations } from '../../src/schema/migration.ts'
import { BLOG_ROOT, replayApp } from './helpers.ts'

async function blogResource(table: string): Promise<ResourceMetadata> {
  const resource = generateMetadata((await replayApp(BLOG_ROOT)).state).resources.find(
    (candidate) => candidate.table === table,
  )
  if (resource === undefined) throw new Error(`No resource for ${table}`)
  return resource
}

function field(resource: ResourceMetadata, name: string): FieldMetadata {
  const found = resource.fields.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`No field ${name}`)
  return found
}

describe('resource-level metadata', () => {
  test('names, labels, slug, soft deletes and default sort come from the table', async () => {
    const posts = await blogResource('posts')
    expect(posts).toMatchObject({
      table: 'posts',
      model: 'Post',
      route: 'posts',
      label: { singular: 'Post', plural: 'Posts' },
      primaryKey: 'id',
      titleField: 'title',
      slug: { field: 'slug', from: 'title' },
      timestamps: true,
      softDeletes: true,
      defaultSort: '-created_at',
      perPage: 25,
    })
    const tags = await blogResource('tags')
    expect(tags).toMatchObject({
      model: 'Tag',
      titleField: 'name',
      timestamps: false,
      softDeletes: false,
      defaultSort: '-id',
    })
    expect(tags.slug).toBeUndefined()
  })

  test('relations: belongsTo from each foreign key, hasMany on the other side', async () => {
    expect((await blogResource('posts')).relations).toEqual([
      {
        name: 'author',
        kind: 'belongsTo',
        resource: 'users',
        foreignKey: 'author_id',
        ownerKey: 'id',
      },
      {
        name: 'category',
        kind: 'belongsTo',
        resource: 'categories',
        foreignKey: 'category_id',
        ownerKey: 'id',
      },
    ])
    expect((await blogResource('users')).relations).toEqual([
      {
        name: 'posts',
        kind: 'hasMany',
        resource: 'posts',
        foreignKey: 'author_id',
        ownerKey: 'id',
      },
    ])
  })

  test('two keys to the same parent get distinct hasMany names', () => {
    const state = applyOperations(
      EMPTY_SCHEMA,
      recordOperations((schema) => {
        schema.create('users', (t) => t.id())
        schema.create('posts', (t) => {
          t.id()
          t.foreignId('author_id').constrained('users')
          t.foreignId('editor_id').nullable().constrained('users')
        })
      }, EMPTY_SCHEMA),
    )
    const users = generateMetadata(state).resources.find((resource) => resource.table === 'users')
    expect(users?.relations.map((relation) => relation.name)).toEqual([
      'postsAsAuthor',
      'postsAsEditor',
    ])
  })

  test('sidebar: alphabetical by label unless overridden; labels can be overridden too', async () => {
    const state = (await replayApp(BLOG_ROOT)).state
    const order = (overrides = {}): string[] =>
      [...generateMetadata(state, overrides).resources]
        .sort((a, b) => a.sidebar.order - b.sidebar.order)
        .map((resource) => resource.label.plural)
    expect(order()).toEqual(['Categories', 'Posts', 'Tags', 'Users'])
    expect(
      order({
        posts: { sidebarOrder: 1 },
        users: { label: { singular: 'Member', plural: 'Members' } },
      }),
    ).toEqual(['Posts', 'Categories', 'Members', 'Tags'])
  })
})

describe('field-level metadata', () => {
  test('required / fillable follow the same rules as the NewPost type', async () => {
    const posts = await blogResource('posts')
    expect(
      posts.fields.filter((candidate) => candidate.required).map((candidate) => candidate.name),
    ).toEqual(['title', 'author_id'])
    expect(
      posts.fields.filter((candidate) => !candidate.fillable).map((candidate) => candidate.name),
    ).toEqual(['id', 'created_at', 'updated_at', 'deleted_at'])
  })

  test('search: text fields by "contains", number fields by exact match, never booleans, dates, JSON or secrets', async () => {
    const posts = await blogResource('posts')
    const by = (mode: FieldMetadata['searchable']): string[] =>
      posts.fields
        .filter((candidate) => candidate.searchable === mode)
        .map((candidate) => candidate.name)
    expect(by('text')).toEqual(['title', 'slug', 'content', 'status', 'subtitle'])
    expect(by('exact')).toEqual(['id', 'price', 'author_id', 'category_id'])
    expect(field(await blogResource('users'), 'password').searchable).toBe(false)
  })

  test('secrets are hidden everywhere: not returned, searched, sorted, filtered or editable', async () => {
    expect(field(await blogResource('users'), 'password')).toMatchObject({
      hidden: true,
      fillable: false,
      searchable: false,
      sortable: false,
      listed: false,
      input: 'none',
      filterOperators: [],
    })
  })

  test('filters, inputs and validation hints per column type', async () => {
    const posts = await blogResource('posts')
    expect(field(posts, 'status')).toMatchObject({
      input: 'select',
      options: ['draft', 'published'],
      default: 'draft',
      filterOperators: ['eq', 'ne', 'in'],
    })
    expect(field(posts, 'price')).toMatchObject({
      input: 'decimal',
      precision: 12,
      scale: 2,
      cast: 'decimal',
      filterOperators: ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'],
    })
    expect(field(posts, 'featured')).toMatchObject({
      input: 'switch',
      default: false,
      filterOperators: ['eq'],
    })
    expect(field(posts, 'author_id')).toMatchObject({
      input: 'relation',
      references: 'users',
      label: 'Author',
    })
    expect(field(posts, 'subtitle').filterOperators).toContain('null')
    expect(field(posts, 'title')).toMatchObject({ maxLength: 200, input: 'text', listed: true })
    expect(field(posts, 'content')).toMatchObject({
      input: 'textarea',
      listed: false,
      sortable: false,
    })
    expect(field(posts, 'meta')).toMatchObject({
      input: 'json',
      filterOperators: [],
      sortable: false,
    })
    expect(field(posts, 'slug').unique).toBe(true)
    expect(field(await blogResource('users'), 'email').unique).toBe(true)
  })
})
