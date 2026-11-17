/**
 * The replay sandbox's **first barrier** (the parent's checks before anything runs), tested per
 * class of trick: every way to spell a path the gate and the child could read differently, every
 * way to make a migration CommonJS, and files that change how Node loads the folder.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  approveMigrations,
  replayInSandbox,
  SandboxError,
} from '../../../src/migrations/sandbox.ts'
import { linkDirectory, linkFolder, removeLinks } from '../../helpers/linked-root.ts'

const roots: string[] = []
afterAll(() => {
  removeLinks() // the links first, so removing a project never follows one
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const NAME = '2026_01_01_000000_create_tags_table.ts'
const HEADER = "import { migration } from '@strutvane/framework/schema'\n"
const TAIL = `export default migration({
  up(schema) { schema.create('tags', (t) => { t.id(); t.string('name') }) },
  down(schema) { schema.dropIfExists('tags') },
})
`

/** An app with `files` (paths relative to the migrations folder) and optional root files. */
function app(
  files: Readonly<Record<string, string>>,
  rootFiles: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-gate-'))
  roots.push(root)
  const folder = join(root, 'database', 'migrations')
  mkdirSync(folder, { recursive: true })
  const write = (base: string, name: string, source: string): void => {
    const path = join(base, ...name.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  for (const [name, source] of Object.entries(files)) write(folder, name, source)
  for (const [name, source] of Object.entries(rootFiles)) write(root, name, source)
  return folder
}

function refusal(folder: string): SandboxError {
  try {
    approveMigrations(folder)
  } catch (error) {
    if (error instanceof SandboxError) return error
    throw error
  }
  throw new Error('expected the gate to refuse')
}

describe('path tricks: the gate refuses every spelling it could resolve differently', () => {
  // A benign file sits wherever the literal spelling points, so the only reason to refuse is the
  // spelling itself (before the fix, `%2e%2e` passed the gate and loaded another file).
  const decoys: Record<string, string> = {
    'helpers/%2e%2e/evil.ts': 'export const X = 1\n',
    'helpers/evil.ts': 'export const X = 1\n',
    'helpers/sub./evil.ts': 'export const X = 1\n',
    'helpers/x.cts': 'export const X = 1\n',
    'helpers/x.mts': 'export const X = 1\n',
    'helpers/x.js': 'export const X = 1\n',
  }
  test.each([
    './helpers/%2e%2e/evil.ts',
    './helpers/%2E%2E/evil.ts',
    './helpers/%65vil.ts',
    './helpers/evil.ts?v=1',
    './helpers/evil.ts#x',
    '.\\helpers\\evil.ts',
    './helpers//evil.ts',
    './helpers/./evil.ts',
    './helpers/../helpers/evil.ts',
    './helpers/sub./evil.ts',
    './helpers/evil.ts:stream',
    './helpers/evil',
    './helpers/x.cts',
    './helpers/x.mts',
    './helpers/x.js',
    'file:///etc/passwd.ts',
    '/etc/x.ts',
    'C:/x.ts',
    '#helpers',
    '@strutvane/framework',
    '@strutvane/framework/database',
    '@strutvane/framework/schema/../database',
    'node:fs',
    'fs',
    '../../outside.ts',
  ])('refuses import from %j', (specifier) => {
    const folder = app({
      ...decoys,
      [NAME]: `${HEADER}import { X } from ${JSON.stringify(specifier)}\n${TAIL}`,
    })
    const error = refusal(folder)
    expect(error.code).toBe('migration_forbidden_import')
    expect(error.location).toMatch(new RegExp(`^${NAME}:2:1$`))
  })

  test.each([
    ['export * from', "export * from './helpers/%2e%2e/evil.ts'"],
    ['export { } from', "export { X } from './helpers/evil.ts?x'"],
    ['side-effect import', "import './helpers/evil.ts#x'"],
    ['in a helper', "import { Y } from './helpers/chain.ts'"],
  ])('applies to every import form (%s)', (_form, statement) => {
    const folder = app({
      ...decoys,
      'helpers/chain.ts': "export { X as Y } from './%2e%2e/helpers/evil.ts'\n",
      [NAME]: `${HEADER}${statement}\n${TAIL}`,
    })
    expect(refusal(folder).code).toBe('migration_forbidden_import')
  })

  test('approves the plain spelling and pins every approved file by SHA-256', () => {
    const folder = app({
      'helpers/evil.ts': "import { Z } from '../shared/z.ts'\nexport const X = Z\n",
      'shared/z.ts': 'export const Z = 1\n',
      [NAME]: `${HEADER}import { X } from './helpers/evil.ts'\n${TAIL}`,
    })
    const manifest = approveMigrations(folder)
    expect(manifest.entries).toEqual([NAME])
    // Approved files are pinned by their real paths, inside the folder's real path (on macOS
    // the temp folder `/var/…` is really `/private/var/…`).
    expect(manifest.folder).toBe(realpathSync(folder))
    expect(
      Object.keys(manifest.approved)
        .map((path) => relative(manifest.folder, path))
        .sort(),
    ).toEqual([NAME, join('helpers', 'evil.ts'), join('shared', 'z.ts')].sort())
    for (const hash of Object.values(manifest.approved)) expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('import cycles between helpers end', () => {
    const folder = app({
      'helpers/a.ts': "import { B } from './b.ts'\nexport const A = 1\nexport { B }\n",
      'helpers/b.ts': "import { A } from './a.ts'\nexport const B = 2\nexport { A }\n",
      [NAME]: `${HEADER}import { A } from './helpers/a.ts'\n${TAIL}`,
    })
    expect(Object.keys(approveMigrations(folder).approved)).toHaveLength(3)
  })
})

describe('module format tricks: a migration is always an ES module', () => {
  test.each([
    ['module.require', "const fs = module.require('node:fs')", '`module`'],
    ['exports', 'exports.x = 1', '`exports`'],
    ['__dirname', 'const here = __dirname', '`__dirname`'],
    ['__filename', 'const here = __filename', '`__filename`'],
    ['import = require', "import fs = require('node:fs')", '`import x = require()`'],
    ['export =', 'export = {}', '`export =`'],
    ['require', "const { readFileSync } = require('node:fs')", '`require`'],
  ])('the gate refuses CommonJS forms (%s)', (_what, body, named) => {
    const error = refusal(app({ [NAME]: `${HEADER}${body}\n${TAIL}` }))
    expect(error.code).toBe('migration_forbidden_code')
    expect(error.message).toContain(named)
  })

  test.each([
    ['package.json', 'package.json'],
    ['a nested package.json', 'helpers/package.json'],
    ['a capitalised Package.json', 'helpers/Package.json'],
    ['node_modules', 'node_modules/pkg/index.js'],
  ])('refuses %s inside the folder', (_what, path) => {
    const folder = app({ [NAME]: `${HEADER}${TAIL}`, [path]: '{"type":"commonjs"}' })
    const error = refusal(folder)
    expect(error.code).toBe('migration_forbidden_file')
    expect(error.hint).toMatch(/ES modules/)
  })

  test('a "type": "commonjs" package.json above the folder changes nothing: the replay still works', async () => {
    const folder = app(
      { [NAME]: `${HEADER}${TAIL}` },
      { 'package.json': '{"type":"commonjs"}', 'database/package.json': '{"type":"commonjs"}' },
    )
    const replay = await replayInSandbox(folder)
    expect(replay.state.tables.map((table) => table.name)).toEqual(['tags'])
  })

  test('a .cts or .mts file in the folder is never a migration', () => {
    const folder = app({ '2026_01_01_000000_x.cts': 'module.exports = {}\n' })
    expect(approveMigrations(folder).entries).toEqual([])
  })

  test('non-UTF-8 bytes are refused before parsing', () => {
    const folder = app({})
    writeFileSync(join(folder, NAME), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    expect(refusal(folder).code).toBe('migration_syntax')
  })

  test('a folder too deep to check is refused (fail closed)', () => {
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/')
    expect(refusal(app({ [`${deep}/x.txt`]: 'x' })).code).toBe('migration_forbidden_file')
  })
})

// macOS reaches every temp project through a link (`/var` → `/private/var`); a link (a junction on
// Windows) recreates that on every OS. A linked root must change nothing: the same files are
// approved and replayed, and a link *inside* the folder that points outside is still refused.
describe('a project reached through a linked root (every OS)', () => {
  /** The migrations folder of `app(files)`, spelled through a link to the project root. */
  function linkedApp(
    files: Readonly<Record<string, string>>,
  ): { readonly folder: string; readonly real: string } | { readonly skipped: string } {
    const real = app(files)
    const linked = linkFolder(dirname(dirname(real)))
    if ('skipped' in linked) return linked
    return { folder: join(linked.path, 'database', 'migrations'), real }
  }

  test('approves the same files, pinned under the real folder, and replays them', async ({
    skip,
  }) => {
    const project = linkedApp({
      'helpers/evil.ts': "import { Z } from '../shared/z.ts'\nexport const X = Z\n",
      'shared/z.ts': 'export const Z = 1\n',
      [NAME]: `${HEADER}import { X } from './helpers/evil.ts'\n${TAIL}`,
    })
    if ('skipped' in project) return skip(project.skipped)
    const manifest = approveMigrations(project.folder)
    expect(manifest.folder).toBe(realpathSync(project.real))
    expect(manifest.entries).toEqual([NAME])
    expect(
      Object.keys(manifest.approved)
        .map((path) => relative(manifest.folder, path))
        .sort(),
    ).toEqual([NAME, join('helpers', 'evil.ts'), join('shared', 'z.ts')].sort())
    const replay = await replayInSandbox(project.folder)
    expect(replay.state.tables.map((table) => table.name)).toEqual(['tags'])
  })

  test('a linked folder inside the migrations that points outside is still refused', ({ skip }) => {
    const project = linkedApp({ [NAME]: `${HEADER}import { X } from './helpers/evil.ts'\n${TAIL}` })
    if ('skipped' in project) return skip(project.skipped)
    const outside = mkdtempSync(join(tmpdir(), 'sv-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'evil.ts'), 'export const X = 1\n')
    const refused = linkDirectory(outside, join(project.real, 'helpers'))
    if (refused !== undefined) return skip(refused)
    const error = refusal(project.folder)
    expect(error.code).toBe('migration_outside_folder')
  })
})
