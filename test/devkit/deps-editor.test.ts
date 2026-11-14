/** `package.json` editing: never replace the developer's choice, never commit a local-only spec. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createDepsEditor, detectIndent } from '../src/deps-editor.ts'
import type { DevkitError } from '../src/errors.ts'
import { createStagedFs, type StagedFs } from '../src/staged-fs.ts'
import { rejectionOf, tempProject, writeFiles } from './helpers.ts'

let projectRoot: string
let cleanup: () => Promise<void>
let fs: StagedFs
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  fs = createStagedFs(projectRoot)
})
afterEach(() => cleanup())

const pkg = (value: unknown, indent: string | number = 2) =>
  `${JSON.stringify(value, null, indent)}\n`

describe('add', () => {
  test('adds sorted dependencies and devDependencies, keeping formatting', async () => {
    await writeFiles(projectRoot, {
      'package.json': pkg({ name: 'app', dependencies: { zod: '4.0.0' } }, '\t'),
    })
    const deps = createDepsEditor(fs)
    expect(await deps.ensure({ 'better-auth': '1.4.0', '@strutvane/auth': '0.1.0' })).toEqual({
      added: ['better-auth', '@strutvane/auth'],
      kept: [],
    })
    await deps.add({ vitest: '5.1.0' }, { dev: true })
    expect(JSON.parse(await fs.read('package.json'))).toEqual({
      name: 'app',
      dependencies: { '@strutvane/auth': '0.1.0', 'better-auth': '1.4.0', zod: '4.0.0' },
      devDependencies: { vitest: '5.1.0' },
    })
    expect(await fs.read('package.json')).toMatch(/^\{\n\t"name"/)
    expect(Object.keys(JSON.parse(await fs.read('package.json')).dependencies)).toEqual([
      '@strutvane/auth',
      'better-auth',
      'zod',
    ])
  })

  test('never replaces or moves an existing dependency (any field)', async () => {
    await writeFiles(projectRoot, {
      'package.json': pkg({ dependencies: { zod: '^3.0.0' }, devDependencies: { tsx: '4.0.0' } }),
    })
    const result = await createDepsEditor(fs).ensure({ zod: '4.6.7', tsx: '5.0.0' })
    expect(result).toEqual({ added: [], kept: ['zod', 'tsx'] })
    expect(await fs.changes()).toEqual([]) // idempotent: nothing to write
  })

  test.each([
    'link:../contracts',
    'file:../x.tgz',
    'workspace:*',
    'portal:../x',
    '../local',
    './local',
    '/abs/path',
    'C:\\pkg',
  ])('refuses the local-only spec %s', async (spec) => {
    await writeFiles(projectRoot, { 'package.json': pkg({}) })
    const error = await rejectionOf(createDepsEditor(fs).add({ x: spec }))
    expect((error as DevkitError).code).toBe('LOCAL_DEPENDENCY_SPEC')
  })

  test.each([
    [{ 'Bad Name': '1.0.0' }],
    [{ '../escape': '1.0.0' }],
    [{ ok: '' }],
    [{ ok: 1 as unknown as string }],
  ])('rejects invalid names or versions %j', async (deps) => {
    await writeFiles(projectRoot, { 'package.json': pkg({}) })
    const error = await rejectionOf(createDepsEditor(fs).add(deps))
    expect((error as DevkitError).code).toBe('INVALID_PACKAGE_JSON')
  })

  test.each([
    ['not json', /not valid JSON/],
    ['[]', /JSON object/],
    ['{"dependencies": []}', /must be an object/],
  ])('rejects a broken package.json (%s)', async (content, message) => {
    await writeFiles(projectRoot, { 'package.json': content })
    const error = await rejectionOf(createDepsEditor(fs).add({ a: '1.0.0' }))
    expect((error as DevkitError).code).toBe('INVALID_PACKAGE_JSON')
    expect((error as Error).message).toMatch(message)
  })

  test('preserves CRLF, a BOM and a missing final newline', async () => {
    await writeFiles(projectRoot, { 'package.json': '\uFEFF{\r\n  "name": "a"\r\n}' })
    await createDepsEditor(fs).add({ b: '1.0.0' })
    expect(await fs.read('package.json')).toBe(
      '\uFEFF{\r\n  "name": "a",\r\n  "dependencies": {\r\n    "b": "1.0.0"\r\n  }\r\n}',
    )
  })

  test('reads a missing package.json as an error, not a new file', async () => {
    const error = await rejectionOf(createDepsEditor(fs).add({ a: '1.0.0' }))
    expect((error as DevkitError).code).toBe('FILE_NOT_FOUND')
  })
})

describe('remove', () => {
  test('removes from every field; missing names are ignored', async () => {
    await writeFiles(projectRoot, {
      'package.json': pkg({ dependencies: { a: '1', b: '1' }, devDependencies: { c: '1' } }),
    })
    const deps = createDepsEditor(fs, { path: 'package.json' })
    await deps.remove(['a', 'c', 'missing'])
    expect(JSON.parse(await fs.read('package.json'))).toEqual({
      dependencies: { b: '1' },
      devDependencies: {},
    })
    const before = await fs.changes()
    await deps.remove(['missing'])
    expect(await fs.changes()).toEqual(before)
  })
})

test('detectIndent', () => {
  expect(detectIndent('{\n    "a": 1\n}')).toBe('    ')
  expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t')
  expect(detectIndent('{}')).toBe('  ')
})
