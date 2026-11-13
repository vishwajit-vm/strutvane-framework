import { defineConfig } from 'tsdown'

// Two packages, one build. Each config runs with `cwd` set to its package, so dependencies are
// read from that package's package.json (and kept external) and output lands in its own dist/.
const shared = {
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
} as const

export default defineConfig([
  { ...shared, cwd: 'packages/cli', entry: ['src/index.ts', 'src/bin.ts'] },
  { ...shared, cwd: 'packages/launcher', entry: ['src/launcher.ts', 'src/bin.ts'] },
])
