/**
 * Replay an app's migrations in plain Node and write its `.strutvane/` files: what the tests use
 * to prove replay works outside Vitest, and how the blog fixture's golden files are refreshed.
 *
 *   node test/schema/scripts/generate.ts test/schema/fixtures/blog --fixture
 *
 * `--fixture` points the generated types at the test stand-in registry (see `fixtures/registry.ts`).
 */
import { join, resolve } from 'node:path'
import { SchemaError } from '../../../src/schema/errors.ts'
import { buildArtifacts, writeArtifacts } from '../../../src/schema/generate/artifacts.ts'
import { discoverMigrations, loadMigrations, replayMigrations } from '../../../src/schema/replay.ts'

const root = resolve(process.argv[2] ?? '.')
const fixture = process.argv.includes('--fixture')

try {
  const files = discoverMigrations(join(root, 'database', 'migrations'))
  const replay = replayMigrations(await loadMigrations(files))
  const written = writeArtifacts(
    root,
    buildArtifacts(replay, {}, fixture ? { modelModule: '../../../registry.ts' } : {}),
  )
  process.stdout.write(
    `Replayed ${files.length} migrations into ${replay.state.tables.length} tables.\n`,
  )
  process.stdout.write(
    written.length === 0
      ? '  Everything was already up to date.\n'
      : `  Updated: ${written.join(', ')}\n`,
  )
} catch (error) {
  // Friendly output for schema mistakes; anything else is a real bug and keeps its stack trace.
  if (!(error instanceof SchemaError)) throw error
  process.stderr.write(`${error.describe()}\n`)
  process.exitCode = 1
}
