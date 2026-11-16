/**
 * Approach (a): derive the schema by *running* every migration's `up()` against the recorder.
 *
 * Three small steps, each testable on its own:
 * 1. {@link discoverMigrations}: list the files, in the order they run (by name, like Laravel).
 * 2. {@link loadMigrations}: import them (this is the only step that touches the disk).
 * 3. {@link replayMigrations}: record and fold. Pure and synchronous, no database.
 *
 * Importing a migration runs its top-level code, so the framework replays app migrations inside
 * a sandboxed child process (no environment, no network, a timeout); these functions are what
 * runs inside it, and what tests use directly.
 *
 * @module
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyOperations } from './apply.ts'
import { EMPTY_SCHEMA, type SchemaState } from './columns.ts'
import { SchemaError } from './errors.ts'
import { assertMigration, type Migration, recordOperations } from './migration.ts'
import type { ReplayedStep } from './operations.ts'
import { parseOperations } from './snapshot.ts'

/** What a recorded migration may be called: a file name without `.ts`, nothing that reaches SQL. */
const RECORDED_NAME = /^[A-Za-z0-9_.-]{1,200}$/

/** `2026_01_02_000000_create_posts_table.ts`: Laravel's file naming, which also fixes the run order. */
const MIGRATION_FILE = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+\.ts$/

/**
 * A migration file found on disk.
 *
 * @example
 * const file: MigrationFile = { name: '2026_01_02_000000_create_posts_table', path: '/app/database/migrations/2026_…ts' }
 */
export interface MigrationFile {
  /** The file name without `.ts`. This is what the migrations table stores. */
  readonly name: string
  /** Absolute path. */
  readonly path: string
}

/**
 * A migration that has been imported and is ready to replay.
 *
 * @example
 * const loaded: LoadedMigration = { name: 'create_tags', migration: migration({ up() {}, down() {} }) }
 */
export interface LoadedMigration {
  readonly name: string
  readonly migration: Migration
}

/**
 * One migration after replay: what it did, and the schema before and after.
 *
 * @example
 * replay.migrations[1].up // [{ type: 'createTable', table: 'posts', … }]
 */
export interface ReplayedMigration extends ReplayedStep {
  /** The imported migration itself (absent from the plain data the sandbox sends back). */
  readonly migration: Migration
}

/**
 * The result of replaying a project's migrations.
 *
 * @example
 * const { state } = replayMigrations(loaded)
 * state.tables.map((t) => t.name) // ['users', 'posts', …]
 */
export interface Replay {
  readonly migrations: readonly ReplayedStep[]
  /** The schema after the last migration: what the types and metadata are generated from. */
  readonly state: SchemaState
}

/**
 * List the migration files in a folder, in run order. Files that look like migrations but are
 * named wrongly are an error rather than silently skipped, because a skipped migration means
 * wrong types with no warning.
 *
 * @example
 * discoverMigrations('fixtures/blog/database/migrations') // [{ name: '2026_01_01_000000_create_users_table', path: … }, …]
 */
export function discoverMigrations(directory: string): MigrationFile[] {
  const files = readdirSync(directory).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'),
  )
  for (const file of files) {
    if (!MIGRATION_FILE.test(file)) {
      throw new SchemaError(
        'INVALID_MIGRATION',
        `"${file}" is in the migrations folder but isn't named like a migration.`,
        'Name it YYYY_MM_DD_HHMMSS_what_it_does.ts (node strut make:migration does this for you), or move it out of the folder.',
      )
    }
  }
  // Code-unit order, never localeCompare: the run order must be identical on every machine.
  return files
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => ({ name: file.slice(0, -'.ts'.length), path: join(directory, file) }))
}

/**
 * Options for {@link loadMigrations}.
 *
 * @example
 * await loadMigrations(files, { fresh: true })
 */
export interface LoadOptions {
  /**
   * Re-import files that changed since the last load. Node caches modules forever, so watch mode
   * needs this. The file's mtime and size go into the import URL as a cache key.
   */
  readonly fresh?: boolean
}

/**
 * Import migration files. This *executes* their top-level code, which is the price of approach (a):
 * it's the same code `migrate` runs anyway, but it does mean a migration with side effects at the
 * top level would run them during type generation too.
 *
 * @example
 * const loaded = await loadMigrations(discoverMigrations(dir))
 */
export async function loadMigrations(
  files: readonly MigrationFile[],
  options: LoadOptions = {},
): Promise<LoadedMigration[]> {
  // Imports run in parallel (module loading is I/O-bound), but the result keeps file order.
  return Promise.all(
    files.map(async (file) => {
      const url = pathToFileURL(file.path)
      if (options.fresh === true) {
        const stats = statSync(file.path)
        url.searchParams.set('v', `${stats.mtimeMs}-${stats.size}`)
      }
      const module: unknown = await import(url.href)
      const exported =
        typeof module === 'object' && module !== null && 'default' in module
          ? module.default
          : undefined
      return { name: file.name, migration: assertMigration(exported, `${file.name}.ts`) }
    }),
  )
}

/**
 * Replay migrations in order against the in-memory recorder and return the final schema.
 * No database, no I/O: the same input always gives the same output.
 *
 * If a migration is wrong (for example it renames a column that doesn't exist), the
 * {@link SchemaError} says which migration it was.
 *
 * @example
 * const replay = replayMigrations(await loadMigrations(discoverMigrations(dir)))
 */
export function replayMigrations(
  migrations: readonly LoadedMigration[],
  start: SchemaState = EMPTY_SCHEMA,
): Replay {
  const seen = new Set<string>()
  const replayed: ReplayedMigration[] = []
  let state = start
  for (const { name, migration } of migrations) {
    if (seen.has(name)) {
      throw new SchemaError(
        'DUPLICATE_MIGRATION',
        `The migration "${name}" is listed twice.`,
        'Each migration file must have a unique name.',
      )
    }
    seen.add(name)
    try {
      const up = recordOperations((schema) => migration.up(schema), state)
      const after = applyOperations(state, up)
      const down = recordOperations((schema) => migration.down(schema), after)
      replayed.push({ name, migration, up, down, before: state, after })
      state = after
    } catch (error) {
      if (error instanceof SchemaError) error.migration ??= `${name}.ts`
      throw error
    }
  }
  return { migrations: replayed, state }
}

/**
 * Operations recorded elsewhere (the replay sandbox's child process), one entry per migration.
 *
 * @example
 * const recorded: RecordedMigration = { name: '2026_01_01_000000_create_tags_table', up: [], down: [] }
 */
export interface RecordedMigration {
  readonly name: string
  /** The operations `up()` recorded, as received (checked with {@link parseOperations}). */
  readonly up: unknown
  /** The operations `down()` recorded, as received. */
  readonly down: unknown
}

/**
 * Rebuild a {@link Replay} from recorded operations, folding them again here. Nothing is trusted:
 * every operation is checked for shape and safe identifiers ({@link parseOperations}) and the
 * schema states are recomputed, so a child process can only ever hand back well-formed
 * operations, which then pass the same checks as an in-process replay.
 *
 * @example
 * const replay = replayRecorded(JSON.parse(childOutput).migrations)
 */
export function replayRecorded(
  recorded: readonly RecordedMigration[],
  start: SchemaState = EMPTY_SCHEMA,
): Replay {
  const seen = new Set<string>()
  const steps: ReplayedStep[] = []
  let state = start
  for (const entry of recorded) {
    const name = entry.name
    if (typeof name !== 'string' || !RECORDED_NAME.test(name)) {
      throw new SchemaError(
        'INVALID_MIGRATION',
        'A recorded migration has no valid name.',
        'Name migration files YYYY_MM_DD_HHMMSS_what_it_does.ts.',
      )
    }
    if (seen.has(name)) {
      throw new SchemaError(
        'DUPLICATE_MIGRATION',
        `The migration "${name}" is listed twice.`,
        'Each migration file must have a unique name.',
      )
    }
    seen.add(name)
    try {
      const up = parseOperations(entry.up, name)
      const down = parseOperations(entry.down, name)
      const after = applyOperations(state, up)
      steps.push({ name, up, down, before: state, after })
      state = after
    } catch (error) {
      if (error instanceof SchemaError) error.migration ??= `${name}.ts`
      throw error
    }
  }
  return { migrations: steps, state }
}

/**
 * Check that every migration's `down()` really undoes its `up()`: applying `down` to the state
 * after `up` must give back the state before it.
 *
 * Column and index *order* is ignored, because re-adding a dropped column always appends it, in
 * the recorder and in every database alike.
 *
 * @example
 * irreversibleMigrations(replay) // [] when every down() is a true inverse
 */
export function irreversibleMigrations(replay: Replay): string[] {
  const broken: string[] = []
  for (const step of replay.migrations) {
    let reverted: SchemaState
    try {
      reverted = applyOperations(step.after, step.down)
    } catch {
      broken.push(step.name)
      continue
    }
    if (canonicalSchema(reverted) !== canonicalSchema(step.before)) broken.push(step.name)
  }
  return broken
}

/**
 * A stable JSON string for a schema, independent of table, column and index order.
 * Used to compare two schemas for "same shape".
 *
 * @example
 * canonicalSchema(a) === canonicalSchema(b) // same tables, columns and indexes
 */
export function canonicalSchema(state: SchemaState): string {
  const byName = <T extends { readonly name: string }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const tables = byName(state.tables).map((table) => ({
    name: table.name,
    columns: byName(table.columns).map((column) => sortKeys(column)),
    indexes: byName(table.indexes).map((index) => sortKeys(index)),
  }))
  return JSON.stringify(tables)
}

function sortKeys(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
