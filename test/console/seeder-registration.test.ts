/**
 * Registering seeders in `database/seeders/database.seeder.ts`: the pure text patch (fresh file,
 * old starter shape, idempotency, dependency order, files left alone), Biome's verdict on the
 * result, and the `make:model` / `make:seeder` integration.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  CANONICAL_DATABASE_SEEDER,
  compareImportSources,
  DATABASE_SEEDER_PATH,
  type RegistrationResult,
  registerSeeder,
  type SeederRegistration,
} from '../../src/console/make/seeder-registration.ts'
import { cleanupTempDirs, cli, makeProject, read, write } from './helpers.ts'

afterAll(cleanupTempDirs)

const DOC = [
  '/**',
  " * Seeds the database (`node strut db:seed`). `node strut make:model` registers each new model's seeder here,",
  ' * after the seeders of the models it belongs to.',
  ' */',
]
const COMMENT =
  '  // `node strut make:model` adds `await call(…)` lines here, parents before children.'

const customer: SeederRegistration = {
  seeder: 'CustomerSeeder',
  importPath: './customer.seeder.ts',
  after: [],
  before: [],
}
const invoice: SeederRegistration = {
  seeder: 'InvoiceSeeder',
  importPath: './invoice.seeder.ts',
  after: ['CustomerSeeder'],
  before: [],
}

/** The content of a successful registration (fails the test otherwise). */
function contentOf(result: RegistrationResult): string {
  if (result.status === 'unrecognised') throw new Error(`unrecognised: ${result.manual.join('; ')}`)
  return result.content
}

const lines = (...l: string[]): string => [...l, ''].join('\n')

describe('registerSeeder', () => {
  test('a missing file is created in canonical shape with the seeder registered', () => {
    const result = registerSeeder(undefined, customer)
    expect(result).toMatchObject({ status: 'registered', created: true, migrated: false })
    expect(contentOf(result)).toBe(
      lines(
        ...DOC,
        "import { defineSeeder } from '@strutvane/framework/database'",
        "import CustomerSeeder from './customer.seeder.ts'",
        '',
        "export default defineSeeder('DatabaseSeeder', async ({ call }) => {",
        COMMENT,
        '  await call(CustomerSeeder)',
        '})',
      ),
    )
  })

  test('Customer then Invoice (Invoice belongs to Customer): the documented result', () => {
    const once = contentOf(registerSeeder(CANONICAL_DATABASE_SEEDER, customer))
    const twice = registerSeeder(once, invoice)
    expect(twice).toMatchObject({ status: 'registered', created: false, missingAfter: [] })
    expect(contentOf(twice)).toBe(
      lines(
        ...DOC,
        "import { defineSeeder } from '@strutvane/framework/database'",
        "import CustomerSeeder from './customer.seeder.ts'",
        "import InvoiceSeeder from './invoice.seeder.ts'",
        '',
        "export default defineSeeder('DatabaseSeeder', async ({ call }) => {",
        COMMENT,
        '  await call(CustomerSeeder)',
        '  await call(InvoiceSeeder)',
        '})',
      ),
    )
  })

  test('idempotent: registering again changes nothing', () => {
    const once = contentOf(registerSeeder(CANONICAL_DATABASE_SEEDER, customer))
    const again = registerSeeder(once, customer)
    expect(again).toMatchObject({ status: 'unchanged', content: once })
  })

  test('a missing import or a missing call alone is completed', () => {
    const full = contentOf(registerSeeder(CANONICAL_DATABASE_SEEDER, customer))
    const noCall = full.replace('  await call(CustomerSeeder)\n', '')
    expect(contentOf(registerSeeder(noCall, customer))).toBe(full)
    const noImport = full.replace("import CustomerSeeder from './customer.seeder.ts'\n", '')
    expect(contentOf(registerSeeder(noImport, customer))).toBe(full)
  })

  test('the old starter shape (with its doc comment) is migrated, keeping its command and auth note', () => {
    const old = lines(
      '/**',
      ' * Seeds the database (`npm run sv -- db:seed`). Call other seeders from here, in order.',
      ' * The first admin user comes from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in .env.',
      ' */',
      "import { defineSeeder } from '@strutvane/framework/database'",
      '',
      'export default defineSeeder({',
      '  async run() {',
      '    // await call(InvoiceSeeder)',
      '  },',
      '})',
    )
    const result = registerSeeder(old, customer)
    expect(result).toMatchObject({ status: 'registered', migrated: true, created: false })
    expect(contentOf(result)).toBe(
      lines(
        '/**',
        " * Seeds the database (`npm run sv -- db:seed`). `node strut make:model` registers each new model's seeder here,",
        ' * after the seeders of the models it belongs to.',
        ' * The first admin user comes from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in .env.',
        ' */',
        "import { defineSeeder } from '@strutvane/framework/database'",
        "import CustomerSeeder from './customer.seeder.ts'",
        '',
        "export default defineSeeder('DatabaseSeeder', async ({ call }) => {",
        COMMENT,
        '  await call(CustomerSeeder)',
        '})',
      ),
    )
    // and the migrated file is then handled like any canonical one
    expect(registerSeeder(contentOf(result), customer).status).toBe('unchanged')
  })

  test('order: after the last parent; a parent registered later goes before its children', () => {
    // The child first: its parent is not registered yet, which is reported.
    const child = registerSeeder(CANONICAL_DATABASE_SEEDER, invoice)
    expect(child).toMatchObject({ status: 'registered', missingAfter: ['CustomerSeeder'] })
    // The parent later, knowing (from the models) that Invoice belongs to Customer.
    const parent = contentOf(
      registerSeeder(contentOf(child), { ...customer, before: ['InvoiceSeeder'] }),
    )
    expect(parent.indexOf('await call(CustomerSeeder)')).toBeLessThan(
      parent.indexOf('await call(InvoiceSeeder)'),
    )
    // Several parents: after the last of them.
    const tag = contentOf(
      registerSeeder(parent, { ...customer, seeder: 'TagSeeder', importPath: './tag.seeder.ts' }),
    )
    const line = contentOf(
      registerSeeder(tag, {
        seeder: 'InvoiceLineSeeder',
        importPath: './invoice-line.seeder.ts',
        after: ['InvoiceSeeder', 'CustomerSeeder'],
        before: [],
      }),
    )
    const calls = line.split('\n').filter((l) => l.startsWith('  await call('))
    expect(calls).toEqual([
      '  await call(CustomerSeeder)',
      '  await call(InvoiceSeeder)',
      '  await call(InvoiceLineSeeder)',
      '  await call(TagSeeder)',
    ])
    expect(line.split('\n').filter((l) => l.startsWith('import'))).toEqual([
      "import { defineSeeder } from '@strutvane/framework/database'",
      "import CustomerSeeder from './customer.seeder.ts'",
      "import InvoiceSeeder from './invoice.seeder.ts'",
      "import InvoiceLineSeeder from './invoice-line.seeder.ts'",
      "import TagSeeder from './tag.seeder.ts'",
    ])
  })

  test('an existing destructuring gains call; CRLF files stay CRLF', () => {
    const withCreate = CANONICAL_DATABASE_SEEDER.replace('async () =>', 'async ({ create }) =>')
    expect(contentOf(registerSeeder(withCreate, customer))).toContain(
      "defineSeeder('DatabaseSeeder', async ({ create, call }) => {",
    )
    const crlf = CANONICAL_DATABASE_SEEDER.replaceAll('\n', '\r\n')
    const out = contentOf(registerSeeder(crlf, customer))
    expect(out.split('\r\n').length).toBe(out.split('\n').length)
    expect(out).toContain("import CustomerSeeder from './customer.seeder.ts'\r\n")
  })

  test('files that do not match the anchors are never edited: the lines to add are returned', () => {
    const cases = [
      // hand-written seeder
      lines(
        "import { defineSeeder } from '@strutvane/framework/database'",
        '',
        'export default defineSeeder({',
        '  async run({ call }) {',
        '    await call(Other)',
        '  },',
        '})',
      ),
      // the old shape with an edited body
      CANONICAL_DATABASE_SEEDER.replace(
        "export default defineSeeder('DatabaseSeeder', async () => {",
        'export default defineSeeder(async () => {',
      ),
      // an unknown callback parameter
      CANONICAL_DATABASE_SEEDER.replace('async () =>', 'async (ctx) =>'),
      // code after the seeder
      `${CANONICAL_DATABASE_SEEDER}export const x = 1\n`,
      // two openers
      `${CANONICAL_DATABASE_SEEDER}${CANONICAL_DATABASE_SEEDER}`,
      // a multi-line import
      CANONICAL_DATABASE_SEEDER.replace(
        "import { defineSeeder } from '@strutvane/framework/database'",
        "import {\n  defineSeeder,\n} from '@strutvane/framework/database'",
      ),
      // the binding already imported from somewhere else
      CANONICAL_DATABASE_SEEDER.replace(
        "from '@strutvane/framework/database'",
        "from '@strutvane/framework/database'\nimport CustomerSeeder from './other.seeder.ts'",
      ),
      // the path already imported under another name
      CANONICAL_DATABASE_SEEDER.replace(
        "from '@strutvane/framework/database'",
        "from '@strutvane/framework/database'\nimport Customers from './customer.seeder.ts'",
      ),
      '',
    ]
    for (const content of cases) {
      expect(registerSeeder(content, customer), content).toEqual({
        status: 'unrecognised',
        manual: [
          "import CustomerSeeder from './customer.seeder.ts'",
          'await call(CustomerSeeder)   (inside the defineSeeder callback, whose parameter is ({ call }))',
        ],
      })
    }
    expect(registerSeeder(undefined, { ...customer, importPath: '../evil.ts' }).status).toBe(
      'unrecognised',
    )
    expect(registerSeeder(undefined, { ...customer, seeder: 'x; evil()' }).status).toBe(
      'unrecognised',
    )
  })

  test("import order follows Biome's natural order (as observed with Biome 2.6)", () => {
    const biomeOrder = [
      './a.seeder.ts',
      './a-1.seeder.ts',
      './a-b.seeder.ts',
      './a-b-c.seeder.ts',
      './a-bc.seeder.ts',
      './a1.seeder.ts',
      './a9-x.seeder.ts',
      './a10.seeder.ts',
      './ab.seeder.ts',
      './b.seeder.ts',
    ]
    const shuffled = [...biomeOrder].reverse()
    expect(shuffled.sort(compareImportSources)).toEqual(biomeOrder)
  })
})

describe('Biome accepts the patched file', () => {
  const require = createRequire(import.meta.url)
  const biomeBin = join(dirname(require.resolve('@biomejs/biome/package.json')), 'bin', 'biome')
  const dir = mkdtempSync(join(tmpdir(), 'sv-seeder-biome-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('check (format, lint, organizeImports) passes with the starter settings', () => {
    // The formatter and import settings of create-strutvane's biome.json.
    writeFileSync(
      join(dir, 'biome.json'),
      JSON.stringify({
        root: true,
        formatter: { enabled: true, indentStyle: 'space', indentWidth: 2, lineWidth: 100 },
        javascript: {
          formatter: { quoteStyle: 'single', semicolons: 'asNeeded', trailingCommas: 'all' },
        },
        linter: { enabled: true, rules: { recommended: true } },
        assist: { actions: { source: { organizeImports: 'on' } } },
      }),
    )
    let content = CANONICAL_DATABASE_SEEDER
    for (const r of [
      invoice,
      { ...customer, before: ['InvoiceSeeder'] },
      {
        seeder: 'InvoiceLineSeeder',
        importPath: './invoice-line.seeder.ts',
        after: ['InvoiceSeeder'],
        before: [],
      },
      { seeder: 'A1Seeder', importPath: './a1.seeder.ts', after: [], before: [] },
      { seeder: 'ASeeder', importPath: './a.seeder.ts', after: [], before: [] },
    ]) {
      content = contentOf(registerSeeder(content, r))
    }
    writeFileSync(join(dir, 'database.seeder.ts'), content)
    const r = spawnSync(process.execPath, [biomeBin, 'check', 'database.seeder.ts'], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  })
})

describe('make:model and make:seeder register the seeder', () => {
  test('a fresh project gets the canonical file; parents run first; a second run is a no-op', async () => {
    const root = makeProject()
    const first = await cli(['make:model', 'Customer', 'name:string[120]:required', '--json'], {
      cwd: root,
    })
    expect(first.code, first.stdout).toBe(0)
    expect(first.json().data).toMatchObject({
      seederRegistration: { seeder: 'CustomerSeeder', status: 'registered', created: true },
    })
    const second = await cli(
      ['make:model', 'Invoice', 'number:string', 'customer:belongsTo[Customer]'],
      { cwd: root },
    )
    expect(second.code, second.stderr).toBe(0)
    expect(second.stderr).toContain(`Registered InvoiceSeeder in ${DATABASE_SEEDER_PATH}.`)
    expect(read(root, DATABASE_SEEDER_PATH)).toBe(
      lines(
        ...DOC,
        "import { defineSeeder } from '@strutvane/framework/database'",
        "import CustomerSeeder from './customer.seeder.ts'",
        "import InvoiceSeeder from './invoice.seeder.ts'",
        '',
        "export default defineSeeder('DatabaseSeeder', async ({ call }) => {",
        COMMENT,
        '  await call(CustomerSeeder)',
        '  await call(InvoiceSeeder)',
        '})',
      ),
    )
    const again = await cli(
      ['make:model', 'Invoice', 'number:string', 'customer:belongsTo[Customer]', '--json'],
      { cwd: root },
    )
    expect(again.code).toBe(0)
    expect(again.json().data).toMatchObject({ seederRegistration: { status: 'unchanged' } })
  })

  test('a child before its parent: warned, and the parent is later placed before it', async () => {
    const root = makeProject()
    const child = await cli(['make:model', 'Invoice', 'customer:belongsTo(Customer)'], {
      cwd: root,
    })
    expect(child.code).toBe(0)
    expect(child.stderr).toContain('CustomerSeeder is not registered')
    expect((await cli(['make:model', 'Customer', 'name:string'], { cwd: root })).code).toBe(0)
    const calls = read(root, DATABASE_SEEDER_PATH)
      .split('\n')
      .filter((l) => l.startsWith('  await call('))
    expect(calls).toEqual(['  await call(CustomerSeeder)', '  await call(InvoiceSeeder)'])
  })

  test('--dry-run writes nothing; --no-seeder registers nothing', async () => {
    const root = makeProject()
    const dry = await cli(['make:model', 'Customer', 'name:string', '--dry-run'], { cwd: root })
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain(`would create database/seeders/database.seeder.ts`)
    expect(dry.stderr).toContain(
      `Would register CustomerSeeder in ${DATABASE_SEEDER_PATH} (new file).`,
    )
    expect(() => read(root, DATABASE_SEEDER_PATH)).toThrow()
    const none = await cli(['make:model', 'Customer', 'name:string', '--no-seeder', '--json'], {
      cwd: root,
    })
    expect(none.json().data).toMatchObject({ seederRegistration: null })
    expect(() => read(root, DATABASE_SEEDER_PATH)).toThrow()
  })

  test('the old starter file is migrated; an unrecognised one is left alone with instructions', async () => {
    const root = makeProject()
    write(
      root,
      DATABASE_SEEDER_PATH,
      lines(
        '/**',
        ' * Seeds the database (`node strut db:seed`). Call other seeders from here, in order.',
        ' */',
        "import { defineSeeder } from '@strutvane/framework/database'",
        '',
        'export default defineSeeder({',
        '  async run() {',
        '    // await call(InvoiceSeeder)',
        '  },',
        '})',
      ),
    )
    const migrated = await cli(['make:model', 'Customer', 'name:string'], { cwd: root })
    expect(migrated.code).toBe(0)
    expect(migrated.stderr).toContain('(updated to the current shape)')
    expect(read(root, DATABASE_SEEDER_PATH)).toContain(
      "export default defineSeeder('DatabaseSeeder', async ({ call }) => {",
    )

    const custom = makeProject()
    const handWritten = lines('export default async function seed() {}')
    write(custom, DATABASE_SEEDER_PATH, handWritten)
    const r = await cli(['make:model', 'Customer', 'name:string', '--json'], { cwd: custom })
    expect(r.code).toBe(0)
    expect(read(custom, DATABASE_SEEDER_PATH)).toBe(handWritten)
    expect(r.json().data).toMatchObject({
      seederRegistration: {
        status: 'manual',
        manual: ["import CustomerSeeder from './customer.seeder.ts'", expect.any(String)],
      },
    })
  })

  test('make:seeder --model registers by the model; without --model nothing is registered', async () => {
    const root = makeProject()
    expect(
      (await cli(['make:model', 'Customer', 'name:string', '--no-seeder'], { cwd: root })).code,
    ).toBe(0)
    expect((await cli(['make:seeder', 'DemoData'], { cwd: root })).code).toBe(0)
    expect(() => read(root, DATABASE_SEEDER_PATH)).toThrow()
    const r = await cli(['make:seeder', 'Customer', '--model', 'Customer'], { cwd: root })
    expect(r.code, r.stderr).toBe(0)
    expect(read(root, DATABASE_SEEDER_PATH)).toContain('  await call(CustomerSeeder)')
  })
})
