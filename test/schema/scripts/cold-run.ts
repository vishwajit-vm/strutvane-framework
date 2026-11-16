/**
 * One cold replay in a fresh Node process, the way `node strut migrate` regenerates types.
 *
 *   node test/schema/scripts/cold-run.ts <migrations dir>
 *
 * Prints one JSON line. `sinceProcessStart` uses performance.now(), whose origin is the process
 * start, so it includes Node's own boot time.
 */
const directory = process.argv[2] ?? ''
const started = performance.now()
const { discoverMigrations, loadMigrations, replayMigrations } = await import(
  '../../../src/schema/replay.ts'
)
const toolsLoaded = performance.now()
const files = discoverMigrations(directory)
const loaded = await loadMigrations(files)
const filesRead = performance.now()
const replay = replayMigrations(loaded)
const done = performance.now()
process.stdout.write(
  `${JSON.stringify({
    files: files.length,
    tables: replay.state.tables.length,
    toolLoadMs: toolsLoaded - started,
    importFilesMs: filesRead - toolsLoaded,
    workMs: done - filesRead,
    sinceProcessStart: done,
  })}\n`,
)
