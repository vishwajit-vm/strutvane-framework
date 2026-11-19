/**
 * `make:migration` in migration-first apps (blueprint §2.3; CONSISTENCY #34, #35, #59, #104):
 * the migration, the model for `create_*_table`, `--seeder` (seeder + factory, registered between
 * the markers) and `--factory`, never overwriting a file the developer owns.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  databaseSeederStub,
  isMigrationFirstProject,
  registerSeederV2,
  SEEDERS_END,
  SEEDERS_START,
} from '../../src/console/make/migration-first.ts'
import { cleanupTempDirs, cli, makeProject, read, write } from './helpers.ts'

afterAll(cleanupTempDirs)

/** A migration-first project (its generated schema snapshot marks it). */
const v2Project = (files: Readonly<Record<string, string>> = {}): string =>
  makeProject({ '.strutvane/schema.json': '{"version":1,"tables":{}}\n', ...files })

describe('make:migration (migration-first)', () => {
  test('create_*_table writes the migration and the model; --seeder adds seeder and factory, registered', async () => {
    const root = v2Project()
    const r = await cli(['make:migration', 'create_posts_table', '--seeder', '--json'], {
      cwd: root,
    })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    const migration = read(root, 'database/migrations/2026_11_14_093000_create_posts_table.ts')
    expect(migration).toContain("import { migration } from '@strutvane/framework/schema'")
    expect(migration).toContain("schema.create('posts', (t) => {")
    expect(migration).toContain("schema.dropIfExists('posts')")
    const model = read(root, 'app/models/post.ts')
    expect(model).toContain("export class Post extends Model('posts', {")
    expect(model).toContain('fillable: []')
    expect(read(root, 'database/factories/post.factory.ts')).toContain('defineFactory(Post,')
    expect(read(root, 'database/seeders/post.seeder.ts')).toContain(
      'PostFactory.count(10).create()',
    )
    const database = read(root, 'database/seeders/database.seeder.ts')
    expect(database).toContain("import PostSeeder from './post.seeder.ts'")
    expect(database).toContain('await call([PostSeeder])')
    expect(database.indexOf(SEEDERS_START)).toBeLessThan(database.indexOf('await call(['))
  })

  test('a second table is appended after the first; a re-run never overwrites owned files', async () => {
    const root = v2Project()
    await cli(['make:migration', 'create_users_table', '--seeder'], { cwd: root })
    write(root, 'app/models/user.ts', '// mine\n')
    const again = await cli(['make:migration', 'create_users_table', '--seeder'], {
      cwd: root,
      now: Date.UTC(2026, 10, 15),
    })
    expect(again.code).toBe(0)
    expect(read(root, 'app/models/user.ts')).toBe('// mine\n')
    await cli(['make:migration', 'create_posts_table', '--seeder'], {
      cwd: root,
      now: Date.UTC(2026, 10, 16),
    })
    expect(read(root, 'database/seeders/database.seeder.ts')).toContain(
      'await call([UserSeeder, PostSeeder])',
    )
  })

  test('alter and blank names; --factory alone; --seeder on a blank name is refused', async () => {
    const root = v2Project()
    expect(
      (await cli(['make:migration', 'add_subtitle_to_posts_table', '--factory'], { cwd: root }))
        .code,
    ).toBe(0)
    expect(
      read(root, 'database/migrations/2026_11_14_093000_add_subtitle_to_posts_table.ts'),
    ).toContain("schema.table('posts', (t) => {")
    expect(existsSync(join(root, 'app/models/post.ts'))).toBe(false)
    expect(existsSync(join(root, 'database/factories/post.factory.ts'))).toBe(true)
    expect(existsSync(join(root, 'database/seeders/post.seeder.ts'))).toBe(false)
    expect(
      (await cli(['make:migration', 'backfill_slugs'], { cwd: root, now: Date.UTC(2026, 10, 20) }))
        .code,
    ).toBe(0)
    expect(read(root, 'database/migrations/2026_11_20_000000_backfill_slugs.ts')).toContain(
      'up(schema) {}',
    )
    const refused = await cli(['make:migration', 'backfill_more', '--seeder', '--json'], {
      cwd: root,
    })
    expect(refused.code).not.toBe(0)
    // #123: codes are lowercase snake_case (the merged branch once threw INVALID_ARGUMENT here).
    expect(refused.json().error).toMatchObject({ code: 'invalid_argument' })
  })

  test('a database.seeder.ts without markers is left alone and the lines to add are shown', async () => {
    const root = v2Project({
      'database/seeders/database.seeder.ts': 'export default defineSeeder({ async run() {} })\n',
    })
    const r = await cli(['make:migration', 'create_tags_table', '--seeder'], { cwd: root })
    expect(r.code).toBe(0)
    expect(read(root, 'database/seeders/database.seeder.ts')).toBe(
      'export default defineSeeder({ async run() {} })\n',
    )
    expect(r.stdout + r.stderr).toContain('import TagSeeder')
  })

  test('v1 projects keep the hand-written stub', async () => {
    const root = makeProject()
    expect(isMigrationFirstProject(root)).toBe(false)
    expect((await cli(['make:migration', 'create_posts_table'], { cwd: root })).code).toBe(0)
    expect(existsSync(join(root, 'app/models/post.ts'))).toBe(false)
  })
})

describe('registerSeederV2', () => {
  test('idempotent, keeps CRLF, adds the import after the last import', () => {
    const first = registerSeederV2(databaseSeederStub(), 'UserSeeder', './user.seeder.ts')
    if (first.status !== 'registered') throw new Error('expected registered')
    const again = registerSeederV2(first.content, 'UserSeeder', './user.seeder.ts')
    expect(again.status).toBe('unchanged')
    const crlf = databaseSeederStub().replace(/\n/g, '\r\n')
    const registered = registerSeederV2(crlf, 'UserSeeder', './user.seeder.ts')
    if (registered.status !== 'registered') throw new Error('expected registered')
    expect(registered.content).toContain('\r\n')
    expect(registered.content.replace(/\r\n/g, '')).not.toContain('\n')
    expect(first.content.indexOf("import UserSeeder from './user.seeder.ts'")).toBeGreaterThan(
      first.content.indexOf("from '@strutvane/framework/database'"),
    )
    expect(first.content).toContain(SEEDERS_END)
  })

  test('a file without imports gets the import first; missing markers are reported', () => {
    const bare = `export default defineSeeder({\n  async run({ call }) {\n    ${SEEDERS_START}\n    await call([])\n    ${SEEDERS_END}\n  },\n})\n`
    const result = registerSeederV2(bare, 'TagSeeder', './tag.seeder.ts')
    if (result.status !== 'registered') throw new Error('expected registered')
    expect(result.content.startsWith("import TagSeeder from './tag.seeder.ts'")).toBe(true)
    expect(registerSeederV2('nothing here', 'TagSeeder', './tag.seeder.ts').status).toBe(
      'unrecognised',
    )
  })
})

describe('make:model, make:factory and make:seeder write v2 shapes (docs agent, 2026-11-18)', () => {
  const files = (root: string, paths: readonly string[]) =>
    paths.map((path) => [path, existsSync(join(root, path))])

  test('make:model: model, migration, factory, seeder (registered) and a deny-by-default policy', async () => {
    const root = v2Project()
    const r = await cli(['make:model', 'Post', '--json'], { cwd: root })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(read(root, 'app/models/post.ts')).toContain("export class Post extends Model('posts', {")
    expect(read(root, 'database/migrations/2026_11_14_093000_create_posts_table.ts')).toContain(
      "schema.create('posts'",
    )
    expect(read(root, 'database/factories/post.factory.ts')).toContain('defineFactory(Post,')
    expect(read(root, 'database/seeders/post.seeder.ts')).toContain('PostFactory.count(10)')
    expect(read(root, 'database/seeders/database.seeder.ts')).toContain('await call([PostSeeder])')
    const policy = read(root, 'app/policies/post.policy.ts')
    expect(policy).toContain('export default class PostPolicy')
    expect(policy).not.toMatch(/create\(|update\(|delete\(/)
    for (const path of ['app/models/post.ts', 'database/factories/post.factory.ts'])
      expect(read(root, path)).not.toContain('defineModel')
  })

  test('make:model flags: --no-migration --no-factory --no-seeder --no-policy, --seed', async () => {
    const root = v2Project()
    const r = await cli(
      ['make:model', 'Comment', '--no-migration', '--no-factory', '--no-seeder', '--no-policy'],
      { cwd: root },
    )
    expect(r.code, r.stderr).toBe(0)
    expect(
      files(root, [
        'app/models/comment.ts',
        'database/factories/comment.factory.ts',
        'database/seeders/comment.seeder.ts',
        'app/policies/comment.policy.ts',
      ]),
    ).toEqual([
      ['app/models/comment.ts', true],
      ['database/factories/comment.factory.ts', false],
      ['database/seeders/comment.seeder.ts', false],
      ['app/policies/comment.policy.ts', false],
    ])
    const seeded = await cli(['make:model', 'Tag', '--seed', '3'], { cwd: root })
    expect(seeded.code).toBe(0)
    expect(read(root, 'database/seeders/tag.seeder.ts')).toContain('TagFactory.count(3)')
  })

  test('make:model refuses field specs: columns belong in the migration', async () => {
    const root = v2Project()
    const r = await cli(['make:model', 'Post', 'title:string', '--json'], { cwd: root })
    expect(r.code).toBe(2)
    expect(r.json().error?.message).toContain('the columns live in the migration')
    expect(existsSync(join(root, 'app/models/post.ts'))).toBe(false)
  })

  test('make:factory needs the model, then writes defineFactory', async () => {
    const root = v2Project()
    const missing = await cli(['make:factory', 'Post', '--json'], { cwd: root })
    expect(missing.json().error?.code).toBe('model_not_found')
    await cli(['make:model', 'Post', '--no-factory', '--no-seeder'], { cwd: root })
    const r = await cli(['make:factory', 'Post'], { cwd: root })
    expect(r.code, r.stderr).toBe(0)
    expect(read(root, 'database/factories/post.factory.ts')).toContain(
      "import { Post } from '../../app/models/post.ts'",
    )
  })

  test('make:seeder: a blank defineSeeder, or one for a model (factory + registration)', async () => {
    const root = v2Project()
    expect((await cli(['make:seeder', 'DemoDataSeeder'], { cwd: root })).code).toBe(0)
    const blank = read(root, 'database/seeders/demo-data.seeder.ts')
    expect(blank).toContain('export default defineSeeder({')
    expect(blank).not.toContain('defineModel')
    await cli(['make:model', 'Invoice', '--no-factory', '--no-seeder'], { cwd: root })
    const r = await cli(['make:seeder', 'Invoice', '--model', 'Invoice', '--count', '5'], {
      cwd: root,
    })
    expect(r.code, r.stderr).toBe(0)
    expect(read(root, 'database/seeders/invoice.seeder.ts')).toContain('InvoiceFactory.count(5)')
    expect(read(root, 'database/factories/invoice.factory.ts')).toContain('defineFactory(Invoice,')
    expect(read(root, 'database/seeders/database.seeder.ts')).toContain('InvoiceSeeder')
  })
})
