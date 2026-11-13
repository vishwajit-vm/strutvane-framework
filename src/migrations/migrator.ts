/**
 * The migrator: applies pending migrations exactly once, in order, under a lock.
 *
 * - **Atomic batch:** all pending migrations run in one transaction (Postgres and SQLite both
 *   have transactional DDL). Either every migration applies or none does.
 * - **Locked:** Postgres takes `pg_advisory_xact_lock`, so two deploys migrating at once
 *   serialise and the second sees the first's work; SQLite's write transaction is exclusive.
 * - **Tracked:** `strutvane_migrations` records each migration's name, checksum, batch and time.
 * - **Drift-checked:** an applied migration whose file changed (checksum mismatch) or vanished
 *   stops the run. History is never rewritten silently.
 *
 * @module
 */
import type { Database } from '../database/types.ts'
import type { ModelDefinition } from '../model/define-model.ts'
import { tableColumns } from '../schema/compile.ts'
import type { MigrationSource } from './files.ts'

/** The tracking table. */
export const MIGRATIONS_TABLE = 'strutvane_migrations'

/** Arbitrary constant key for the Postgres advisory lock ("strutvane" in ASCII-ish). */
const LOCK_KEY = 7_316_247_201

/** A row of the tracking table. */
export interface AppliedMigration {
  readonly name: string
  readonly checksum: string
  readonly batch: number
  readonly appliedAt: string
}

/** One discrepancy between the files and the database's history. */
export interface MigrationDrift {
  readonly name: string
  /** `changed`: applied, but the file differs. `missing`: applied, but no file exists. */
  readonly kind: 'changed' | 'missing'
}

/** Thrown when history and files disagree. */
export class MigrationDriftError extends Error {
  override readonly name = 'MigrationDriftError'
  readonly drift: readonly MigrationDrift[]
  constructor(drift: readonly MigrationDrift[]) {
    super(
      `Migration history does not match the files: ${drift.map((d) => `${d.name} (${d.kind})`).join(', ')}`,
    )
    this.drift = drift
  }
}

/** The migration status of a database. */
export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[]
  readonly pending: readonly string[]
  readonly drift: readonly MigrationDrift[]
}

async function ensureTable(db: Database): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
       "name" TEXT PRIMARY KEY NOT NULL,
       "checksum" TEXT NOT NULL,
       "batch" INTEGER NOT NULL,
       "applied_at" TEXT NOT NULL
     )`,
  )
}

async function readApplied(db: Database): Promise<AppliedMigration[]> {
  const rows = await db.query<{
    name: string
    checksum: string
    batch: number | bigint
    applied_at: string
  }>(`SELECT "name", "checksum", "batch", "applied_at" FROM "${MIGRATIONS_TABLE}" ORDER BY "name"`)
  return rows.map((r) => ({
    name: r.name,
    checksum: r.checksum,
    batch: Number(r.batch),
    appliedAt: r.applied_at,
  }))
}

function compare(
  applied: readonly AppliedMigration[],
  migrations: readonly MigrationSource[],
): MigrationStatus {
  assertSorted(migrations)
  const byName = new Map(migrations.map((m) => [m.name, m]))
  const done = new Set(applied.map((a) => a.name))
  const drift: MigrationDrift[] = []
  for (const a of applied) {
    const m = byName.get(a.name)
    if (!m) drift.push({ name: a.name, kind: 'missing' })
    else if (m.checksum !== a.checksum) drift.push({ name: a.name, kind: 'changed' })
  }
  return { applied, pending: migrations.filter((m) => !done.has(m.name)).map((m) => m.name), drift }
}

function assertSorted(migrations: readonly MigrationSource[]): void {
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1] as MigrationSource
    const cur = migrations[i] as MigrationSource
    if (prev.name >= cur.name)
      throw new Error(
        `Migrations must be uniquely named and sorted: "${prev.name}" >= "${cur.name}"`,
      )
  }
}

/** Report applied, pending and drifted migrations without changing anything. */
export async function migrationStatus(
  db: Database,
  migrations: readonly MigrationSource[],
): Promise<MigrationStatus> {
  await ensureTable(db)
  return compare(await readApplied(db), migrations)
}

/** Options for {@link migrate}. */
export interface MigrateOptions {
  /** Clock for `applied_at` (tests). */
  readonly now?: () => Date
}

/**
 * Apply every pending migration. Returns the names applied (empty when up to date).
 * Throws {@link MigrationDriftError} before applying anything if history and files disagree.
 */
export async function migrate(
  db: Database,
  migrations: readonly MigrationSource[],
  options: MigrateOptions = {},
): Promise<string[]> {
  const now = options.now ?? (() => new Date())
  return db.transaction(async (tx) => {
    if (tx.dialect === 'postgres') await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`)
    // Foreign keys are checked at COMMIT, so SQLite table rebuilds (drizzle-kit's path for
    // altering columns) cannot fail half-way on rows that point at the table being rebuilt.
    else await tx.execute('PRAGMA defer_foreign_keys = ON')
    await ensureTable(tx)
    const applied = await readApplied(tx)
    const status = compare(applied, migrations)
    if (status.drift.length > 0) throw new MigrationDriftError(status.drift)
    const batch = applied.reduce((max, a) => Math.max(max, a.batch), 0) + 1
    const pending = new Set(status.pending)
    const done: string[] = []
    for (const m of migrations) {
      if (!pending.has(m.name)) continue
      for (const statement of m.statements) {
        // `PRAGMA foreign_keys` is a no-op inside a transaction; deferral above covers it.
        if (/^PRAGMA\s+foreign_keys\s*=/i.test(statement)) continue
        await tx.execute(statement)
      }
      if (m.run) await m.run(tx)
      await tx.execute(
        tx.dialect === 'postgres'
          ? `INSERT INTO "${MIGRATIONS_TABLE}" ("name", "checksum", "batch", "applied_at") VALUES ($1, $2, $3, $4)`
          : `INSERT INTO "${MIGRATIONS_TABLE}" ("name", "checksum", "batch", "applied_at") VALUES (?, ?, ?, ?)`,
        [m.name, m.checksum, batch, now().toISOString()],
      )
      done.push(m.name)
    }
    return done
  })
}

/** A column-level difference between the models and the live database. */
export interface SchemaDrift {
  readonly table: string
  readonly column?: string
  readonly kind: 'missingTable' | 'missingColumn' | 'extraColumn'
}

/** Live column names per table (current schema on Postgres, main database on SQLite). */
export async function introspectColumns(db: Database): Promise<Map<string, Set<string>>> {
  const rows =
    db.dialect === 'postgres'
      ? await db.query<{ t: string; c: string }>(
          `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()`,
        )
      : await db.query<{ t: string; c: string }>(
          `SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'`,
        )
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = out.get(r.t) ?? new Set<string>()
    set.add(r.c)
    out.set(r.t, set)
  }
  return out
}

/**
 * Compare the models with the live schema (tables and columns). An empty list means the
 * database has exactly the columns the models describe. Catches hand edits and forgotten
 * migrations; used by `sv migrate:status` and `/ready`-style checks.
 */
export async function detectSchemaDrift(
  db: Database,
  models: readonly ModelDefinition[],
): Promise<SchemaDrift[]> {
  const live = await introspectColumns(db)
  const out: SchemaDrift[] = []
  for (const m of models) {
    const actual = live.get(m.table)
    if (!actual) {
      out.push({ table: m.table, kind: 'missingTable' })
      continue
    }
    const expected = new Set(tableColumns(m))
    for (const c of expected)
      if (!actual.has(c)) out.push({ table: m.table, column: c, kind: 'missingColumn' })
    for (const c of actual)
      if (!expected.has(c)) out.push({ table: m.table, column: c, kind: 'extraColumn' })
  }
  return out
}
