/**
 * Time budgets for a 200-migration app. They run with `npm run test:perf` (its own config), not in
 * `npm test`: timings depend on the machine's load, and the default suite must never be flaky.
 * Run them on a quiet machine or in a dedicated CI job before a release.
 *
 * Method (from spike 04): one warm-up is discarded, then the *minimum* is asserted against the
 * budget (what the code can do) and the *median* against twice the budget (tolerates a busy
 * machine, still catches real regressions).
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildArtifacts } from '../../../src/schema/generate/artifacts.ts'
import {
  discoverMigrations,
  type LoadedMigration,
  loadMigrations,
  replayMigrations,
} from '../../../src/schema/replay.ts'
import { cleanupTempDirs, makeTempDir, median, SCHEMA_TESTS } from '../helpers.ts'
import { writeSyntheticApp } from '../scripts/synthetic.ts'

afterAll(cleanupTempDirs)

/** Budgets for a 200-migration app (100 tables). */
const BUDGET_MS = {
  /** `node strut migrate` from a cold start, including Node's boot: comfortably under a second. */
  coldProcess: 1000,
  /** Re-replaying already-imported migrations on each change in `node strut dev`. */
  warmReplay: 50,
  /** Writing types, metadata and SQL for 100 tables. */
  generate: 150,
}

function measure(work: () => void, runs: number): { min: number; median: number } {
  work()
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    const start = performance.now()
    work()
    samples.push(performance.now() - start)
  }
  return { min: Math.min(...samples), median: median(samples) }
}

describe('200 migrations, 100 tables', () => {
  let directory = ''
  let loaded: LoadedMigration[] = []

  beforeAll(async () => {
    directory = writeSyntheticApp(makeTempDir('perf'), 100)
    loaded = await loadMigrations(discoverMigrations(directory))
  })

  test(`cold replay in a fresh Node process stays under ${BUDGET_MS.coldProcess} ms`, () => {
    const wall = (): number => {
      const result = spawnSync(
        process.execPath,
        [join(SCHEMA_TESTS, 'scripts', 'cold-run.ts'), directory],
        { encoding: 'utf8' },
      )
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout) as { sinceProcessStart: number; tables: number }
      expect(parsed.tables).toBe(100)
      return parsed.sinceProcessStart
    }
    wall()
    const samples = [wall(), wall(), wall()]
    expect(Math.min(...samples)).toBeLessThan(BUDGET_MS.coldProcess)
    expect(median(samples)).toBeLessThan(BUDGET_MS.coldProcess * 2)
  })

  test(`warm replay stays under ${BUDGET_MS.warmReplay} ms`, () => {
    const timing = measure(() => replayMigrations(loaded), 10)
    expect(timing.min).toBeLessThan(BUDGET_MS.warmReplay)
    expect(timing.median).toBeLessThan(BUDGET_MS.warmReplay * 2)
  })

  test(`generating every artifact stays under ${BUDGET_MS.generate} ms`, () => {
    const replay = replayMigrations(loaded)
    const timing = measure(() => buildArtifacts(replay), 10)
    expect(timing.min).toBeLessThan(BUDGET_MS.generate)
    expect(timing.median).toBeLessThan(BUDGET_MS.generate * 2)
  })
})
