/**
 * Formatter reflow, with the real Biome CLI and a real biome.json in a temp project (spike 06).
 *
 * Scenario: the template emits a long line; the user ran Biome, which wrapped it over several
 * lines; the next template version changes one value inside that long line.
 *   - Without the formatter step, the reflowed region conflicts (both sides changed it).
 *   - With the formatter step, base and theirs are formatted like the user's file: clean merge.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createBiomeCliFormatter,
  type Formatter,
  tryFormat,
} from '../../../src/devkit/merge/format.ts'
import { mergeThreeWay } from '../../../src/devkit/merge/merge.ts'
import { planUpgrade, recordEjection } from '../../../src/devkit/merge/upgrade.ts'
import { tempProject, writeFiles } from '../helpers.ts'

const biomeBin = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome')
const HEADER =
  '// @strutvane-template framework/list-config@1.0.0 (ejected: this file is yours to edit)\n'
const BASE = `${HEADER}export const config = defineListConfig({ name: 'invoices', pageSize: 25, sortBy: 'createdAt', direction: 'desc', include: ['customer'] })\n`
const THEIRS = BASE.replace('@1.0.0', '@1.1.0').replace('pageSize: 25', 'pageSize: 50')

/** Per Biome call in these tests; a test makes up to three calls (see the note in `beforeEach`). */
const FORMAT_TIMEOUT_MS = 90_000
vi.setConfig({ testTimeout: 4 * FORMAT_TIMEOUT_MS })

let projectRoot: string
let cleanup: () => Promise<void>
let biome: Formatter
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  // The USER's formatter config: 80 columns, single quotes, no semicolons.
  await writeFiles(projectRoot, {
    'biome.json': JSON.stringify({
      formatter: { lineWidth: 80, indentStyle: 'space' },
      javascript: { formatter: { quoteStyle: 'single', semicolons: 'asNeeded' } },
    }),
  })
  // These tests are about merging, not speed. The 15 s default is a product setting (a slow
  // formatter falls back to the raw text); here a cold Biome binary on a loaded Windows machine
  // (the first run after `npm ci`, while the scanner checks it) has taken over 15 s per call, which
  // turned a fallback into a failed assertion. So: a generous limit, and room in the test timeout.
  biome = createBiomeCliFormatter({ cwd: projectRoot, biomeBin, timeoutMs: FORMAT_TIMEOUT_MS })
})
afterEach(() => cleanup())

describe('formatter reflow', () => {
  test('without formatting: conflict; with formatting base + theirs: clean', async () => {
    const formattedBase = await biome.format(BASE, 'config.ts')
    expect(formattedBase).not.toBe(BASE) // Biome really reflowed the long line
    const ours = `${formattedBase}\nexport const extra = true\n` // user ran Biome and added code

    expect(mergeThreeWay({ base: BASE, ours, theirs: THEIRS }).status).toBe('conflicted')

    const smart = mergeThreeWay({
      base: formattedBase,
      ours,
      theirs: await biome.format(THEIRS, 'config.ts'),
    })
    expect(smart.status).toBe('clean')
    expect(smart.text).toContain('pageSize: 50')
    expect(smart.text).toContain('export const extra = true')
  })

  test('planUpgrade applies the formatter only when the user file is already formatted', async () => {
    const path = 'app/config.ts'
    await recordEjection({
      projectRoot,
      outputs: [{ path, template: 'framework/list-config', version: '1.0.0', content: BASE }],
    })
    const templates = [
      { path, template: 'framework/list-config', version: '1.1.0', content: THEIRS },
    ]

    const formatted = await biome.format(BASE, path)
    await writeFiles(projectRoot, { [path]: `${formatted}\nexport const extra = true\n` })
    const plan = await planUpgrade({ projectRoot, templates, formatter: biome })
    expect(plan.items[0]).toMatchObject({ action: 'update', mode: 'three-way' })
    expect(plan.items[0]?.after).toContain('pageSize: 50')

    // An unformatted user file: the formatter is skipped, so no reflow is introduced.
    await writeFiles(projectRoot, { [path]: `${BASE}export const extra   =   true\n` })
    const raw = await planUpgrade({ projectRoot, templates, formatter: biome })
    expect(raw.items[0]?.after).toContain('export const extra   =   true')
  })

  test('formatter failures on the user file are fail-soft and noted', async () => {
    const path = 'app/config.ts'
    await recordEjection({
      projectRoot,
      outputs: [{ path, template: 'framework/list-config', version: '1.0.0', content: BASE }],
    })
    await writeFiles(projectRoot, { [path]: `${BASE}export const = = broken(\n` })
    const plan = await planUpgrade({
      projectRoot,
      templates: [{ path, template: 'framework/list-config', version: '1.1.0', content: THEIRS }],
      formatter: biome,
    })
    expect(plan.items[0]?.notes.join(' ')).toMatch(/biome could not format/)
    expect(plan.items[0]?.after).toContain('pageSize: 50')
  })

  test('tryFormat is fail-soft: original text plus a note', async () => {
    const outcome = await tryFormat(biome, 'export const = = broken(', 'broken.ts')
    expect(outcome.formatted).toBe(false)
    expect(outcome.text).toBe('export const = = broken(')
    expect(outcome.note).toMatch(/biome could not format broken\.ts/)
  })

  test('a non-Error rejection is described too', async () => {
    const odd: Formatter = { name: 'odd', format: () => Promise.reject('plain string') }
    expect((await tryFormat(odd, 'x', 'x.ts')).note).toBe('odd could not format x.ts: plain string')
  })

  test('a missing formatter binary is fail-soft', async () => {
    const missing = createBiomeCliFormatter({
      cwd: projectRoot,
      biomeBin: join(projectRoot, 'does-not-exist.js'),
    })
    expect(await tryFormat(missing, BASE, 'config.ts')).toMatchObject({
      formatted: false,
      text: BASE,
    })
  })

  test('Biome is resolved from the project itself, never from a global install', async () => {
    // The temp project has no node_modules: resolution fails, and formatting is skipped.
    const unresolved = createBiomeCliFormatter({ cwd: projectRoot })
    expect((await tryFormat(unresolved, BASE, 'config.ts')).formatted).toBe(false)
    // This package has Biome installed locally: it is found.
    const local = createBiomeCliFormatter({ cwd: process.cwd() })
    expect((await tryFormat(local, 'const a   = 1\n', 'a.ts')).formatted).toBe(true)
  })

  test('a slow formatter times out', async () => {
    const slow = createBiomeCliFormatter({ cwd: projectRoot, biomeBin, timeoutMs: 1 })
    expect((await tryFormat(slow, BASE, 'config.ts')).note).toMatch(/timed out/)
  })
})
