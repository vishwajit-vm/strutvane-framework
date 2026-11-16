/**
 * The ORM's compile-time guarantees, checked by the real TypeScript compiler.
 *
 * The ORM suites and fixtures are written the way an app writes models
 * (`class Post extends Model('posts', …)`), which the repo's `isolatedDeclarations` setting forbids
 * (TS9021), so they live in their own project (test/database/orm/tsconfig.json). This test
 * compiles it: every `@ts-expect-error` in types.test.ts (a wrong column, value, relation, a
 * non-fillable or hidden field) must still be an error, and everything else must compile.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const PROJECT = fileURLToPath(new URL('./orm/tsconfig.json', import.meta.url))

test('the ORM suites, fixtures and type assertions compile exactly as an app would', () => {
  const result = spawnSync(process.execPath, [TSC, '--noEmit', '-p', PROJECT], {
    encoding: 'utf8',
    timeout: 300_000,
  })
  expect(`${result.stdout}${result.stderr}`).toBe('')
  expect(result.status).toBe(0)
}, 320_000)
