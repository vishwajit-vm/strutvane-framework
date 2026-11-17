/**
 * Generator inputs are untrusted (generators are public and their fields need not come from the
 * field parser): the catalogue schema, render-time re-checks, and a fuzz test proving that no
 * field object, however hostile, can add statements to a generated file.
 */
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { parseSync } from 'oxc-parser'
import { afterAll, describe, expect, test } from 'vitest'
import {
  type FieldSpec,
  formatFieldSpec,
  modifierInfo,
  parseFieldSpec,
  typeInfo,
} from '../../src/console/make/fields.ts'
import { FieldSchema, factoryGenerator, modelGenerator } from '../../src/console/make/generators.ts'
import { names, WINDOWS_RESERVED } from '../../src/console/make/names.ts'
import { factoryTemplate, fieldBuilder, modelTemplate } from '../../src/console/make/templates.ts'
import { assertNoLink, UnsafeOutputPathError } from '../../src/console/registry/compiler.ts'
import { runGenerator } from '../../src/devkit/index.ts'
import { cleanupTempDirs, cli, makeProject, tempDir, write } from './helpers.ts'

afterAll(cleanupTempDirs)

const OPTIONS = {
  timestamps: true,
  softDeletes: false,
  tenant: undefined,
  audit: false,
  api: true,
  ui: true,
} as const

/** Top-level statements of a generated file; fails the test on any syntax error. */
function statements(source: string): { type: string }[] {
  const parsed = parseSync('generated.ts', source, { sourceType: 'module' })
  expect(parsed.errors.filter((e) => e.severity === 'Error')).toEqual([])
  return parsed.program.body as { type: string }[]
}

/** The properties of the object literal passed as `defineModel`'s 2nd argument. */
function modelFieldCount(source: string): number {
  const body = statements(source)
  expect(body.map((s) => s.type)).toEqual(['ImportDeclaration', 'ExportDefaultDeclaration'])
  const decl = body[1] as unknown as {
    declaration: { type: string; arguments: { type: string; properties?: unknown[] }[] }
  }
  expect(decl.declaration.type).toBe('CallExpression')
  expect(decl.declaration.arguments).toHaveLength(3)
  return decl.declaration.arguments[1]?.properties?.length ?? -1
}

/** Strings an attacker would try: code breakouts, comments, quotes, prototype keys. */
const hostile = fc.oneof(
  fc.constantFrom(
    '',
    'string',
    'decimal',
    'enum',
    'min',
    'max',
    'default',
    'label',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    '1); process.exit(1); (',
    "'); require('child_process').execSync('x'); ('",
    '`${globalThis.x}`',
    '*/ evil() /*',
    'a\nimport x from "y"',
    'x y',
    '0x10',
    '1e9',
    '-0',
    '12.5.1',
    'NaN',
    'Infinity',
    ' 1',
    '1 ',
    '10, 2',
  ),
  fc.string({ maxLength: 20 }),
  fc.stringMatching(/^[A-Za-z0-9_();'"`\n ,.*/${}-]{0,16}$/),
)

const hostileField = fc.record({
  name: fc.oneof(hostile, fc.constantFrom('title', 'amount')),
  type: hostile,
  typeArgs: fc.array(hostile, { maxLength: 3 }),
  modifiers: fc.array(fc.record({ name: hostile, args: fc.array(hostile, { maxLength: 2 }) }), {
    maxLength: 3,
  }),
})

describe('FieldSchema: the field catalogue is enforced', () => {
  test.each([
    [{ name: 'title', type: 'string', typeArgs: ['200'], modifiers: [] }, true],
    [
      {
        name: 'amount',
        type: 'decimal',
        typeArgs: ['12', '2'],
        modifiers: [{ name: 'min', args: ['0'] }],
      },
      true,
    ],
    [
      {
        name: 'status',
        type: 'enum',
        typeArgs: ['a', 'b'],
        modifiers: [{ name: 'default', args: ['a'] }],
      },
      true,
    ],
    [{ name: 'x', type: 'evil', typeArgs: [], modifiers: [] }, false],
    [{ name: 'x', type: 'constructor', typeArgs: [], modifiers: [] }, false],
    [{ name: 'x', type: 'string', typeArgs: ['1); evil(); ('], modifiers: [] }, false],
    [
      {
        name: 'x',
        type: 'string',
        typeArgs: [],
        modifiers: [{ name: 'min', args: ['0); evil(); ('] }],
      },
      false,
    ],
    [
      {
        name: 'x',
        type: 'string',
        typeArgs: [],
        modifiers: [{ name: 'required); evil(); (', args: [] }],
      },
      false,
    ],
    [
      { name: 'x', type: 'string', typeArgs: [], modifiers: [{ name: '__proto__', args: [] }] },
      false,
    ],
    [{ name: 'x', type: 'decimal', typeArgs: ['99', '2'], modifiers: [] }, false],
    [{ name: 'x', type: 'boolean', typeArgs: ['1'], modifiers: [] }, false],
    [
      {
        name: 'x',
        type: 'string',
        typeArgs: [],
        modifiers: [
          { name: 'required', args: [] },
          { name: 'required', args: [] },
        ],
      },
      false,
    ],
    [{ name: 'x', type: 'string', typeArgs: [' 12'], modifiers: [] }, false],
  ])('%j → %s', (field, ok) => {
    expect(FieldSchema.safeParse(field).success).toBe(ok)
  })

  test('generators reject out-of-catalogue fields before writing anything', async () => {
    const root = makeProject()
    const field = { name: 'x', type: 'string', typeArgs: ['1); evil(); ('], modifiers: [] }
    await expect(
      runGenerator(
        factoryGenerator,
        { model: 'Invoice', fields: [field] },
        { projectRoot: root, dryRun: true },
      ),
    ).rejects.toMatchObject({ code: 'generator_input_invalid' })
    const ok = await runGenerator(
      modelGenerator,
      {
        name: 'Invoice',
        fields: [parseFieldSpec('amount:decimal(12,2):min(0)')],
        options: OPTIONS,
        with: { policy: false, factory: true, seeder: false, test: false, resource: false },
        seedCount: 10,
      },
      { projectRoot: root, dryRun: true },
    )
    expect(ok.changes.map((c) => c.path)).toEqual([
      'app/models/invoice.model.ts',
      'database/factories/invoice.factory.ts',
    ])
  })
})

describe('fuzz: hostile field objects never produce extra statements', () => {
  test('through the schema: rejected, or rendered as exactly the declared fields', () => {
    const n = names('Invoice')
    fc.assert(
      fc.property(fc.array(hostileField, { maxLength: 3 }), (fields) => {
        const valid = fields.filter((f) => FieldSchema.safeParse(f).success) as FieldSpec[]
        const unique = valid.filter((f, i) => valid.findIndex((g) => g.name === f.name) === i)
        for (const f of unique) {
          expect(typeInfo(f.type)).toBeDefined()
          for (const m of f.modifiers) expect(modifierInfo(m.name)).toBeDefined()
          expect(parseFieldSpec(formatFieldSpec(f))).toEqual(f)
        }
        const model = modelTemplate(n, unique, OPTIONS)
        expect(modelFieldCount(model)).toBe(unique.length === 0 ? 0 : unique.length)
        const factory = factoryTemplate(n, unique)
        expect(statements(factory).map((s) => s.type)).toEqual([
          'ImportDeclaration',
          'ImportDeclaration',
          'ExportDefaultDeclaration',
        ])
      }),
      { numRuns: 400 },
    )
  })

  test('bypassing the schema: templates refuse, or still render only the declared field', () => {
    const n = names('Invoice')
    fc.assert(
      fc.property(hostileField, (field) => {
        let model: string
        try {
          model = modelTemplate(n, [field], OPTIONS)
        } catch (error) {
          expect(error).toMatchObject({ code: 'invalid_field', exitCode: 3 })
          return
        }
        expect(modelFieldCount(model)).toBe(1)
        let factory: string
        try {
          factory = factoryTemplate(n, [field])
        } catch (error) {
          expect(error).toMatchObject({ code: 'invalid_field' })
          return
        }
        expect(statements(factory)).toHaveLength(3)
      }),
      { numRuns: 600 },
    )
  })

  test('numbers are re-checked at render time', () => {
    const field = (patch: Partial<FieldSpec>): FieldSpec => ({
      name: 'x',
      type: 'string',
      typeArgs: [],
      modifiers: [],
      ...patch,
    })
    for (const bad of [
      field({ typeArgs: ['1); evil(); ('] }),
      field({ type: 'decimal', typeArgs: ['10', '2) + evil(('] }),
      field({ modifiers: [{ name: 'min', args: ['0x10'] }] }),
      field({ name: 'x: evil(), y' }),
      field({ type: 'toString' }),
      field({ modifiers: [{ name: 'constructor', args: [] }] }),
    ]) {
      expect(() => fieldBuilder(bad)).toThrow(expect.objectContaining({ code: 'invalid_field' }))
    }
    expect(() =>
      factoryTemplate(names('Invoice'), [
        field({ type: 'decimal', typeArgs: ['10', '2; evil()'] }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'invalid_field' }))
    expect(() =>
      factoryTemplate(names('Invoice'), [
        field({ type: 'integer', modifiers: [{ name: 'max', args: ['1 }); evil(); ({'] }] }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'invalid_field' }))
  })
})

describe('names: Windows device names', () => {
  test.each(['Con', 'con', 'PRN', 'Aux', 'Nul', 'Com1', 'LPT9', 'lpt3'])(
    '%s is refused',
    (name) => {
      expect(() => names(name, 'Model name')).toThrow(
        expect.objectContaining({ code: 'invalid_name', exitCode: 3 }),
      )
    },
  )

  test('similar but legal names are accepted', () => {
    for (const name of [
      'Console',
      'Auxiliary',
      'Com',
      'Lpt',
      'Null',
      'Prn2x',
      'ConItem',
      'Com-1',
    ]) {
      expect(names(name).pascal).toBeTruthy()
    }
    expect(WINDOWS_RESERVED.test('con')).toBe(true)
    expect(WINDOWS_RESERVED.test('con.model')).toBe(false)
  })
})

describe('field parser: prototype keys are not catalogue entries', () => {
  test.each([
    ['x:constructor', 'unknown_type'],
    ['x:__proto__', 'unknown_type'],
    ['x:toString', 'unknown_type'],
    ['x:hasOwnProperty', 'unknown_type'],
    ['x:string:constructor', 'unknown_modifier'],
    ['x:string:__proto__', 'unknown_modifier'],
    ['x:string:valueOf', 'unknown_modifier'],
  ])('%s → %s', (spec, code) => {
    expect(() => parseFieldSpec(spec)).toThrow(expect.objectContaining({ code }))
  })
})

describe('registry output never goes through a link', () => {
  test('a .strutvane symlink or junction is refused (exit 3) and nothing is written through it', async () => {
    const root = makeProject({
      'app/models/tag.model.ts':
        "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Tag', { name: field.string() })\n",
    })
    const elsewhere = tempDir()
    try {
      symlinkSync(elsewhere, join(root, '.strutvane'), 'junction')
    } catch {
      return // links not permitted on this machine
    }
    const r = await cli(['registry:build', '--json'], { cwd: root })
    expect(r.code).toBe(3)
    expect(r.json().error?.code).toBe('unsafe_output_path')
    expect(readdirSync(elsewhere)).toEqual([])
    expect(() => assertNoLink(join(root, '.strutvane'))).toThrow(UnsafeOutputPathError)
    expect(() => assertNoLink(join(root, 'missing'))).not.toThrow()
  })

  test('a stale temp file at the temp path is replaced, never followed', async () => {
    const root = makeProject({
      'app/models/tag.model.ts':
        "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Tag', { name: field.string() })\n",
    })
    const out = join(root, '.strutvane', 'registry.gen.ts')
    write(root, `.strutvane/registry.gen.ts.${process.pid}.tmp`, 'stale')
    const r = await cli(['registry:build', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('Tag')
    expect(existsSync(`${out}.${process.pid}.tmp`)).toBe(false)
  })
})
