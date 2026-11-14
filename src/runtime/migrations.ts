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

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { connectDatabase, type DatabaseConfig } from '../database/connect.ts'
import type { Database, Dialect } from '../database/types.ts'
import {
  checksumOf,
  type MigrationSource,
  readMigrations,
  readSnapshot,
  writeMigration,
} from '../migrations/files.ts'
import {
  MIGRATIONS_TABLE,
  type MigrationStatus,
  migrate,
  migrationStatus,
} from '../migrations/migrator.ts'
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
  /**
   * Vetted package migration folders (the CLI's `ctx.packageMigrations()`). Default: none, so
   * nothing outside the app's own folder runs unless the CLI's gate allowed it (fail closed).
   */
  readonly packageMigrations?: readonly PackageMigrationDir[]
}

/** What {@link migrateProject} did. */
export interface MigrateProjectResult {
  /** The migration written for model changes, if any. */
  readonly created: string | undefined
  readonly applied: readonly string[]
  /**
   * Every package migration this run considered, with its package. With `pretend` (no database
   * is opened) these are the ones that run when not applied yet.
   */
  readonly packaged: readonly PackagedMigration[]
}

/** {@link migrationStatus} plus the package each package migration comes from. */
export interface ProjectMigrationStatus extends MigrationStatus {
  /** Migration name → package, for package migrations only. */
  readonly sources: Readonly<Record<string, string>>
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
 * A package's vetted migrations folder, as the CLI hands it over (`ctx.packageMigrations()`).
 *
 * The CLI decides WHICH packages may contribute (the app enabled it in strutvane.config.ts, it is
 * a direct dependency with a contributor name, a third-party one declares a matching
 * `strutvane.compat`, and the folder's real path is inside the package under `node_modules`):
 * the same gate as contributed commands (docs/09 §11). The framework never scans
 * `node_modules` itself, so a dependency nobody enabled can never run SQL as the database owner.
 */
export interface PackageMigrationDir {
  /** The package name, reported next to each of its migrations. */
  readonly package: string
  /** Absolute path of the declared folder; `<dir>/<dialect>/*.sql` are its migrations. */
  readonly dir: string
}

/** `child` is `parent` or below it (both real paths). */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Read the migrations of the given (already vetted) package folders: `<dir>/<dialect>/*.sql`,
 * each tagged with its package as `source`. Their names are timestamped and include the package
 * (e.g. `20261114000000_strutvane_auth_identity`); they are applied and drift-checked exactly
 * like the app's own files.
 *
 * Defence in depth: the dialect folder and every file in it must resolve (after symlinks) inside
 * the package folder, otherwise this throws before anything runs. A package without migrations
 * for the dialect contributes nothing.
 */
export async function readPackageMigrations(
  dirs: readonly PackageMigrationDir[],
  dialect: Dialect,
): Promise<MigrationSource[]> {
  const out: MigrationSource[] = []
  for (const entry of dirs) {
    const sub = join(entry.dir, dialect)
    if (!existsSync(sub)) continue
    const root = realpathSync(entry.dir)
    const refuse = (path: string): Error =>
      new Error(`${entry.package}: migration path ${path} resolves outside the package`)
    if (!isWithin(root, realpathSync(sub))) throw refuse(sub)
    for (const file of readdirSync(sub).filter((f) => f.endsWith('.sql'))) {
      if (!isWithin(root, realpathSync(join(sub, file)))) throw refuse(join(sub, file))
    }
    for (const m of await readMigrations(sub)) out.push({ ...m, source: entry.package })
  }
  return out
}

/** The app's migrations plus those of its enabled packages, in name order. */
async function allMigrations(
  target: MigrationTarget,
  packages: readonly PackageMigrationDir[],
): Promise<MigrationSource[]> {
  const own = await readProjectMigrations(target.dir)
  const packaged = await readPackageMigrations(packages, target.dialect)
  const names = new Set(own.map((m) => m.name))
  for (const m of packaged) {
    if (names.has(m.name)) throw new Error(`Two migrations are named ${m.name}`)
    names.add(m.name)
  }
  return [...own, ...packaged].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** A package migration and the package it comes from. */
export interface PackagedMigration {
  readonly name: string
  readonly source: string
}

const packagedOf = (all: readonly MigrationSource[]): PackagedMigration[] =>
  all.flatMap((m) => (m.source !== undefined ? [{ name: m.name, source: m.source }] : []))

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
  const all = await allMigrations(target, options.packageMigrations ?? [])
  const packaged = packagedOf(all)
  if (options.pretend) return { created, applied: [], packaged }
  const db = options.database ?? (await connectDatabase(target.connection))
  try {
    const applied = await migrate(db, all)
    return { created, applied, packaged }
  } finally {
    if (!options.database) await db.close()
  }
}

/** Applied, pending and drifted migrations, without changing anything. */
export async function projectMigrationStatus(
  project: LoadedProject,
  options: {
    readonly database?: Database
    /** As {@link MigrateProjectOptions.packageMigrations}. */
    readonly packageMigrations?: readonly PackageMigrationDir[]
  } = {},
): Promise<ProjectMigrationStatus> {
  const target = migrationTarget(project)
  const all = await allMigrations(target, options.packageMigrations ?? [])
  const sources = Object.fromEntries(packagedOf(all).map((m) => [m.name, m.source]))
  const db = options.database ?? (await connectDatabase(target.connection))
  try {
    return { ...(await migrationStatus(db, all)), sources }
  } finally {
    if (!options.database) await db.close()
  }
}
