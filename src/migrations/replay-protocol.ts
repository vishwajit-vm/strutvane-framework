/**
 * What the F-06 replay sandbox's parent and child agree on. Kept apart from the worker module so
 * the parent never imports the worker: the worker must stay its own built entry
 * (`dist/replay-worker.mjs`), whose `import.meta.url` is what starts it in the child.
 *
 * The most important thing they share is {@link resolveMigrationImport}: the parent's static gate
 * and the child's import hook decide where a relative import points with **this one function**, so
 * the file the gate checked is the file the child loads. On top of that the child only loads files
 * the parent approved, pinned by their SHA-256 ({@link ReplayManifest}), so even a resolution
 * difference nobody has thought of yet can only ever load a file the gate already checked.
 *
 * @module
 */
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** The message the worker sends to the parent. */
export type WorkerMessage =
  | {
      readonly ok: true
      readonly migrations: readonly {
        readonly name: string
        readonly up: unknown
        readonly down: unknown
      }[]
    }
  | {
      readonly ok: false
      readonly error: {
        readonly message: string
        readonly code?: string
        readonly hint?: string
        readonly migration?: string
      }
    }

/**
 * What the parent hands the child on stdin: the migrations folder, the migration files to replay
 * (in order, relative to the folder) and every file the static gate approved (migrations and the
 * helpers they import), each with the SHA-256 of the exact bytes the gate checked.
 *
 * @example
 * const manifest: ReplayManifest = {
 *   folder: '/app/database/migrations',
 *   entries: ['2026_01_01_000000_create_tags_table.ts'],
 *   approved: { '/app/database/migrations/2026_01_01_000000_create_tags_table.ts': 'ab12…' },
 * }
 */
export interface ReplayManifest {
  readonly folder: string
  readonly entries: readonly string[]
  /** Absolute path → lowercase hex SHA-256 of the content the gate checked. */
  readonly approved: Readonly<Record<string, string>>
}

/** The import specifier migrations use for the Schema builder. */
export const SCHEMA_SPECIFIER = '@strutvane/framework/schema'

/** The most the child may write back (bytes); a bigger answer is refused, not buffered. */
export const RESULT_LIMIT_BYTES: number = 32 * 1024 * 1024

/**
 * The only shape a relative import in a migration may have: `./` or `../` (repeated), then plain
 * path segments made of letters, digits, `_`, `-` and inner dots, ending in `.ts`.
 *
 * Deliberately strict. It rules out, by construction, every form that path and URL resolution
 * treat differently: percent-encoding (`%2e%2e`), query strings and fragments, backslashes, drive
 * letters and `file:` URLs, empty, `.` and `..` segments in the middle, Windows trailing dots and
 * alternate data streams (`a.ts:x`), short names (`HELPER~1`), and `.mts`/`.cts`/`.js` files.
 */
export const MIGRATION_IMPORT: RegExp =
  /^(?:\.\/|(?:\.\.\/)+)(?:[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?\/)*[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?\.ts$/

/**
 * Is `child` the folder `parent` or inside it (plain path logic, no file system)?
 *
 * @example
 * isInside('/app/database/migrations', '/app/database/migrations/helpers/x.ts') // true
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Where a relative import in a migration points, or `undefined` when the import isn't allowed.
 * Shared by the parent's static gate and the child's import hook, so both always agree.
 *
 * @example
 * resolveMigrationImport('./helpers/columns.ts', '/m/2026_…_x.ts', '/m') // '/m/helpers/columns.ts'
 * resolveMigrationImport('./a/%2e%2e/b.ts', '/m/2026_…_x.ts', '/m')      // undefined
 */
export function resolveMigrationImport(
  specifier: string,
  importerPath: string,
  folder: string,
): string | undefined {
  if (!MIGRATION_IMPORT.test(specifier)) return undefined
  const target = resolve(dirname(importerPath), specifier)
  return isInside(folder, target) && target !== folder ? target : undefined
}
