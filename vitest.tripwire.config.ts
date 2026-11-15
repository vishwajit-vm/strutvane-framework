// Repo-specific: the whole suite under process-level tripwires (`npm run test:tripwire`).
// Workers run with --unhandled-rejections=strict, and test/helpers/tripwires.ts fails any file
// that raised an uncaught exception or unhandled rejection, or left sockets, servers or timers
// running. Kept out of the gate because it runs the whole suite a second time.
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.ts'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ['./test/helpers/tripwires.ts'],
      execArgv: ['--unhandled-rejections=strict'],
      typecheck: { enabled: false },
    },
  }),
)
