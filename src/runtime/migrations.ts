/**
 * `sv migrate` for a project: diff the models against the last snapshot, write a timestamped
 * migration (plus the new snapshot) into `database/migrations`, then apply every pending one.
 *
 * Planning is prompt-free (ADR-0009): a rename candidate stops with
 * {@link RenameResolutionRequiredError} unless answered (`--rename old=new` / `--separate`), and a
 * destructive change stops with `DestructiveChangeError` unless `allowDestructive` is set.
 *
 * Hand-written migrations live in the same folder: `*.sql` (statements separated by
 * `--> statement-breakpoint`) or `*.ts` (`defineMigration({ up({ db }) {…} })`). All run in name
 * (timestamp) order, each pending one inside the migrator's transaction. There is no rollback
 * yet, so `down()` is recorded for later and never run.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { connectDatabase, type DatabaseConfig } from '../database/connect.ts'
import type { Database, Dialect } from '../database/types.ts'
import {
  checksumOf,
  type MigrationSource,
  readMigrations,
  readSnapshot,
  writeMigration,
} from '../migrations/files.ts'
import { MIGRATIONS_TABLE, migrate, migrationStatus } from '../migrations/migrator.ts'
import { planMigration, type RenameResolver } from '../migrations/planner.ts'
import { createModelRegistry } from '../model/registry.ts'
import { type AppDatabaseConfig, databaseConfigFrom } from './database-config.ts'
import { conventionFiles, importDefault, type LoadedProject } from './project.ts'
import { isMigrationDefinition } from './seeders.ts'

/** Where a project's migrations live and how to connect. */
export interface MigrationTarget {
  readonly dir: string
  readonly connection: DatabaseConfig
  readonly dialect: Dialect
}

/** Resolve the migration directory and connection from `config/database.ts`. */
export function migrationTarget(project: LoadedProject): MigrationTarget {
  const raw = project.config['database'] as AppDatabaseConfig | undefined
  const table = raw?.migrations?.table
  if (table !== undefined && table !== MIGRATIONS_TABLE) {
    throw new Error(
      `config/database.ts: migrations.table must be "${MIGRATIONS_TABLE}" (custom names are not supported yet)`,
    )
  }
  const dirSetting = raw?.migrations?.directory ?? 'database/migrations'
  const connection = databaseConfigFrom(raw, project.root)
  const dialect: Dialect = connection.driver === 'sqlite' ? 'sqlite' : 'postgres'
  return {
    dir: isAbsolute(dirSetting) ? dirSetting : join(project.root, dirSetting),
    connection,
    dialect,
  }
}

/** Options for {@link migrateProject}. */
export interface MigrateProjectOptions {
  /** Migration name used when the models changed. Default `auto`. */
  readonly name?: string
  readonly resolveRename?: RenameResolver
  readonly allowDestructive?: boolean
  /** Write the migration but don't apply anything. */
  readonly pretend?: boolean
  /** Use this connection instead of opening one (tests). */
  readonly database?: Database
}

/** What {@link migrateProject} did. */
export interface MigrateProjectResult {
  /** The migration written for model changes, if any. */
  readonly created: string | undefined
  readonly applied: readonly string[]
}

/**
 * Every migration in `dir`: `.sql` files plus hand-written `.ts` files, sorted by name. A `.ts`
 * file's checksum covers its text, so editing an applied one is reported as drift.
 */
export async function readProjectMigrations(dir: string): Promise<MigrationSource[]> {
  const out = await readMigrations(dir)
  for (const file of conventionFiles(dir, '.', '.ts')) {
    const definition = await importDefault(file)
    if (!isMigrationDefinition(definition))
      throw new Error(`${file} must default-export defineMigration({ up({ db }) { … } })`)
    const name = basename(file, '.ts')
    out.push({
      name,
      statements: [],
      checksum: checksumOf([await readFile(file, 'utf8')]),
      run: async (db) => {
        await definition.up({ db })
      },
    })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Migrations shipped by installed packages: a dependency of the app whose package.json declares
 * `"strutvane": { "migrations": "./migrations" }` contributes `<that folder>/<dialect>/*.sql`
 * (e.g. `@strutvane/auth`'s identity tables), so `sv migrate` creates what the package needs
 * without a separate step. They are applied and tracked exactly like the app's own files (their
 * names are timestamped and include the package, e.g. `20261114000000_strutvane_auth_identity`).
 *
 * Only direct dependencies of the app count (its package.json), resolved inside its own
 * `node_modules`; a folder that escapes the package is refused. A package without migrations for
 * the app's dialect contributes nothing.
 */
export async function readPackageMigrations(
  root: string,
  dialect: Dialect,
): Promise<MigrationSource[]> {
  const manifestFile = join(root, 'package.json')
  if (!existsSync(manifestFile)) return []
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
  const out: MigrationSource[] = []
  for (const name of [...names].sort()) {
    const pkgDir = join(root, 'node_modules', ...name.split('/'))
    const pkgFile = join(pkgDir, 'package.json')
    if (!existsSync(pkgFile)) continue
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
      strutvane?: { migrations?: unknown }
    }
    const folder = pkg.strutvane?.migrations
    if (typeof folder !== 'string') continue
    const dir = resolve(pkgDir, folder, dialect)
    if (dir !== pkgDir && !dir.startsWith(pkgDir + sep))
      throw new Error(`${name}: strutvane.migrations must point inside the package`)
    out.push(...(await readMigrations(dir)))
  }
  return out
}

/** The app's migrations plus those of its packages, in name order. */
async function allMigrations(target: MigrationTarget, root: string): Promise<MigrationSource[]> {
  const own = await readProjectMigrations(target.dir)
  const packaged = await readPackageMigrations(root, target.dialect)
  const names = new Set(own.map((m) => m.name))
  for (const m of packaged)
    if (names.has(m.name)) throw new Error(`Two migrations are named ${m.name}`)
  return [...own, ...packaged].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Generate (when models changed) and apply migrations. */
export async function migrateProject(
  project: LoadedProject,
  options: MigrateProjectOptions = {},
): Promise<MigrateProjectResult> {
  const target = migrationTarget(project)
  const registry = createModelRegistry(project.models.map((m) => m.definition))
  const snapshot = await readSnapshot(target.dir, target.dialect)
  const plan = await planMigration({
    dialect: target.dialect,
    previous: snapshot.models,
    next: registry.all,
    ...(options.resolveRename ? { resolveRename: options.resolveRename } : {}),
    ...(options.allowDestructive ? { allowDestructive: true } : {}),
  })
  const created = await writeMigration(target.dir, plan, registry.all, {
    name: options.name ?? 'auto',
  })
  if (options.pretend) return { created, applied: [] }
  const db = options.database ?? (await connectDatabase(target.connection))
  try {
    const applied = await migrate(db, await allMigrations(target, project.root))
    return { created, applied }
  } finally {
    if (!options.database) await db.close()
  }
}

/** Applied, pending and drifted migrations, without changing anything. */
export async function projectMigrationStatus(
  project: LoadedProject,
  options: { readonly database?: Database } = {},
): ReturnType<typeof migrationStatus> {
  const target = migrationTarget(project)
  const db = options.database ?? (await connectDatabase(target.connection))
  try {
    return await migrationStatus(db, await allMigrations(target, project.root))
  } finally {
    if (!options.database) await db.close()
  }
}
