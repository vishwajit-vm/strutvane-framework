/**
 * The large synthetic app the perf budgets use, checked for correctness only (no timings, so the
 * default suite never depends on machine load). The budgets are in `test/perf/` (`npm run test:perf`).
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { buildArtifacts } from '../../src/schema/generate/artifacts.ts'
import { discoverMigrations, loadMigrations, replayMigrations } from '../../src/schema/replay.ts'
import { cleanupTempDirs, makeTempDir, SCHEMA_TESTS } from './helpers.ts'
import { writeSyntheticApp } from './scripts/synthetic.ts'

afterAll(cleanupTempDirs)

describe('200 migrations, 100 tables', () => {
  test('replay in a fresh Node process and in-process agree, and every artifact is generated', async () => {
    const directory = writeSyntheticApp(makeTempDir('synthetic'), 100)
    const cold = spawnSync(
      process.execPath,
      [join(SCHEMA_TESTS, 'scripts', 'cold-run.ts'), directory],
      { encoding: 'utf8' },
    )
    expect(cold.status, cold.stderr).toBe(0)
    expect((JSON.parse(cold.stdout) as { tables: number }).tables).toBe(100)
    const replay = replayMigrations(await loadMigrations(discoverMigrations(directory)))
    expect(replay.migrations).toHaveLength(200)
    expect(replay.state.tables).toHaveLength(100)
    expect([...buildArtifacts(replay).keys()].filter((path) => path.endsWith('.sql'))).toHaveLength(
      8,
    )
  })
})
