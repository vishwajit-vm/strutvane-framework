import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. The framework now also holds the kernel (core), contracts, the CLI
// (console) and devkit, whose suites moved under test/<part>/. Timeouts are the largest any of
// the absorbed repos needed (the CLI's child-process and watcher tests on Windows).
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, 'test/console/fixtures/**'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // Lets test cleanup force a garbage collection: libSQL releases a SQLite file on Windows only
      // when its statements are collected (see removeProject in test/runtime/project-fixture.ts).
      execArgv: ['--expose-gc'],
      coverage: { exclude: ['src/console/bin.ts'] },
    },
  }),
)
