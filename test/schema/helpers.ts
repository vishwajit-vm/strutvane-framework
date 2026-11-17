/**
 * Shared helpers for the schema pipeline tests: the replayed fixtures, temp folders and the
 * source of a migration file.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ArtifactOptions } from '../../src/schema/generate/artifacts.ts'
import {
  discoverMigrations,
  loadMigrations,
  type Replay,
  replayMigrations,
} from '../../src/schema/replay.ts'

/** The repository root. */
export const REPO_ROOT: string = fileURLToPath(new URL('../..', import.meta.url))
/** This test folder. */
export const SCHEMA_TESTS: string = fileURLToPath(new URL('.', import.meta.url))
/** The realistic blog app used across the suite. */
export const BLOG_ROOT: string = join(SCHEMA_TESTS, 'fixtures', 'blog')
/** An app whose migrations use loops, helpers and `if`. */
export const DYNAMIC_ROOT: string = join(SCHEMA_TESTS, 'fixtures', 'dynamic')
/** `@strutvane/framework/schema`, as a file URL any temp migration can import. */
export const SCHEMA_ENTRY_URL: string = pathToFileURL(
  join(REPO_ROOT, 'src', 'entries', 'schema.ts'),
).href
/**
 * The blog fixture's generated types augment a test stand-in (`fixtures/registry.ts`), so the
 * golden files compile before the package is built.
 */
export const BLOG_ARTIFACTS: ArtifactOptions = { modelModule: '../../../registry.ts' }

/** Replay an app's migrations in process. */
export async function replayApp(root: string): Promise<Replay> {
  return replayMigrations(
    await loadMigrations(discoverMigrations(join(root, 'database', 'migrations'))),
  )
}

const tempDirs: string[] = []

/** A fresh folder in the OS temp directory, removed by {@link cleanupTempDirs}. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sv-schema-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

/** Remove every temp folder this test file created. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A migration file body with the given `up` and `down` statements, as `make:migration` starts it. */
export function migrationSource(up: string, down: string): string {
  return `import { migration } from ${JSON.stringify(SCHEMA_ENTRY_URL)}

export default migration({\n  up(schema) {\n    ${up}\n  },\n  down(schema) {\n    ${down}\n  },\n})\n`
}

/**
 * Copy a fixture app's migrations into `to/database/migrations`, pointing their schema import at
 * {@link SCHEMA_ENTRY_URL} (the fixtures import it by a relative path that only works in place).
 */
export function copyMigrations(from: string, to: string): void {
  const source = join(from, 'database', 'migrations')
  const target = join(to, 'database', 'migrations')
  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(source)) {
    const text = readFileSync(join(source, file), 'utf8').replace(
      "'../../../../../../src/entries/schema.ts'",
      JSON.stringify(SCHEMA_ENTRY_URL),
    )
    writeFileSync(join(target, file), text)
  }
}

/** Median of a list of numbers (timings). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}
