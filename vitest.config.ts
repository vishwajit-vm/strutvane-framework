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
      // Throwaway MySQL 8.4, MariaDB 11.4 and PostgreSQL 18 servers for the real-engine suites
      // (uniquely named containers, removed at the end; skipped with the reason when Docker is off).
      globalSetup: ['test/helpers/db-servers.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // Lets test cleanup force a garbage collection: libSQL releases a SQLite file on Windows only
      // when its statements are collected (see removeProject in test/runtime/project-fixture.ts).
      execArgv: ['--expose-gc'],
      coverage: { exclude: ['src/console/bin.ts'] },
    },
  }),
)
