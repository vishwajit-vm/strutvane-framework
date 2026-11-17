/**
 * Approach (a): replaying real migration files, in order, with no database.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { applyOperations } from '../../src/schema/apply.ts'
import { findColumn, findTable } from '../../src/schema/columns.ts'
import { SchemaError } from '../../src/schema/errors.ts'
import { migration } from '../../src/schema/migration.ts'
import {
  canonicalSchema,
  discoverMigrations,
  irreversibleMigrations,
  replayMigrations,
} from '../../src/schema/replay.ts'
import {
  BLOG_ROOT,
  cleanupTempDirs,
  DYNAMIC_ROOT,
  makeTempDir,
  migrationSource,
  REPO_ROOT,
  replayApp,
} from './helpers.ts'

afterAll(cleanupTempDirs)

describe('replaying the blog app', () => {
  test('the final schema reflects every create, alter, rename and drop, in order', async () => {
    const { state, migrations } = await replayApp(BLOG_ROOT)
    expect(migrations).toHaveLength(7)
    expect(state.tables.map((table) => table.name)).toEqual([
      'users',
      'posts',
      'categories',
      'tags',
    ])
    const posts = findTable(state, 'posts')
    if (posts === undefined) throw new Error('posts missing')
    // body was renamed to content, excerpt dropped, subtitle and category_id added later.
    expect(posts.columns.map((column) => column.name)).toEqual([
      'id',
      'title',
      'slug',
      'content',
      'price',
      'status',
      'author_id',
      'featured',
      'published_on',
      'meta',
      'created_at',
      'updated_at',
      'deleted_at',
      'subtitle',
      'category_id',
    ])
    expect(findColumn(posts, 'content')).toEqual({ name: 'content', kind: 'text', nullable: true })
    expect(findColumn(posts, 'category_id')?.references).toEqual({
      table: 'categories',
      column: 'id',
      onDelete: 'set null',
      name: 'posts_category_id_foreign',
    })
    expect(posts.indexes.map((index) => index.name)).toEqual([
      'posts_slug_unique',
      'posts_status_index',
    ])
    // `labels` was renamed to `tags`; its index keeps its original name, as in every database.
    expect(findTable(state, 'tags')?.indexes.map((index) => index.name)).toEqual([
      'labels_name_unique',
    ])
  })

  test('every down() is the exact inverse of its up()', async () => {
    const replay = await replayApp(BLOG_ROOT)
    expect(irreversibleMigrations(replay)).toEqual([])
  })

  test('rolling back step by step walks the history backwards to an empty schema', async () => {
    const replay = await replayApp(BLOG_ROOT)
    let state = replay.state
    for (const step of [...replay.migrations].reverse()) {
      state = applyOperations(state, step.down)
      expect(canonicalSchema(state)).toBe(canonicalSchema(step.before))
    }
    expect(state.tables).toEqual([])
  })

  test('a down() that forgets something is reported as irreversible', () => {
    const replay = replayMigrations([
      {
        name: 'create_tags',
        migration: migration({
          up: (schema) => schema.create('tags', (t) => t.id()),
          down: () => undefined,
        }),
      },
    ])
    expect(irreversibleMigrations(replay)).toEqual(['create_tags'])
  })

  test('the dynamic app (loops, helpers, if/hasColumn) replays fine: it is just code', async () => {
    const { state } = await replayApp(DYNAMIC_ROOT)
    expect(findTable(state, 'products')?.columns.map((column) => column.name)).toEqual([
      'id',
      'sku',
      'name_en',
      'name_fr',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'barcode',
    ])
  })
})

describe('failure cases', () => {
  test('a broken migration is named in the error', () => {
    const run = (): unknown =>
      replayMigrations([
        {
          name: '2026_01_01_000000_create_posts',
          migration: migration({
            up: (schema) => schema.create('posts', (t) => t.id()),
            down: (schema) => schema.drop('posts'),
          }),
        },
        {
          name: '2026_01_02_000000_oops',
          migration: migration({
            up: (schema) => schema.table('post', (t) => t.string('x').nullable()),
            down: () => undefined,
          }),
        },
      ])
    expect(run).toThrow(SchemaError)
    try {
      run()
    } catch (error) {
      expect((error as SchemaError).describe()).toBe(
        '[unknown_table] in 2026_01_02_000000_oops.ts: There is no table "post" at this point in the migrations. Hint: Known tables: posts. Check the spelling and the migration order.',
      )
    }
  })

  test('the same migration twice is refused', () => {
    const noop = migration({ up: () => undefined, down: () => undefined })
    expect(() =>
      replayMigrations([
        { name: 'a', migration: noop },
        { name: 'a', migration: noop },
      ]),
    ).toThrow(/listed twice/)
  })

  test('a wrongly named file in the migrations folder is an error, not silently skipped', () => {
    const dir = makeTempDir('naming')
    writeFileSync(
      join(dir, '2026_01_01_000000_create_tags_table.ts'),
      migrationSource("schema.create('tags', (t) => t.id())", "schema.drop('tags')"),
    )
    writeFileSync(join(dir, 'create_users_table.ts'), migrationSource('', ''))
    expect(() => discoverMigrations(dir)).toThrow(/isn't named like a migration/)
  })

  test('files run in code-unit order regardless of how the OS lists them', () => {
    const dir = makeTempDir('order')
    for (const name of [
      '2026_01_10_000000_b.ts',
      '2026_01_02_000000_a.ts',
      '2026_01_02_000001_c.ts',
    ])
      writeFileSync(join(dir, name), migrationSource('', ''))
    expect(discoverMigrations(dir).map((file) => file.name)).toEqual([
      '2026_01_02_000000_a',
      '2026_01_02_000001_c',
      '2026_01_10_000000_b',
    ])
  })
})

describe('watch mode', () => {
  test('fresh: true re-imports an edited migration (Node caches modules forever otherwise)', () => {
    // Run in plain Node (the way `node strut dev` would), not through Vitest's module runner.
    const app = makeTempDir('fresh')
    const migrations = join(app, 'database', 'migrations')
    mkdirSync(migrations, { recursive: true })
    const file = join(migrations, '2026_01_01_000000_create_tags_table.ts')
    writeFileSync(
      file,
      migrationSource("schema.create('tags', (t) => { t.id() })", "schema.drop('tags')"),
    )
    const script = join(app, 'reload.ts')
    writeFileSync(
      script,
      `import { writeFileSync, utimesSync } from 'node:fs'
import { discoverMigrations, loadMigrations, replayMigrations } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src', 'schema', 'replay.ts')).href)}
const dir = ${JSON.stringify(migrations)}
const columns = async (fresh) => replayMigrations(await loadMigrations(discoverMigrations(dir), { fresh })).state.tables[0].columns.map((c) => c.name).join(',')
const before = await columns(false)
writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(migrationSource("schema.create('tags', (t) => { t.id(); t.string('name') })", "schema.drop('tags')"))})
utimesSync(${JSON.stringify(file)}, new Date(), new Date(Date.now() + 5000))
console.log(JSON.stringify({ before, stale: await columns(false), fresh: await columns(true) }))
`,
    )
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    expect(
      result.stderr
        .replace(/.*ExperimentalWarning.*\n?/g, '')
        .replace(/.*--trace-warnings.*\n?/g, ''),
    ).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ before: 'id', stale: 'id', fresh: 'id,name' })
  })
})
