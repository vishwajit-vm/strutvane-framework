/**
 * The v2 migrator: `node strut migrate`, `migrate:rollback`, `migrate:reset`, `migrate:refresh`,
 * `migrate:fresh` and `migrate:status`, Laravel-style, over the ORM {@link Connection}.
 *
 * The SQL comes from the **same** recorded operations the types and metadata are generated from
 * (a {@link Replay}, normally from the replay sandbox), compiled per engine by `upSql`/`downSql`.
 * What runs and what TypeScript believes can't drift apart.
 *
 * **Bookkeeping.** A `migrations` table (Laravel's name, decision #36) records every migration that
 * ran: its name, its batch, a checksum of its recorded operations (so an edited migration is
 * noticed, never silently skipped), and, on MySQL/MariaDB, how far it got.
 *
 * **Atomic migrations (decision #121).**
 * - PostgreSQL and SQLite have transactional DDL: a migration's statements **and** its
 *   `migrations` row commit in one transaction, so a failure leaves nothing behind.
 * - MySQL and MariaDB commit every DDL statement on its own. Each statement is recorded as it
 *   completes (`progress`), so after a failure the error lists exactly what was applied, and the
 *   next `node strut migrate` resumes after the last completed statement instead of failing on
 *   "column already exists". Rollbacks are recorded the same way (`undo_progress`).
 *
 * **One migrator at a time.** The whole run holds a lock on one pinned connection: PostgreSQL's
 * session advisory lock and MySQL/MariaDB's `GET_LOCK`, both named after the current database.
 * By default a second deploy waits up to {@link DEFAULT_LOCK_TIMEOUT_MS} for the first and then
 * fails with `migration_locked`. With `isolated: true` (`--isolated`) it does not wait: when
 * another migrator holds the lock it returns `{ locked: true }` and changes nothing (Laravel's
 * behaviour, so N replicas starting at once run the migrations exactly once). SQLite has a single
 * writer: its own database lock serialises each migration's transaction.
 *
 * **Fail closed.** A ran migration whose file is gone, or whose operations changed since it ran,
 * stops every command except `status` with a plain-words explanation and the fix.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { Connection } from '../database/db/connection.ts'
import type { Row } from '../database/db/driver.ts'
import { type SqlFragment, sql } from '../database/sql/fragment.ts'
import { findColumn, findTable, type SchemaState } from '../schema/columns.ts'
import { downSql, upSql } from '../schema/ddl/ddl.ts'
import type { Dialect } from '../schema/ddl/dialect.ts'
import { SchemaError } from '../schema/errors.ts'
import type { ReplayedStep } from '../schema/operations.ts'
import type { Replay } from '../schema/replay.ts'
import { MigrationError } from './migration-error.ts'
import { exec, isMysqlFamily, migrationLock } from './runner-sql.ts'

export { MigrationError, type MigrationErrorCode } from './migration-error.ts'

/** The bookkeeping table (Laravel's name, decision #36). */
export const MIGRATIONS_TABLE = 'migrations'

/** How long a migrator waits for another one to finish, by default (ms). */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000

/**
 * A row of the `migrations` table.
 *
 * @example
 * const row: RanMigration = { migration: '2026_01_01_000000_create_users_table', batch: 1, checksum: 'ab…', progress: null, undoProgress: null }
 */
export interface RanMigration {
  readonly migration: string
  readonly batch: number
  /** SHA-256 of the migration's recorded operations when it ran. */
  readonly checksum: string
  /**
   * MySQL/MariaDB only: how many `up` statements completed, while the migration is unfinished.
   * `null` once it completed.
   */
  readonly progress: number | null
  /** MySQL/MariaDB only: how many `down` statements completed during an unfinished rollback. */
  readonly undoProgress: number | null
}

/**
 * Why history and files disagree.
 * - `missing`: the migration ran, but its file is gone.
 * - `changed`: the migration ran, but its operations are different now.
 * - `partial`: a MySQL/MariaDB migration (or rollback) stopped half-way.
 *
 * @example
 * const drift: MigrationDrift = { migration: '2026_…_create_posts_table', kind: 'changed' }
 */
export interface MigrationDrift {
  readonly migration: string
  readonly kind: 'missing' | 'changed' | 'partial'
}

/**
 * What `migrate:status` shows.
 *
 * @example
 * const { ran, pending, drift } = await migrationStatus(connection, replay)
 */
export interface MigrationStatus {
  readonly ran: readonly RanMigration[]
  readonly pending: readonly string[]
  readonly drift: readonly MigrationDrift[]
}

/**
 * Progress reported while commands run (the CLI prints these).
 *
 * @example
 * migrate(connection, replay, { onEvent: (event) => log(event) })
 */
export type MigrationEvent =
  | { readonly type: 'migrating'; readonly migration: string; readonly statements: number }
  | { readonly type: 'resuming'; readonly migration: string; readonly from: number }
  | {
      readonly type: 'statement'
      readonly migration: string
      readonly index: number
      readonly sql: string
    }
  | { readonly type: 'migrated'; readonly migration: string; readonly batch: number }
  | { readonly type: 'rolling-back'; readonly migration: string; readonly statements: number }
  | { readonly type: 'rolled-back'; readonly migration: string }
  | { readonly type: 'dropped'; readonly table: string }
  | { readonly type: 'warning'; readonly warning: MigrationWarning }

/**
 * A pre-flight finding that doesn't stop the run but deserves a look.
 *
 * @example
 * const warning: MigrationWarning = { migration: '…', code: 'looks_like_rename', message: '…', hint: '…' }
 */
export interface MigrationWarning {
  readonly migration: string
  readonly code: 'looks_like_rename'
  readonly message: string
  readonly hint: string
}

/**
 * Options for {@link migrate}.
 *
 * @example
 * await migrate(connection, replay, { step: true, onEvent })
 */
export interface MigrateOptions {
  /** One batch per migration (`--step`), so `migrate:rollback` undoes them one at a time. */
  readonly step?: boolean
  /** Return the SQL that would run (`--pretend`); touch nothing, take no lock. */
  readonly pretend?: boolean
  /** Don't wait when another migrator holds the lock: return `{ locked: true }` (`--isolated`). */
  readonly isolated?: boolean
  /** How long to wait for another migrator, in ms. Default {@link DEFAULT_LOCK_TIMEOUT_MS}. */
  readonly lockTimeoutMs?: number
  /** Called for every step of progress. */
  readonly onEvent?: (event: MigrationEvent) => void
}

/**
 * The SQL one migration would run.
 *
 * @example
 * const planned: PlannedMigration = { migration: '…_create_tags_table', statements: ['CREATE TABLE …'] }
 */
export interface PlannedMigration {
  readonly migration: string
  readonly statements: readonly string[]
}

/**
 * What {@link migrate} did.
 *
 * @example
 * const { ran, batch } = await migrate(connection, replay)
 */
export interface MigrateResult {
  /** Migrations applied by this run, in order. */
  readonly ran: readonly string[]
  /** The batch they ran in (the last one with `step`), or `undefined` when nothing ran. */
  readonly batch: number | undefined
  /** With `pretend`: the SQL each pending migration would run. Empty otherwise. */
  readonly pretend: readonly PlannedMigration[]
  /** Pre-flight findings worth a look. */
  readonly warnings: readonly MigrationWarning[]
  /** `true` when `isolated` was set and another migrator held the lock: nothing ran. */
  readonly locked: boolean
}

/**
 * Options for {@link rollback}.
 *
 * @example
 * await rollback(connection, replay, { step: 2 })
 */
export interface RollbackOptions {
  /** Undo the last `step` migrations instead of the last batch (`--step`). */
  readonly step?: number
  /** Undo this batch (`--batch`). */
  readonly batch?: number
  /** Return the SQL that would run (`--pretend`). */
  readonly pretend?: boolean
  readonly isolated?: boolean
  readonly lockTimeoutMs?: number
  readonly onEvent?: (event: MigrationEvent) => void
}

/**
 * What {@link rollback} did.
 *
 * @example
 * const { rolledBack } = await rollback(connection, replay)
 */
export interface RollbackResult {
  /** Migrations undone, newest first. */
  readonly rolledBack: readonly string[]
  readonly pretend: readonly PlannedMigration[]
  readonly locked: boolean
}

/** Options shared by {@link reset}, {@link refresh} and {@link fresh}. */
export interface MaintenanceOptions {
  readonly isolated?: boolean
  readonly lockTimeoutMs?: number
  readonly onEvent?: (event: MigrationEvent) => void
  /** {@link refresh} and {@link fresh}: one batch per migration. */
  readonly step?: boolean
}

/**
 * The checksum a migration is recorded with: SHA-256 of its recorded `up` and `down` operations in
 * a canonical form (object keys sorted), so the same migration gives the same checksum whether it
 * was replayed in process or in the sandbox.
 *
 * @example
 * migrationChecksum(replay.migrations[0]) // '3f2a…' (64 hex characters)
 */
export function migrationChecksum(step: Pick<ReplayedStep, 'up' | 'down'>): string {
  return createHash('sha256')
    .update(canonicalJson({ up: step.up, down: step.down }))
    .digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Applied, pending and drifted migrations, without changing anything (not even creating the
 * `migrations` table).
 *
 * @example
 * const status = await migrationStatus(connection, replay)
 * status.pending // ['2026_11_14_093000_create_posts_table']
 */
export async function migrationStatus(
  connection: Connection,
  replay: Replay,
): Promise<MigrationStatus> {
  const ran = (await trackingTableExists(connection)) ? await ranMigrations(connection) : []
  return { ran, pending: pendingNames(ran, replay), drift: driftOf(ran, replay) }
}

/**
 * Run every pending migration: as one new batch, or one batch each with `step`. Under the
 * migration lock; fails closed on drift (see the module docs).
 *
 * @example
 * const { ran, batch } = await migrate(connection, replay)
 * // ran: ['2026_01_01_000000_create_users_table', …], batch: 1
 */
export async function migrate(
  connection: Connection,
  replay: Replay,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  assertNoReservedTable(replay)
  const dialect = dialectOf(connection)
  if (options.pretend === true) {
    const ran = (await trackingTableExists(connection)) ? await ranMigrations(connection) : []
    assertNoDrift(ran, replay, ['partial'])
    const plans = planPending(ran, replay, dialect)
    return {
      ran: [],
      batch: undefined,
      pretend: plans.map((plan) => ({
        migration: plan.step.name,
        statements: plan.statements.slice(plan.from),
      })),
      warnings: lint(plans.map((plan) => plan.step)),
      locked: false,
    }
  }
  const outcome = await migrationLock(connection, lockOptions(options), async () => {
    await ensureTrackingTable(connection)
    return runPending(connection, replay, options)
  })
  return outcome.locked
    ? { ran: [], batch: undefined, pretend: [], warnings: [], locked: true }
    : outcome.value
}

/**
 * Undo migrations by running their recorded `down()` operations, newest first: the last batch by
 * default, the last `step` migrations, or one `batch`.
 *
 * @example
 * await rollback(connection, replay)            // the last batch
 * await rollback(connection, replay, { step: 1 }) // just the newest migration
 */
export async function rollback(
  connection: Connection,
  replay: Replay,
  options: RollbackOptions = {},
): Promise<RollbackResult> {
  if (options.step !== undefined && (!Number.isSafeInteger(options.step) || options.step < 1))
    throw new RangeError('rollback step must be a whole number of 1 or more')
  if (options.pretend === true) {
    const ran = (await trackingTableExists(connection)) ? await ranMigrations(connection) : []
    const targets = rollbackTargets(ran, options)
    const steps = stepsFor(targets, replay)
    return {
      rolledBack: [],
      pretend: steps.map((step) => ({
        migration: step.name,
        statements: downSql(step, dialectOf(connection)),
      })),
      locked: false,
    }
  }
  const outcome = await migrationLock(connection, lockOptions(options), async () => {
    if (!(await trackingTableExists(connection))) return []
    const ran = await ranMigrations(connection)
    return undo(connection, replay, rollbackTargets(ran, options), options.onEvent)
  })
  return outcome.locked
    ? { rolledBack: [], pretend: [], locked: true }
    : { rolledBack: outcome.value, pretend: [], locked: false }
}

/**
 * Undo every migration, newest first (`migrate:reset`).
 *
 * @example
 * await reset(connection, replay) // back to an empty schema (the migrations table stays)
 */
export async function reset(
  connection: Connection,
  replay: Replay,
  options: MaintenanceOptions = {},
): Promise<RollbackResult> {
  const outcome = await migrationLock(connection, lockOptions(options), async () => {
    if (!(await trackingTableExists(connection))) return []
    const ran = await ranMigrations(connection)
    return undo(connection, replay, [...ran].reverse(), options.onEvent)
  })
  return outcome.locked
    ? { rolledBack: [], pretend: [], locked: true }
    : { rolledBack: outcome.value, pretend: [], locked: false }
}

/**
 * Undo every migration, then run them all again (`migrate:refresh`).
 *
 * @example
 * await refresh(connection, replay)
 */
export async function refresh(
  connection: Connection,
  replay: Replay,
  options: MaintenanceOptions = {},
): Promise<MigrateResult & { readonly rolledBack: readonly string[] }> {
  const outcome = await migrationLock(connection, lockOptions(options), async () => {
    let rolledBack: string[] = []
    if (await trackingTableExists(connection)) {
      const ran = await ranMigrations(connection)
      rolledBack = await undo(connection, replay, [...ran].reverse(), options.onEvent)
    }
    await ensureTrackingTable(connection)
    return { ...(await runPending(connection, replay, options)), rolledBack }
  })
  return outcome.locked
    ? { ran: [], batch: undefined, pretend: [], warnings: [], locked: true, rolledBack: [] }
    : outcome.value
}

/**
 * Drop **every** table in the database, including ones no migration created, then run every
 * migration (`migrate:fresh`). Destructive: the CLI asks first outside local development.
 *
 * @example
 * await fresh(connection, replay)
 */
export async function fresh(
  connection: Connection,
  replay: Replay,
  options: MaintenanceOptions = {},
): Promise<MigrateResult & { readonly dropped: readonly string[] }> {
  assertNoReservedTable(replay)
  const outcome = await migrationLock(connection, lockOptions(options), async () => {
    const dropped = await dropAllTables(connection)
    for (const table of dropped) options.onEvent?.({ type: 'dropped', table })
    await ensureTrackingTable(connection)
    return { ...(await runPending(connection, replay, options)), dropped }
  })
  return outcome.locked
    ? { ran: [], batch: undefined, pretend: [], warnings: [], locked: true, dropped: [] }
    : outcome.value
}

/**
 * Every row of the `migrations` table, oldest first.
 *
 * @example
 * (await ranMigrations(connection)).map((row) => row.migration)
 */
export async function ranMigrations(connection: Connection): Promise<RanMigration[]> {
  const { rows } = await connection.run(
    sql`SELECT ${sql.id('migration')}, ${sql.id('batch')}, ${sql.id('checksum')}, ${sql.id('progress')}, ${sql.id('undo_progress')} FROM ${sql.id(MIGRATIONS_TABLE)} ORDER BY ${sql.id('id')}`,
  )
  return rows.map((row: Row) => ({
    migration: String(row['migration']),
    batch: Number(row['batch']),
    checksum: String(row['checksum']),
    progress: nullableNumber(row['progress']),
    undoProgress: nullableNumber(row['undo_progress']),
  }))
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

interface PendingPlan {
  readonly step: ReplayedStep
  readonly statements: readonly string[]
  /** Statements already applied by an earlier, interrupted run (MySQL/MariaDB). */
  readonly from: number
  /** The row of an interrupted run, to resume. */
  readonly partial: RanMigration | undefined
}

function lockOptions(options: { readonly isolated?: boolean; readonly lockTimeoutMs?: number }): {
  readonly isolated: boolean
  readonly timeoutMs: number
} {
  return {
    isolated: options.isolated === true,
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  }
}

function dialectOf(connection: Connection): Dialect {
  return connection.grammar.dialect
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** The bookkeeping table can't also be an app table: its rows would be mixed with the app's. */
function assertNoReservedTable(replay: Replay): void {
  for (const step of replay.migrations) {
    if (findTable(step.after, MIGRATIONS_TABLE) !== undefined)
      throw new MigrationError(
        'reserved_table',
        `${step.name} creates a table called "${MIGRATIONS_TABLE}", the name Strutvane uses to remember which migrations ran.`,
        'Rename the table in that migration (for example "data_migrations").',
        { migration: step.name },
      )
  }
}

function pendingNames(ran: readonly RanMigration[], replay: Replay): string[] {
  const done = new Map(ran.map((row) => [row.migration, row]))
  return replay.migrations
    .filter((step) => {
      const row = done.get(step.name)
      return row === undefined || row.progress !== null
    })
    .map((step) => step.name)
}

function driftOf(ran: readonly RanMigration[], replay: Replay): MigrationDrift[] {
  const known = new Map(replay.migrations.map((step) => [step.name, step]))
  const drift: MigrationDrift[] = []
  for (const row of ran) {
    const step = known.get(row.migration)
    if (step === undefined) drift.push({ migration: row.migration, kind: 'missing' })
    else if (migrationChecksum(step) !== row.checksum)
      drift.push({ migration: row.migration, kind: 'changed' })
    else if (row.progress !== null || row.undoProgress !== null)
      drift.push({ migration: row.migration, kind: 'partial' })
  }
  return drift
}

/** Refuse to act on a history that doesn't match the files (`allowed` kinds are handled later). */
function assertNoDrift(
  ran: readonly RanMigration[],
  replay: Replay,
  allowed: readonly MigrationDrift['kind'][] = [],
): void {
  for (const drift of driftOf(ran, replay)) {
    if (allowed.includes(drift.kind)) continue
    throw driftError(drift)
  }
}

function driftError(drift: MigrationDrift): MigrationError {
  switch (drift.kind) {
    case 'missing':
      return new MigrationError(
        'migration_file_missing',
        `The database says "${drift.migration}" ran, but there is no such migration file.`,
        `Restore the file (from version control) so Strutvane knows what the database looks like, or, if you are sure it never mattered, delete its row from the "${MIGRATIONS_TABLE}" table.`,
        { migration: drift.migration },
      )
    case 'changed':
      return new MigrationError(
        'migration_changed',
        `"${drift.migration}" changed after it ran: its schema operations are different now, so the database no longer matches it.`,
        'Undo your edit and put the change in a new migration (node strut make:migration …). Migrations that already ran must never change.',
        { migration: drift.migration },
      )
    case 'partial':
      return new MigrationError(
        'migration_partial',
        `"${drift.migration}" stopped half-way the last time it ran.`,
        'Run node strut migrate to finish it (it resumes after the last completed statement), or fix the database by hand.',
        { migration: drift.migration },
      )
  }
}

function planPending(
  ran: readonly RanMigration[],
  replay: Replay,
  dialect: Dialect,
): PendingPlan[] {
  const rows = new Map(ran.map((row) => [row.migration, row]))
  const plans: PendingPlan[] = []
  for (const step of replay.migrations) {
    const row = rows.get(step.name)
    if (row !== undefined && row.progress === null) continue
    plans.push({
      step,
      statements: compileUp(step, dialect),
      from: row?.progress ?? 0,
      partial: row,
    })
  }
  return plans
}

/** The migrations that still have to run (or finish), in order, without compiling them. */
function pendingSteps(ran: readonly RanMigration[], replay: Replay): ReplayedStep[] {
  const pending = new Set(pendingNames(ran, replay))
  return replay.migrations.filter((step) => pending.has(step.name))
}

function compileUp(step: ReplayedStep, dialect: Dialect): string[] {
  try {
    return upSql(step, dialect)
  } catch (error) {
    if (error instanceof SchemaError)
      throw new MigrationError(
        'migration_not_portable',
        `${step.name}: ${error.message}`,
        error.hint,
        { migration: step.name, cause: error },
      )
    throw error
  }
}

/** Pre-flight lint that needs no database: drop + add of the same kind looks like a rename. */
function lint(steps: readonly ReplayedStep[]): MigrationWarning[] {
  const warnings: MigrationWarning[] = []
  for (const step of steps) {
    for (const operation of step.up) {
      if (operation.type !== 'alterTable') continue
      const table = findTable(step.before, operation.table)
      if (table === undefined) continue
      const dropped = operation.actions.flatMap((action) =>
        action.type === 'dropColumn' ? [findColumn(table, action.name)] : [],
      )
      for (const action of operation.actions) {
        if (action.type !== 'addColumn') continue
        const twin = dropped.find((column) => column?.kind === action.column.kind)
        if (twin === undefined) continue
        warnings.push({
          migration: step.name,
          code: 'looks_like_rename',
          message: `${step.name} drops "${operation.table}.${twin.name}" and adds "${action.column.name}" of the same type: that deletes the data in "${twin.name}".`,
          hint: `If it is a rename, use t.renameColumn('${twin.name}', '${action.column.name}') instead, which keeps the data.`,
        })
      }
    }
  }
  return warnings
}

/**
 * Database-backed pre-flight check: a NOT NULL column without a default can't be added to a table
 * that has rows. PostgreSQL and SQLite refuse it half-way through a migration; MySQL and MariaDB
 * accept it and silently fill `0`/`''`. Refused up front, on every engine, before anything runs.
 */
async function assertSafeOnData(
  connection: Connection,
  steps: readonly ReplayedStep[],
): Promise<void> {
  const created = new Set<string>()
  for (const step of steps) {
    for (const operation of step.up) {
      if (operation.type === 'createTable') created.add(operation.table)
      if (operation.type !== 'alterTable' || created.has(operation.table)) continue
      for (const action of operation.actions) {
        if (action.type !== 'addColumn') continue
        const column = action.column
        if (column.nullable || column.kind === 'id' || column.default !== undefined) continue
        if (!(await tableHasRows(connection, operation.table))) continue
        throw new MigrationError(
          'not_null_without_default',
          `${step.name} adds the required column "${operation.table}.${column.name}" without a default, but "${operation.table}" already has rows.`,
          'Give the column a default (.default(…)) or make it .nullable(), then fill it in and tighten it in a later migration.',
          { migration: step.name },
        )
      }
    }
  }
}

async function tableHasRows(connection: Connection, table: string): Promise<boolean> {
  if (!(await tableExists(connection, table))) return false
  const { rows } = await connection.run(
    sql`SELECT 1 AS ${sql.id('one')} FROM ${sql.id(table)} LIMIT 1`,
  )
  return rows.length > 0
}

async function runPending(
  connection: Connection,
  replay: Replay,
  options: MaintenanceOptions & { readonly step?: boolean },
): Promise<MigrateResult> {
  const dialect = dialectOf(connection)
  const ran = await ranMigrations(connection)
  assertNoDrift(ran, replay, ['partial'])
  for (const row of ran) {
    if (row.undoProgress !== null) throw driftError({ migration: row.migration, kind: 'partial' })
  }
  const steps = pendingSteps(ran, replay)
  const warnings = lint(steps)
  for (const warning of warnings) options.onEvent?.({ type: 'warning', warning })
  await assertSafeOnData(connection, steps)
  const plans = planPending(ran, replay, dialect)
  let batch = ran.reduce((max, row) => Math.max(max, row.batch), 0)
  if (plans.some((plan) => plan.partial === undefined)) batch += 1
  const done: string[] = []
  let lastBatch: number | undefined
  let first = true
  for (const plan of plans) {
    const thisBatch = plan.partial?.batch ?? (options.step === true && !first ? ++batch : batch)
    if (plan.partial === undefined) first = false
    await applyOne(connection, plan, thisBatch, options.onEvent)
    done.push(plan.step.name)
    lastBatch = thisBatch
    options.onEvent?.({ type: 'migrated', migration: plan.step.name, batch: thisBatch })
  }
  return { ran: done, batch: lastBatch, pretend: [], warnings, locked: false }
}

async function applyOne(
  connection: Connection,
  plan: PendingPlan,
  batch: number,
  onEvent: ((event: MigrationEvent) => void) | undefined,
): Promise<void> {
  const { step, statements } = plan
  const checksum = migrationChecksum(step)
  if (plan.partial !== undefined)
    onEvent?.({ type: 'resuming', migration: step.name, from: plan.from })
  else onEvent?.({ type: 'migrating', migration: step.name, statements: statements.length })
  if (!isMysqlFamily(dialectOf(connection))) {
    // Transactional DDL: the statements and the bookkeeping row commit together, or not at all.
    let index = 0
    try {
      await connection.transaction(async () => {
        for (; index < statements.length; index++) {
          const statement = statements[index] as string
          onEvent?.({ type: 'statement', migration: step.name, index, sql: statement })
          await exec(connection, statement)
        }
        await insertRow(connection, step.name, batch, checksum, null)
      })
    } catch (error) {
      throw new MigrationError(
        'migration_failed',
        `${step.name} failed${index < statements.length ? ` at statement ${index + 1} of ${statements.length}` : ''}: ${messageOf(error)}`,
        'Nothing from this migration was applied (it ran in one transaction). Fix the migration or the data, then run node strut migrate again.',
        {
          migration: step.name,
          applied: [],
          ...(index < statements.length ? { failed: statements[index] as string } : {}),
          cause: error,
        },
      )
    }
    return
  }
  // MySQL/MariaDB: DDL commits on its own, so record each statement as it completes.
  if (plan.partial === undefined) await insertRow(connection, step.name, batch, checksum, 0)
  let index = plan.from
  try {
    for (; index < statements.length; index++) {
      const statement = statements[index] as string
      onEvent?.({ type: 'statement', migration: step.name, index, sql: statement })
      await exec(connection, statement)
      await setProgress(connection, step.name, 'progress', index + 1)
    }
    await setProgress(connection, step.name, 'progress', null)
  } catch (error) {
    const applied = statements.slice(0, index)
    throw new MigrationError(
      'migration_failed',
      `${step.name} failed at statement ${index + 1} of ${statements.length}: ${messageOf(error)}. ${applied.length} statement(s) before it are applied (MySQL and MariaDB commit each schema change on its own).`,
      'Fix the cause (usually the data), then run node strut migrate again: it resumes at the failed statement. To abandon the migration instead, undo the applied statements by hand and delete its row from the migrations table.',
      { migration: step.name, applied, failed: statements[index] as string, cause: error },
    )
  }
}

function rollbackTargets(ran: readonly RanMigration[], options: RollbackOptions): RanMigration[] {
  const newestFirst = [...ran].reverse()
  if (options.step !== undefined) return newestFirst.slice(0, options.step)
  const batch = options.batch ?? newestFirst[0]?.batch
  return newestFirst.filter((row) => row.batch === batch)
}

function stepsFor(rows: readonly RanMigration[], replay: Replay): ReplayedStep[] {
  const known = new Map(replay.migrations.map((step) => [step.name, step]))
  return rows.map((row) => {
    const step = known.get(row.migration)
    if (step === undefined) throw driftError({ migration: row.migration, kind: 'missing' })
    if (migrationChecksum(step) !== row.checksum)
      throw driftError({ migration: row.migration, kind: 'changed' })
    if (row.progress !== null)
      throw new MigrationError(
        'migration_partial',
        `"${row.migration}" stopped half-way when it ran, so its down() can't undo it safely.`,
        'Run node strut migrate to finish it first, or fix the database by hand and delete its row from the migrations table.',
        { migration: row.migration },
      )
    return step
  })
}

async function undo(
  connection: Connection,
  replay: Replay,
  rows: readonly RanMigration[],
  onEvent: ((event: MigrationEvent) => void) | undefined,
): Promise<string[]> {
  const steps = stepsFor(rows, replay)
  const dialect = dialectOf(connection)
  const undone: string[] = []
  for (const [position, step] of steps.entries()) {
    const row = rows[position] as RanMigration
    const statements = downSql(step, dialect)
    onEvent?.({ type: 'rolling-back', migration: step.name, statements: statements.length })
    if (!isMysqlFamily(dialect)) {
      let index = 0
      try {
        await connection.transaction(async () => {
          for (; index < statements.length; index++) {
            const statement = statements[index] as string
            onEvent?.({ type: 'statement', migration: step.name, index, sql: statement })
            await exec(connection, statement)
          }
          await deleteRow(connection, step.name)
        })
      } catch (error) {
        throw new MigrationError(
          'rollback_failed',
          `Rolling back ${step.name} failed: ${messageOf(error)}`,
          'Nothing from this rollback was applied (it ran in one transaction). Fix the cause, then run the rollback again.',
          {
            migration: step.name,
            ...(index < statements.length ? { failed: statements[index] as string } : {}),
            cause: error,
          },
        )
      }
    } else {
      let index = row.undoProgress ?? 0
      try {
        for (; index < statements.length; index++) {
          const statement = statements[index] as string
          onEvent?.({ type: 'statement', migration: step.name, index, sql: statement })
          await exec(connection, statement)
          await setProgress(connection, step.name, 'undo_progress', index + 1)
        }
        await deleteRow(connection, step.name)
      } catch (error) {
        throw new MigrationError(
          'rollback_failed',
          `Rolling back ${step.name} failed at statement ${index + 1} of ${statements.length}: ${messageOf(error)}. ${index} statement(s) before it are applied.`,
          'Fix the cause, then run the rollback again: it resumes at the failed statement.',
          {
            migration: step.name,
            applied: statements.slice(0, index),
            failed: statements[index] as string,
            cause: error,
          },
        )
      }
    }
    undone.push(step.name)
    onEvent?.({ type: 'rolled-back', migration: step.name })
  }
  return undone
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function insertRow(
  connection: Connection,
  name: string,
  batch: number,
  checksum: string,
  progress: number | null,
): Promise<void> {
  await connection.run(
    sql`INSERT INTO ${sql.id(MIGRATIONS_TABLE)} (${sql.id('migration')}, ${sql.id('batch')}, ${sql.id('checksum')}, ${sql.id('progress')}) VALUES (${name}, ${batch}, ${checksum}, ${progress})`,
  )
}

async function setProgress(
  connection: Connection,
  name: string,
  column: 'progress' | 'undo_progress',
  value: number | null,
): Promise<void> {
  await connection.run(
    sql`UPDATE ${sql.id(MIGRATIONS_TABLE)} SET ${sql.id(column)} = ${value} WHERE ${sql.id('migration')} = ${name}`,
  )
}

async function deleteRow(connection: Connection, name: string): Promise<void> {
  await connection.run(
    sql`DELETE FROM ${sql.id(MIGRATIONS_TABLE)} WHERE ${sql.id('migration')} = ${name}`,
  )
}

/** Does a table exist in the current database / schema? */
export async function tableExists(connection: Connection, table: string): Promise<boolean> {
  const query: SqlFragment = (() => {
    switch (dialectOf(connection)) {
      case 'sqlite':
        return sql`SELECT 1 AS ${sql.id('one')} FROM ${sql.id('sqlite_master')} WHERE ${sql.id('type')} = ${'table'} AND ${sql.id('name')} = ${table}`
      case 'postgres':
        return sql`SELECT 1 AS ${sql.id('one')} FROM ${sql.id('information_schema')}.${sql.id('tables')} WHERE ${sql.id('table_schema')} = current_schema() AND ${sql.id('table_name')} = ${table}`
      case 'mysql':
      case 'mariadb':
        return sql`SELECT 1 AS ${sql.id('one')} FROM ${sql.id('information_schema')}.${sql.id('tables')} WHERE ${sql.id('table_schema')} = DATABASE() AND ${sql.id('table_name')} = ${table}`
    }
  })()
  return (await connection.run(query)).rows.length > 0
}

function trackingTableExists(connection: Connection): Promise<boolean> {
  return tableExists(connection, MIGRATIONS_TABLE)
}

const TRACKING_ID: Readonly<Record<Dialect, string>> = {
  sqlite: '"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL',
  postgres: '"id" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
  mysql: '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY',
  mariadb: '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY',
}

async function ensureTrackingTable(connection: Connection): Promise<void> {
  const dialect = dialectOf(connection)
  const q = (name: string): string => (isMysqlFamily(dialect) ? `\`${name}\`` : `"${name}"`)
  const name = isMysqlFamily(dialect)
    ? `${q('migration')} VARCHAR(255) COLLATE ${dialect === 'mariadb' ? 'utf8mb4_nopad_bin' : 'utf8mb4_0900_bin'} NOT NULL`
    : `${q('migration')} VARCHAR(255) NOT NULL`
  await exec(
    connection,
    `CREATE TABLE IF NOT EXISTS ${q(MIGRATIONS_TABLE)} (${TRACKING_ID[dialect]}, ${name}, ${q('batch')} INTEGER NOT NULL, ${q('checksum')} VARCHAR(64) NOT NULL, ${q('progress')} INTEGER NULL, ${q('undo_progress')} INTEGER NULL, CONSTRAINT ${q(`${MIGRATIONS_TABLE}_migration_unique`)} UNIQUE (${q('migration')}))`,
  )
}

/** Drop every table of the current database (for `migrate:fresh`). Returns their names. */
async function dropAllTables(connection: Connection): Promise<string[]> {
  const dialect = dialectOf(connection)
  const listing = (() => {
    switch (dialect) {
      case 'sqlite':
        return sql`SELECT ${sql.id('name')} AS ${sql.id('name')} FROM ${sql.id('sqlite_master')} WHERE ${sql.id('type')} = ${'table'} AND ${sql.id('name')} NOT LIKE ${'sqlite_%'} ORDER BY ${sql.id('name')}`
      case 'postgres':
        return sql`SELECT ${sql.id('table_name')} AS ${sql.id('name')} FROM ${sql.id('information_schema')}.${sql.id('tables')} WHERE ${sql.id('table_schema')} = current_schema() AND ${sql.id('table_type')} = ${'BASE TABLE'} ORDER BY 1`
      case 'mysql':
      case 'mariadb':
        return sql`SELECT ${sql.id('table_name')} AS ${sql.id('name')} FROM ${sql.id('information_schema')}.${sql.id('tables')} WHERE ${sql.id('table_schema')} = DATABASE() AND ${sql.id('table_type')} = ${'BASE TABLE'} ORDER BY 1`
    }
  })()
  const tables = (await connection.run(listing)).rows.map((row) => String(row['name']))
  if (tables.length === 0) return []
  const quoted = (name: string): SqlFragment => sql.id(name)
  if (dialect === 'postgres') {
    await connection.run(sql`DROP TABLE IF EXISTS ${sql.join(tables.map(quoted), ', ')} CASCADE`)
    return tables
  }
  const off = dialect === 'sqlite' ? 'PRAGMA foreign_keys = OFF' : 'SET FOREIGN_KEY_CHECKS = 0'
  const on = dialect === 'sqlite' ? 'PRAGMA foreign_keys = ON' : 'SET FOREIGN_KEY_CHECKS = 1'
  await exec(connection, off)
  try {
    for (const table of tables) await connection.run(sql`DROP TABLE IF EXISTS ${quoted(table)}`)
  } finally {
    await exec(connection, on)
  }
  return tables
}

/** For tests and tools: the state a database should have after `count` migrations. */
export function stateAfter(replay: Replay, count: number): SchemaState {
  return replay.migrations[count - 1]?.after ?? { tables: [] }
}
