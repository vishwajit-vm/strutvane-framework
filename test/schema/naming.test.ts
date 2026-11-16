/**
 * Laravel naming parity: tables ⇄ models ⇄ labels, and migration names ⇄ stubs.
 */
import { describe, expect, test } from 'vitest'
import {
  camelCase,
  humanize,
  inferMigrationIntent,
  migrationFileName,
  migrationStub,
  modelNameForTable,
  pluralize,
  singularize,
  slugify,
} from '../../src/schema/naming.ts'

describe('inflection', () => {
  test.each([
    ['post', 'posts'],
    ['category', 'categories'],
    ['day', 'days'],
    ['status', 'statuses'],
    ['box', 'boxes'],
    ['person', 'people'],
    ['news', 'news'],
    ['blog_post', 'blog_posts'],
  ])('%s ⇄ %s', (singular, plural) => {
    expect(pluralize(singular)).toBe(plural)
    expect(singularize(plural)).toBe(singular)
  })

  test('table → model name, camelCase and human labels', () => {
    expect(modelNameForTable('posts')).toBe('Post')
    expect(modelNameForTable('blog_posts')).toBe('BlogPost')
    expect(modelNameForTable('categories')).toBe('Category')
    expect(camelCase('blog_posts')).toBe('blogPosts')
    expect(humanize('author_id')).toBe('Author')
    expect(humanize('created_at')).toBe('Created at')
  })
})

describe('make:migration', () => {
  test.each([
    ['create_posts_table', { kind: 'create', table: 'posts' }],
    ['create_blog_posts_table', { kind: 'create', table: 'blog_posts' }],
    ['add_subtitle_to_posts_table', { kind: 'alter', table: 'posts' }],
    ['remove_excerpt_from_posts_table', { kind: 'alter', table: 'posts' }],
    ['2026_01_03_000000_add_subtitle_to_posts_table.ts', { kind: 'alter', table: 'posts' }],
    ['rename_labels_to_tags', { kind: 'blank' }],
    ['backfill_slugs', { kind: 'blank' }],
  ])('%s → %o', (name, intent) => {
    expect(inferMigrationIntent(name)).toEqual(intent)
  })

  test('file names sort in run order and use UTC', () => {
    expect(migrationFileName('create_posts_table', new Date('2026-01-02T03:04:05Z'))).toBe(
      '2026_01_02_030405_create_posts_table.ts',
    )
  })

  test("stubs match the intent, like Laravel's create/update/blank stubs", () => {
    expect(migrationStub('create_posts_table')).toContain("schema.create('posts', (t) => {")
    expect(migrationStub('create_posts_table')).toContain("schema.dropIfExists('posts')")
    expect(migrationStub('add_subtitle_to_posts_table')).toContain("schema.table('posts', (t) => {")
    expect(migrationStub('backfill_slugs')).toContain('up(schema) {}')
  })
})

describe('slugify', () => {
  test.each([
    ['Hello, World!', 'hello-world'],
    ['  Crème brûlée  ', 'creme-brulee'],
    ['100% TypeScript', '100-typescript'],
    ['---', ''],
  ])('%s → %s', (text, slug) => {
    expect(slugify(text)).toBe(slug)
  })
})
