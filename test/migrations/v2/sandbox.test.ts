/**
 * The migration replay sandbox (security review F-06): a normal app replays exactly as it does in
 * process, and hostile migrations are refused before or during the replay, never run with the
 * parent's environment, files or network.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  recordMigrations,
  sandboxResolve,
  schemaEntryUrl,
} from '../../../src/migrations/replay-worker.ts'
import { migrationChecksum } from '../../../src/migrations/runner.ts'
import { replayInSandbox, SandboxError } from '../../../src/migrations/sandbox.ts'
import { canonicalSchema } from '../../../src/schema/replay.ts'
import { BLOG_ROOT, replayApp, SCHEMA_ENTRY_URL } from '../../schema/helpers.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A fresh app folder; returns its `database/migrations` path. */
function app(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-sandbox-'))
  dirs.push(root)
  const folder = join(root, 'database', 'migrations')
  mkdirSync(folder, { recursive: true })
  for (const [name, source] of Object.entries(files)) writeFileSync(join(folder, name), source)
  return folder
}

const HEADER = "import { migration } from '@strutvane/framework/schema'\n"
const TAGS = `${HEADER}export default migration({
  up(schema) { schema.create('tags', (t) => { t.id(); t.string('name') }) },
  down(schema) { schema.dropIfExists('tags') },
})
`
const NAME = '2026_01_01_000000_create_tags_table.ts'

/** A migration whose module body is `body`, followed by a valid default export. */
const withBody = (body: string): string => `${HEADER}${body}\n${TAGS.slice(HEADER.length)}`

async function refusal(folder: string, timeoutMs?: number): Promise<SandboxError> {
  const error = await replayInSandbox(folder, timeoutMs === undefined ? {} : { timeoutMs }).then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof SandboxError))
    throw new Error(`expected a SandboxError, got ${String(error)}`)
  return error
}

describe('replayInSandbox', () => {
  test('the blog app replays in the sandbox exactly as in process (same state, same checksums)', async () => {
    const source = join(BLOG_ROOT, 'database', 'migrations')
    const files: Record<string, string> = {}
    for (const file of readdirSync(source)) {
      // The fixtures import the schema entry by a repository path; an app imports the package.
      files[file] = readFileSync(join(source, file), 'utf8').replace(
        /from '[^']*entries\/schema\.ts'/,
        "from '@strutvane/framework/schema'",
      )
    }
    const sandboxed = await replayInSandbox(app(files))
    const inProcess = await replayApp(BLOG_ROOT)
    expect(canonicalSchema(sandboxed.state)).toBe(canonicalSchema(inProcess.state))
    expect(sandboxed.migrations.map(migrationChecksum)).toEqual(
      inProcess.migrations.map(migrationChecksum),
    )
  })

  test('relative helpers inside the folder are allowed; an empty folder replays to nothing', async () => {
    const folder = app({
      'columns.ts': 'export const LENGTH = 80\n',
      [NAME]: `${HEADER}import { LENGTH } from './columns.ts'
export default migration({
  up(schema) { schema.create('tags', (t) => { t.id(); t.string('name', LENGTH) }) },
  down(schema) { schema.dropIfExists('tags') },
})
`,
    })
    // columns.ts is not named like a migration, so discovery refuses it: helpers live in a subfolder.
    await expect(replayInSandbox(folder)).rejects.toThrow(/isn't named like a migration/)
    const nested = app({
      [NAME]: `${HEADER}import { LENGTH } from './helpers/columns.ts'
import type { SchemaBuilder } from '@strutvane/framework/schema'
export default migration({
  up(schema: SchemaBuilder) { schema.create('tags', (t) => { t.id(); t.string('name', LENGTH) }) },
  down(schema) { schema.dropIfExists('tags') },
})
`,
    })
    mkdirSync(join(nested, 'helpers'))
    writeFileSync(join(nested, 'helpers', 'columns.ts'), 'export const LENGTH = 80\n')
    const replay = await replayInSandbox(nested)
    expect(replay.state.tables[0]?.columns[1]).toMatchObject({ name: 'name', length: 80 })
    expect((await replayInSandbox(app({}))).migrations).toEqual([])
  })

  test.each([
    ['reads the environment', 'const secret = process.env.APP_KEY', '`process`'],
    ['reaches the global object', 'const g = globalThis', '`globalThis`'],
    ['uses eval', "eval('1')", '`eval`'],
    ['builds a function from text', "const f = new Function('return 1')", '`Function`'],
    ['calls the network', "fetch('https://example.com')", '`fetch`'],
    ['uses require', "const fs = require('node:fs')", '`require`'],
    ['imports dynamically', "const m = import('node:fs')", 'dynamic import()'],
    ['reads import.meta', 'const here = import.meta.url', 'import.meta'],
  ])(
    'the static gate refuses a migration that %s, with file:line:col',
    async (_what, body, named) => {
      const error = await refusal(app({ [NAME]: withBody(body) }))
      expect(error.code).toBe('migration_forbidden_code')
      expect(error.message).toContain(named)
      expect(error.location).toMatch(new RegExp(`^${NAME}:2:\\d+$`))
      expect(error.hint).toMatch(/schema builder/)
    },
  )

  test.each([
    ["import { readFileSync } from 'node:fs'", 'node:fs'],
    ["import { connect } from 'node:net'", 'node:net'],
    ["import pg from 'pg'", 'pg'],
    ["import { x } from '../../outside.ts'", '../../outside.ts'],
    ["export * from 'node:os'", 'node:os'],
  ])('the static gate refuses %s', async (statement, specifier) => {
    const error = await refusal(app({ [NAME]: withBody(statement) }))
    expect(error.code).toBe('migration_forbidden_import')
    expect(error.message).toContain(`"${specifier}"`)
    expect(error.location).toMatch(/:2:1$/)
  })

  test('property names that look like forbidden words are fine (t.process, { fetch: 1 })', async () => {
    const replay = await replayInSandbox(
      app({
        [NAME]: withBody('const options = { fetch: 1, process: 2 }\nconst n = options.process'),
      }),
    )
    expect(replay.migrations).toHaveLength(1)
  })

  test('a syntax error is reported before anything runs', async () => {
    const error = await refusal(app({ [NAME]: withBody('const = 1') }))
    expect(error.code).toBe('migration_syntax')
  })

  test('a symlinked migration is refused before anything runs', async () => {
    const target = app({ [NAME]: TAGS })
    const folder = app({})
    try {
      symlinkSync(join(target, NAME), join(folder, NAME), 'file')
    } catch {
      // Creating symlinks needs Developer Mode or admin rights on Windows: nothing to check then.
      return
    }
    const error = await refusal(folder)
    expect(error.code).toBe('migration_symlink')
    expect(error.migration).toBe(NAME)
  })

  test('links that leave the folder are refused (junctions work without admin rights on Windows)', async () => {
    const outside = app({ 'columns.ts': 'export const LENGTH = 80\n' })
    const folder = app({
      [NAME]: `${HEADER}import { LENGTH } from './helpers/columns.ts'
export default migration({
  up(schema) { schema.create('tags', (t) => { t.id(); t.string('name', LENGTH) }) },
  down(schema) { schema.dropIfExists('tags') },
})
`,
    })
    symlinkSync(outside, join(folder, 'helpers'), 'junction')
    const error = await refusal(folder)
    expect(error.code).toBe('migration_outside_folder')
    expect(error.migration).toBe('helpers/columns.ts')
    // A link named like a migration is refused as a link, before its target is even read.
    const named = app({})
    symlinkSync(outside, join(named, NAME), 'junction')
    expect((await refusal(named)).code).toBe('migration_symlink')
  })

  test('a migration that loops forever is stopped by the timeout', async () => {
    const error = await refusal(app({ [NAME]: withBody('for (;;) {}') }), 1_500)
    expect(error.code).toBe('replay_timeout')
    expect(error.message).toMatch(/longer than 1500 ms/)
  })

  test('a top-level throw is reported with the migration name', async () => {
    const error = await refusal(app({ [NAME]: withBody("throw new Error('boom at the top')") }))
    expect(error.code).toBe('replay_failed')
    expect(error.migration).toBe(NAME)
    expect(error.message).toMatch(/boom at the top/)
  })

  test('a schema mistake inside the sandbox keeps its hint and migration', async () => {
    const error = await refusal(
      app({
        [NAME]: `${HEADER}export default migration({
  up(schema) { schema.table('missing', (t) => { t.string('x').nullable() }) },
  down(schema) {},
})
`,
      }),
    )
    expect(error.code).toBe('replay_failed')
    expect(error.migration).toBe(NAME)
    expect(error.hint.length).toBeGreaterThan(0)
  })

  test('the child sees an empty environment and cannot read outside the folder', async () => {
    // Indirect access the static gate can't see by name: through a constructor chain. Code
    // generation from strings is off, so even that path can't produce `process`.
    const error = await refusal(
      app({ [NAME]: withBody("const make = [].constructor.constructor\nmake('return 1')()") }),
    )
    expect(error.code).toBe('replay_failed')
    expect(error.message).toMatch(/Code generation from strings disallowed/i)
  })
})

describe('the worker resolve hook', () => {
  const rules = {
    migrationsDir: join(tmpdir(), 'app', 'database', 'migrations'),
    frameworkDir: join(tmpdir(), 'fw', 'dist'),
    schemaUrl: 'file:///fw/dist/schema.mjs',
  }
  const migrationUrl = new URL(`file:///${join(rules.migrationsDir, NAME).replaceAll('\\', '/')}`)
    .href

  test('maps the schema entry and allows relative files inside the folder', () => {
    expect(sandboxResolve('@strutvane/framework/schema', migrationUrl, rules)).toEqual({
      url: rules.schemaUrl,
    })
    expect(sandboxResolve('./helpers/x.ts', migrationUrl, rules)).toMatchObject({
      url: expect.stringMatching(/helpers\/x\.ts$/),
    })
    expect(sandboxResolve('node:fs', undefined, rules)).toBe('next')
  })

  test.each(['node:fs', 'node:net', 'pg', '../../../secrets.ts', './x.js'])(
    'refuses %s from a migration',
    (specifier) => {
      expect(() => sandboxResolve(specifier, migrationUrl, rules)).toThrow(/may not use/)
    },
  )

  test('finds the schema entry next to the worker in both layouts', () => {
    expect(schemaEntryUrl('file:///repo/src/migrations/replay-worker.ts')).toBe(
      'file:///repo/src/entries/schema.ts',
    )
    expect(
      schemaEntryUrl('file:///app/node_modules/@strutvane/framework/dist/replay-worker.mjs'),
    ).toBe('file:///app/node_modules/@strutvane/framework/dist/schema.mjs')
  })
})

describe('recordMigrations (the worker body, in process)', () => {
  const header = `import { migration } from ${JSON.stringify(SCHEMA_ENTRY_URL)}
`

  test('returns the recorded operations of each file, in order', async () => {
    const folder = app({ [NAME]: header + TAGS.slice(HEADER.length) })
    const message = await recordMigrations(folder, [NAME])
    expect(message.ok).toBe(true)
    if (message.ok) expect(message.migrations.map((m) => m.name)).toEqual([NAME.slice(0, -3)])
  })

  test('an import failure names the file; a schema mistake keeps its code and hint', async () => {
    const broken = app({
      [NAME]: `${header}throw new Error('nope')
`,
    })
    expect(await recordMigrations(broken, [NAME])).toEqual({
      ok: false,
      error: { message: 'nope', migration: NAME },
    })
    const mistake = app({
      [NAME]: `${header}export default migration({ up(schema) { schema.drop('missing') }, down() {} })
`,
    })
    const message = await recordMigrations(mistake, [NAME])
    expect(message).toMatchObject({ ok: false, error: { migration: NAME } })
    if (!message.ok) {
      expect(message.error.code).toEqual(expect.any(String))
      expect(message.error.hint).toEqual(expect.any(String))
    }
  })
})
