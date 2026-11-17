/**
 * The migration-first database commands end to end, on a real project folder and SQLite:
 * migrate (sandboxed replay, .strutvane/ regeneration, drift check, --pretend, --step, --seed,
 * --force in production), migrate:status, migrate:rollback, migrate:reset, migrate:refresh,
 * migrate:fresh, db:seed (--class, --tenant, factories with recycle/for/has) and sync.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../src/commands.ts'
import { Connection, sqliteDriver } from '../../src/database/index.ts'
import { trustedSql } from '../../src/database/sql/fragment.ts'
import { isMigrationFirst } from '../../src/runtime/schema-commands.ts'

const ENTRY = (name: string): string =>
  JSON.stringify(
    fileURLToPath(new URL(`../../src/entries/${name}.ts`, import.meta.url)).replace(/\\/g, '/'),
  )

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function write(root: string, rel: string, content: string): void {
  const file = join(root, ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

const USERS = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('users', (t) => {
      t.id()
      t.string('name', 100)
      t.string('email').unique()
      t.timestamps()
    }, { global: true })
  },
  down(schema) { schema.dropIfExists('users') },
})
`
const POSTS = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('posts', (t) => {
      t.id()
      t.string('title', 200)
      t.slug('slug').from('title')
      t.foreignId('author_id').constrained('users').cascadeOnDelete()
      t.timestamps()
    }, { global: true })
  },
  down(schema) { schema.dropIfExists('posts') },
})
`

/** A migration-first project on a SQLite file, with models, factories and seeders. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-schema-cmd-'))
  dirs.push(root)
  write(root, 'database/migrations/2026_01_01_000000_create_users_table.ts', USERS)
  write(root, 'database/migrations/2026_01_02_000000_create_posts_table.ts', POSTS)
  // App files import the framework from this repository (an app imports the package name).
  write(
    root,
    'app/models/user.ts',
    `import { Model } from ${ENTRY('database')}\nexport class User extends Model('users', { fillable: ['name', 'email'] }) {}\n`,
  )
  write(
    root,
    'app/models/post.ts',
    `import { Model } from ${ENTRY('database')}\nexport class Post extends Model('posts', { fillable: ['title'] }) {}\n`,
  )
  write(
    root,
    'database/factories/user.factory.ts',
    `import { defineFactory } from ${ENTRY('database')}\nimport { User } from '../../app/models/user.ts'\nexport default defineFactory(User, ({ faker }) => ({ name: faker.name(), email: faker.email() }))\n`,
  )
  write(
    root,
    'database/factories/post.factory.ts',
    `import { defineFactory } from ${ENTRY('database')}\nimport { Post } from '../../app/models/post.ts'\nimport UserFactory from './user.factory.ts'\nexport default defineFactory(Post, ({ faker, sequence }) => ({ title: faker.sentence() + ' ' + sequence, author_id: UserFactory }))\n`,
  )
  write(
    root,
    'database/seeders/user.seeder.ts',
    `import { defineSeeder } from ${ENTRY('database')}\nimport UserFactory from '../factories/user.factory.ts'\nexport default defineSeeder({ async run() { await UserFactory.count(3).create() } })\n`,
  )
  write(
    root,
    'database/seeders/post.seeder.ts',
    `import { defineSeeder } from ${ENTRY('database')}\nimport { User } from '../../app/models/user.ts'\nimport PostFactory from '../factories/post.factory.ts'\nexport default defineSeeder({ after: ['users'], async run() { const users = await User.all(); await PostFactory.count(6).recycle(users).create() } })\n`,
  )
  write(
    root,
    'database/seeders/database.seeder.ts',
    `import { defineSeeder } from ${ENTRY('database')}\nimport PostSeeder from './post.seeder.ts'\nimport UserSeeder from './user.seeder.ts'\nexport default defineSeeder({\n  async run({ call }) {\n    // strut:seeders:start\n    await call([UserSeeder, PostSeeder, UserSeeder])\n    // strut:seeders:end\n  },\n})\n`,
  )
  return root
}

function context(root: string, flags: CommandContextLike['flags'] = {}, appEnv = 'local') {
  const lines: string[] = []
  const ctx: CommandContextLike = {
    flags,
    appEnv,
    services: {
      env: { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite', APP_ENV: appEnv },
    },
    requireProject: () => ({ root }),
    out: {
      line: (t = '') => lines.push(t),
      success: (t) => lines.push(`ok ${t}`),
      info: (t) => lines.push(`info ${t}`),
      warn: (t) => lines.push(`warn ${t}`),
      table: (_h, rows) => lines.push(...rows.map((r) => r.join(' | '))),
    },
  }
  return { ctx, lines }
}

const run = async (
  root: string,
  name: string,
  flags: CommandContextLike['flags'] = {},
  appEnv?: string,
) => {
  const command = commands.find((c) => c.name === name)
  if (command === undefined) throw new Error(name)
  const { ctx, lines } = context(root, flags, appEnv)
  const result = await command.run(ctx)
  return { result, lines }
}

async function count(root: string, table: string): Promise<number> {
  const connection = new Connection(sqliteDriver(join(root, 'database', 'database.sqlite')))
  try {
    const { rows } = await connection.run(
      trustedSql([{ kind: 'text', text: `SELECT COUNT(*) AS n FROM "${table}"` }]),
    )
    return Number(rows[0]?.['n'])
  } finally {
    await connection.close()
  }
}

describe('migration-first commands', () => {
  test('the project is recognised as migration-first', () => {
    expect(isMigrationFirst(project())).toBe(true)
  })

  test('migrate --pretend prints the SQL and creates nothing', async () => {
    const root = project()
    const { lines } = await run(root, 'migrate', { pretend: true })
    expect(lines.some((l) => l.startsWith('CREATE TABLE "users"'))).toBe(true)
    expect(existsSync(join(root, '.strutvane', 'schema.json'))).toBe(false)
  })

  test('migrate applies, regenerates .strutvane and reports no drift; status and rollback', async () => {
    const root = project()
    const migrated = await run(root, 'migrate')
    expect(migrated.lines).toContain('ok Migrated 2026_01_01_000000_create_users_table (batch 1)')
    expect(migrated.lines.some((l) => l.startsWith('warn Schema drift'))).toBe(false)
    for (const file of ['types/models.d.ts', 'resources.json', 'schema.json'])
      expect(existsSync(join(root, '.strutvane', file))).toBe(true)
    expect(readFileSync(join(root, '.strutvane', 'types', 'models.d.ts'), 'utf8')).toContain(
      'declare module "@strutvane/framework/database"',
    )
    expect((await run(root, 'migrate')).lines).toContain('ok Nothing to migrate.')
    const status = await run(root, 'migrate:status')
    expect(status.lines).toContain('2026_01_02_000000_create_posts_table | ran (batch 1)')
    const rolled = await run(root, 'migrate:rollback', { step: '1' })
    expect(rolled.lines).toContain('ok Rolled back 2026_01_02_000000_create_posts_table')
    expect((await run(root, 'migrate:status')).lines).toContain(
      '2026_01_02_000000_create_posts_table | pending',
    )
  })

  test('migrate --seed seeds once per seeder, with recycled parents; db:seed --class', async () => {
    const root = project()
    const { result, lines } = await run(root, 'migrate', { seed: true })
    expect(lines).toContain('ok Seeded DatabaseSeeder')
    expect(lines.filter((l) => l === 'ok Seeded UserSeeder')).toHaveLength(1)
    expect(result).toMatchObject({
      data: { seeded: ['DatabaseSeeder', 'UserSeeder', 'PostSeeder'] },
    })
    expect(await count(root, 'users')).toBe(3)
    expect(await count(root, 'posts')).toBe(6)
    await run(root, 'db:seed', { class: 'UserSeeder' })
    expect(await count(root, 'users')).toBe(6)
    await expect(run(root, 'db:seed', { class: 'NopeSeeder' })).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('NopeSeeder') })],
    })
    await expect(run(root, 'db:seed', { tenant: 'not-a-uuid' })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ['--tenant'] })],
    })
  })

  test('production needs --force; reset, refresh --seed and fresh', async () => {
    const root = project()
    await expect(run(root, 'migrate', {}, 'production')).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ['--force'] })],
    })
    await run(root, 'migrate', { force: true }, 'production')
    await expect(run(root, 'db:seed', {}, 'production')).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ['--force'] })],
    })
    const refreshed = await run(root, 'migrate:refresh', { seed: true })
    expect(refreshed.lines).toContain('ok Rolled back 2026_01_01_000000_create_users_table')
    expect(await count(root, 'posts')).toBe(6)
    const fresh = await run(root, 'migrate:fresh')
    expect(fresh.lines.some((l) => l.startsWith('info Dropped table'))).toBe(true)
    expect(await count(root, 'posts')).toBe(0)
    await run(root, 'migrate:reset')
    expect(
      (await run(root, 'migrate:status')).lines
        .filter((l) => l.includes(' | '))
        .every((l) => l.endsWith('pending')),
    ).toBe(true)
    await expect(run(root, 'migrate:rollback', { step: '0' })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ['--step'] })],
    })
  })

  test('sync regenerates .strutvane offline and is idempotent', async () => {
    const root = project()
    const first = await run(root, 'sync')
    expect(first.lines.some((l) => l.includes('.strutvane/schema.json'))).toBe(true)
    expect((await run(root, 'sync')).lines).toContain('ok .strutvane/ is up to date.')
  })
})
