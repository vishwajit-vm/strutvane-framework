import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides go here. Shared defaults come from strutvane-tooling.
// Database tests run real engines (PGlite, libSQL), so they get a longer timeout.
export default mergeConfig(
  sharedConfig,
  defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } }),
)
