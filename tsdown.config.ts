import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    provider: 'src/entries/provider.ts',
    http: 'src/entries/http.ts',
    database: 'src/entries/database.ts',
    commands: 'src/commands.ts',
    'serve-main': 'src/serve-main.ts',
    'testing/index': 'src/testing/index.ts',
    'contracts/index': 'src/contracts/index.ts',
    'core/index': 'src/core/index.ts',
    'devkit/index': 'src/devkit/index.ts',
    'console/index': 'src/console/index.ts',
    'console/bin': 'src/console/bin.ts',
    'facades/index': 'src/facades/index.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
})
