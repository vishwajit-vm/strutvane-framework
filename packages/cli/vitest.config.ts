import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. This repo is a workspace of two packages (cli + launcher) tested from the
// root, so the shared `test/` and `src/` globs are widened to `packages/*/`. Vitest's mergeConfig
// concatenates arrays, so the shared globs stay (and simply match nothing here).
// Child-process and file-watcher tests are slow on Windows CI, hence the generous timeout.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['packages/*/test/**/*.test.ts'],
      // The fixture app contains its own (ignored) test file; it is data, not a test.
      exclude: [...configDefaults.exclude, 'packages/*/test/fixtures/**'],
      typecheck: { include: ['packages/*/test/**/*.test-d.ts'] },
      testTimeout: 60_000,
      hookTimeout: 60_000,
      coverage: {
        include: ['packages/*/src/**/*.ts'],
        exclude: ['packages/*/src/**/index.ts', 'packages/*/src/bin.ts'],
      },
    },
  }),
)
