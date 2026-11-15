// Repo-specific: the soak and spike suite (`npm run test:soak`). It runs a real server under load
// for minutes, so it is kept out of the gate (`vitest.config.ts` only includes `*.test.ts`).
// See test/soak/server.soak.ts for the knobs (SOAK_MINUTES, SOAK_DB, ...).
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/soak/**/*.soak.ts'],
    exclude: [...configDefaults.exclude],
    environment: 'node',
    passWithNoTests: false,
    allowOnly: false,
    // One soak at a time: they measure the machine.
    fileParallelism: false,
    testTimeout: 60 * 60_000,
  },
})
