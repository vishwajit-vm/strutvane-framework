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

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
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
    const applied = await migrate(db, await readProjectMigrations(target.dir))
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
    return await migrationStatus(db, await readProjectMigrations(target.dir))
  } finally {
    if (!options.database) await db.close()
  }
}
