import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides go here. Shared defaults come from strutvane-tooling.
// Property tests and real file-system transactions are slower than unit tests on Windows CI.
export default mergeConfig(sharedConfig, defineConfig({ test: { testTimeout: 30_000 } }))
