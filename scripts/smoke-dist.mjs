// Smoke test of the BUILT package (run after `tsdown`, part of `npm run ci`): the F-06 replay
// sandbox must start dist/replay-worker.mjs in a child process, map @strutvane/framework/schema to
// dist/schema.mjs, replay a migration, and refuse one that reads process.env. Unit tests run the
// worker from src/, so only this catches a bundling change that breaks the published sandbox.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { replayInSandbox } = await import(new URL('../dist/database.mjs', import.meta.url).href)
const dir = mkdtempSync(join(tmpdir(), 'sv-dist-smoke-'))
try {
  const migrations = join(dir, 'database', 'migrations')
  mkdirSync(migrations, { recursive: true })
  const header = "import { migration } from '@strutvane/framework/schema'\n"
  // A CommonJS package scope above the folder must not change how migrations load (always ESM),
  // and the child's second barrier must hold: console hands out no stream, no process global.
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}')
  writeFileSync(
    join(migrations, '2026_01_01_000000_create_tags_table.ts'),
    `${header}const leaks = [(console as any)._stderr, (console as any)._stdout, typeof Buffer === "undefined" ? undefined : 1].filter((x) => x !== undefined)\nif (leaks.length > 0) throw new Error('the sandbox leaked a capability')\nexport default migration({ up(schema) { schema.create('tags', (t) => { t.id(); t.string('name') }) }, down(schema) { schema.drop('tags') } })\n`,
  )
  const replay = await replayInSandbox(migrations)
  const tables = replay.state.tables.map((table) => table.name).join(',')
  if (tables !== 'tags') throw new Error(`expected the tags table, got "${tables}"`)
  writeFileSync(
    join(migrations, '2026_01_02_000000_steal.ts'),
    `${header}const key = process.env.APP_KEY\nexport default migration({ up() { void key }, down() {} })\n`,
  )
  let refused = false
  try {
    await replayInSandbox(migrations)
  } catch (error) {
    refused = typeof error === 'object' && error !== null && 'code' in error
  }
  if (!refused) throw new Error('the built sandbox ran a migration that reads process.env')
  process.stdout.write('dist smoke test: the replay sandbox works from dist/\n')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
