// Packages ship migrations (`"strutvane": { "migrations": "./migrations" }` in their package.json):
// `sv migrate` applies them with the app's own, per dialect, tracked and drift-checked the same way.
import { afterEach, describe, expect, test } from 'vitest'
import { connectDatabase } from '../../src/database/connect.ts'
import { databaseConfigFrom } from '../../src/runtime/database-config.ts'
import {
  migrateProject,
  projectMigrationStatus,
  readPackageMigrations,
} from '../../src/runtime/migrations.ts'
import { loadProject } from '../../src/runtime/project.ts'
import { makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const pkg = (migrations: string) =>
  JSON.stringify({ name: '@acme/identity', version: '1.0.0', strutvane: { migrations } })

async function project(extra: Record<string, string>) {
  const p = await makeProject(
    projectFiles({
      'package.json': JSON.stringify({
        name: 'demo',
        dependencies: { '@acme/identity': '1.0.0', 'plain-lib': '1.0.0' },
      }),
      'node_modules/plain-lib/package.json': JSON.stringify({
        name: 'plain-lib',
        version: '1.0.0',
      }),
      ...extra,
    }),
  )
  cleanups.push(p.cleanup)
  return p.root
}

describe('package migrations', () => {
  test('a dependency ships per-dialect SQL; sv migrate applies it once with the app migrations', async () => {
    const root = await project({
      'node_modules/@acme/identity/package.json': pkg('./migrations'),
      'node_modules/@acme/identity/migrations/sqlite/20260101000000_acme_identity.sql':
        'CREATE TABLE IF NOT EXISTS acme_users (id TEXT PRIMARY KEY)',
      'node_modules/@acme/identity/migrations/postgres/20260101000000_acme_identity.sql':
        'CREATE TABLE IF NOT EXISTS acme_users (id uuid PRIMARY KEY)',
    })
    const loaded = await loadProject(root, { dotenv: false })
    const first = await migrateProject(loaded)
    expect(first.applied).toContain('20260101000000_acme_identity')
    expect(first.applied.at(-1)).not.toBe('20260101000000_acme_identity') // app files after it
    const again = await migrateProject(loaded)
    expect(again.applied).toEqual([])
    const status = await projectMigrationStatus(loaded)
    expect(status.pending).toEqual([])
    expect(status.drift).toEqual([])
    const db = await connectDatabase(databaseConfigFrom(loaded.config['database'] as never, root))
    try {
      expect(
        await db.query("SELECT name FROM sqlite_master WHERE name = 'acme_users'"),
      ).toHaveLength(1)
    } finally {
      await db.close()
    }
    expect((await readPackageMigrations(root, 'postgres')).map((m) => m.name)).toEqual([
      '20260101000000_acme_identity',
    ])
  })

  test('a migrations folder that escapes the package is refused; missing pieces contribute nothing', async () => {
    const escaping = await project({ 'node_modules/@acme/identity/package.json': pkg('../../..') })
    await expect(readPackageMigrations(escaping, 'sqlite')).rejects.toThrow(/inside the package/)
    const missing = await project({ 'node_modules/@acme/identity/package.json': pkg('./nope') })
    expect(await readPackageMigrations(missing, 'sqlite')).toEqual([])
    const noManifest = await makeProject({})
    cleanups.push(noManifest.cleanup)
    expect(await readPackageMigrations(noManifest.root, 'sqlite')).toEqual([])
  })
})
