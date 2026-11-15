// Packages ship migrations (`"strutvane": { "migrations": "./migrations" }` in their package.json).
// The CLI decides which packages may contribute and hands the vetted folders over
// (`ctx.packageMigrations()`); the framework never scans node_modules itself. These run as the
// database OWNER, so the attack-style cases below matter: nothing runs unless handed over, and a
// handed-over folder whose dialect folder or files resolve outside the package is refused.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../src/commands.ts'
import { connectDatabase } from '../../src/database/connect.ts'
import { databaseConfigFrom } from '../../src/runtime/database-config.ts'
import {
  migrateProject,
  type PackageMigrationDir,
  projectMigrationStatus,
  readPackageMigrations,
} from '../../src/runtime/migrations.ts'
import { loadProject } from '../../src/runtime/project.ts'
import { makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

const IDENTITY = 'node_modules/@acme/identity'

async function project(extra: Record<string, string> = {}) {
  const p = await makeProject(
    projectFiles({
      [`${IDENTITY}/package.json`]: JSON.stringify({
        name: '@acme/identity',
        version: '1.0.0',
        strutvane: { migrations: './migrations' },
      }),
      [`${IDENTITY}/migrations/sqlite/20260101000000_acme_identity.sql`]:
        'CREATE TABLE IF NOT EXISTS acme_users (id TEXT PRIMARY KEY)',
      [`${IDENTITY}/migrations/postgres/20260101000000_acme_identity.sql`]:
        'CREATE TABLE IF NOT EXISTS acme_users (id uuid PRIMARY KEY)',
      ...extra,
    }),
  )
  cleanups.push(p.cleanup)
  return p.root
}

const vetted = (root: string): PackageMigrationDir[] => [
  { package: '@acme/identity', dir: join(root, IDENTITY, 'migrations') },
]

async function tableExists(root: string, name: string): Promise<boolean> {
  const loaded = await loadProject(root, { dotenv: false })
  const db = await connectDatabase(databaseConfigFrom(loaded.config['database'] as never, root))
  try {
    return (await db.query('SELECT name FROM sqlite_master WHERE name = ?', [name])).length === 1
  } finally {
    await db.close()
  }
}

function context(root: string, flags: CommandContextLike['flags'], dirs?: PackageMigrationDir[]) {
  const lines: string[] = []
  const ctx: CommandContextLike = {
    flags,
    requireProject: () => ({ root }),
    ...(dirs ? { packageMigrations: () => dirs } : {}),
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

const command = (name: string) => {
  const c = commands.find((x) => x.name === name)
  if (!c) throw new Error(name)
  return c
}

describe('package migrations', () => {
  test('a handed-over package folder is applied once, with the app migrations, tagged with its package', async () => {
    const root = await project()
    const loaded = await loadProject(root, { dotenv: false })
    const first = await migrateProject(loaded, { packageMigrations: vetted(root) })
    expect(first.applied).toContain('20260101000000_acme_identity')
    expect(first.applied.at(-1)).not.toBe('20260101000000_acme_identity') // app files after it
    expect(first.packaged).toEqual([
      { name: '20260101000000_acme_identity', source: '@acme/identity' },
    ])
    const again = await migrateProject(loaded, { packageMigrations: vetted(root) })
    expect(again.applied).toEqual([])
    const status = await projectMigrationStatus(loaded, { packageMigrations: vetted(root) })
    expect(status.pending).toEqual([])
    expect(status.drift).toEqual([])
    expect(status.sources).toEqual({ '20260101000000_acme_identity': '@acme/identity' })
    expect(await tableExists(root, 'acme_users')).toBe(true)
    expect((await readPackageMigrations(vetted(root), 'postgres')).map((m) => m.source)).toEqual([
      '@acme/identity',
    ])
  })

  test('attack: an installed dependency that was not handed over never runs (fail closed by default)', async () => {
    const root = await project()
    const loaded = await loadProject(root, { dotenv: false })
    const r = await migrateProject(loaded)
    expect(r.packaged).toEqual([])
    expect(r.applied).not.toContain('20260101000000_acme_identity')
    expect(await tableExists(root, 'acme_users')).toBe(false)
    // An older CLI without ctx.packageMigrations: the command applies none either.
    const c = context(root, {})
    await command('migrate').run(c.ctx)
    expect(c.lines.join('\n')).not.toMatch(/acme_identity/)
    expect(await tableExists(root, 'acme_users')).toBe(false)
  })

  test('attack: a dialect folder that is a link pointing outside the package is refused before anything runs', async () => {
    const root = await project()
    const outside = join(root, 'evil')
    mkdirSync(outside)
    writeFileSync(join(outside, '20260101000000_evil.sql'), 'CREATE TABLE pwned (id TEXT)')
    const pkg = join(root, 'node_modules/@acme/linked')
    mkdirSync(join(pkg, 'migrations'), { recursive: true })
    symlinkSync(outside, join(pkg, 'migrations', 'sqlite'), 'junction')
    const dirs = [{ package: '@acme/linked', dir: join(pkg, 'migrations') }]
    await expect(readPackageMigrations(dirs, 'sqlite')).rejects.toThrow(/outside the package/)
    const loaded = await loadProject(root, { dotenv: false })
    await expect(migrateProject(loaded, { packageMigrations: dirs })).rejects.toThrow(
      /outside the package/,
    )
    expect(await tableExists(root, 'pwned')).toBe(false)
  })

  test('attack: a migration file that is a link pointing outside the package is refused', async (t) => {
    const root = await project()
    const outside = join(root, 'evil.sql')
    writeFileSync(outside, 'CREATE TABLE pwned (id TEXT)')
    const sqlite = join(root, IDENTITY, 'migrations', 'sqlite')
    try {
      symlinkSync(outside, join(sqlite, '20260102000000_evil.sql'), 'file')
    } catch {
      t.skip() // file symlinks need privileges on Windows; the folder case above still runs
    }
    await expect(readPackageMigrations(vetted(root), 'sqlite')).rejects.toThrow(
      /outside the package/,
    )
  })

  test('a package without migrations for the dialect contributes nothing; name clashes are refused', async () => {
    const root = await project({
      'database/migrations/20260101000000_acme_identity.sql': 'SELECT 1',
    })
    expect(
      await readPackageMigrations([{ package: 'x', dir: join(root, 'nope') }], 'sqlite'),
    ).toEqual([])
    const loaded = await loadProject(root, { dotenv: false })
    await expect(migrateProject(loaded, { packageMigrations: vetted(root) })).rejects.toThrow(
      /Two migrations are named 20260101000000_acme_identity/,
    )
  })

  test('migrate --pretend and migrate:status say which package each migration comes from', async () => {
    const root = await project()
    const pretend = context(root, { pretend: true }, vetted(root))
    await command('migrate').run(pretend.ctx)
    expect(pretend.lines).toContain(
      'info Package migration 20260101000000_acme_identity (from @acme/identity): runs if not applied yet',
    )
    expect(await tableExists(root, 'acme_users')).toBe(false)
    const status = context(root, {}, vetted(root))
    await command('migrate:status').run(status.ctx)
    expect(status.lines).toContain('20260101000000_acme_identity | @acme/identity | pending')
    const run = context(root, {}, vetted(root))
    await command('migrate').run(run.ctx)
    expect(run.lines).toContain('ok Applied 20260101000000_acme_identity (from @acme/identity)')
    const after = context(root, {}, vetted(root))
    await command('migrate:status').run(after.ctx)
    expect(after.lines.some((l) => /^\d+_\w+ \| app \| applied/.test(l))).toBe(true)
  })
})
