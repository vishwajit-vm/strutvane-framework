import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

/**
 * The logging suites (test/logging) prove timing and process guarantees with real files and real
 * child processes: shutdown deadlines, exit codes, midnight rollover across four writers, size
 * caps under load. They ran one file at a time in the logs repo, and they must not compete with
 * the database suites for the CPU and the disk, or a busy machine turns a deadline into a false
 * failure. So they are their own project: one file at a time, after the main project finished
 * (`groupOrder`). Coverage is still collected for both.
 */
const LOGGING = 'test/logging/**/*.test.ts'

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
      projects: [
        {
          extends: true,
          test: {
            name: 'framework',
            exclude: [LOGGING],
            // Throwaway MySQL 8.4, MariaDB 11.4 and PostgreSQL 18 servers for the real-engine
            // suites (uniquely named containers, removed at the end; skipped with the reason when
            // Docker is off).
            globalSetup: ['test/helpers/db-servers.ts'],
            sequence: { groupOrder: 0 },
          },
        },
        {
          test: {
            name: 'logging',
            include: ['**/*.test.ts'],
            // Only scan the logging folder (the root's include list would otherwise apply too).
            dir: 'test/logging',
            environment: 'node',
            allowOnly: false,
            restoreMocks: true,
            unstubEnvs: true,
            unstubGlobals: true,
            fileParallelism: false,
            testTimeout: 60_000,
            hookTimeout: 60_000,
            sequence: { groupOrder: 1 },
          },
        },
      ],
    },
  }),
)
