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
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
})
