/**
 * Templates for every `make:*` generator.
 *
 * Templates are plain functions from validated input to file content: no template engine, no
 * `eval`, and every user-supplied value reaches the output only through {@link quote} or a
 * validated number/identifier. Output is deterministic (no timestamps or random values inside
 * files), which is what makes generators idempotent and golden-testable.
 *
 * Generated model, resource and policy files keep the exact static shape the registry compiler
 * reads (ADR-0010): a default-exported `define*()` call with literal names and object literals.
 *
 * @module
 */
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { categoryOf, type FieldSpec, modifierInfo, typeInfo } from './fields.ts'
import type { Names } from './names.ts'
import { quote } from './names.ts'

/** Options of a generated model (`defineModel` third argument). */
export interface ModelOptions {
  readonly timestamps: boolean
  readonly softDeletes: boolean
  /** `undefined`: follow the project's tenancy config. */
  readonly tenant: boolean | undefined
  readonly audit: boolean
  readonly api: boolean
  readonly ui: boolean
}

/** Project-relative output paths, in one place so commands and docs agree. */
export const paths: Readonly<{
  model: (n: Names) => string
  policy: (n: Names) => string
  resource: (n: Names) => string
  factory: (n: Names) => string
  seeder: (n: Names) => string
  featureTest: (n: Names) => string
  test: (n: Names, kind: TestKind) => string
  migration: (timestamp: string, snake: string, sql: boolean) => string
}> = Object.freeze({
  model: (n: Names) => `app/models/${n.kebab}.model.ts`,
  policy: (n: Names) => `app/policies/${n.kebab}.policy.ts`,
  resource: (n: Names) => `app/resources/${n.kebab}.resource.ts`,
  factory: (n: Names) => `database/factories/${n.kebab}.factory.ts`,
  seeder: (n: Names) => `database/seeders/${n.kebab}.seeder.ts`,
  featureTest: (n: Names) => `tests/feature/${n.kebabPlural}.test.ts`,
  test: (n: Names, kind: TestKind) => `tests/${kind}/${n.kebab}.test.ts`,
  migration: (timestamp: string, snake: string, sql: boolean) =>
    `database/migrations/${timestamp}_${snake}.${sql ? 'sql' : 'ts'}`,
})

/** The kinds of test `make:test` creates. */
export type TestKind = 'feature' | 'unit' | 'e2e'

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/

/** A field that cannot be rendered safely (only reachable by bypassing input validation). */
function unrenderable(field: FieldSpec, detail: string): CliError {
  return new CliError('invalid_field', {
    exitCode: EXIT.VALIDATION,
    params: { spec: String(field.name).slice(0, 40), detail },
  })
}

/**
 * Last line of defence before code generation: generators validate fields with the catalogue
 * schema, but templates are exported too, so every name that is written into code unquoted (the
 * property name, `field.<type>`, `.<modifier>`) is re-checked here against the catalogue.
 */
function assertRenderable(field: FieldSpec): void {
  if (!FIELD_NAME.test(field.name)) throw unrenderable(field, 'the name is not lower camelCase')
  if (typeInfo(field.type) === undefined) throw unrenderable(field, 'unknown field type')
  for (const mod of field.modifiers) {
    if (modifierInfo(mod.name) === undefined) throw unrenderable(field, 'unknown modifier')
  }
}

/** A number written into code unquoted, re-checked at render time (never trusted from input). */
function numberArg(field: FieldSpec, value: string | undefined): string {
  if (value === undefined || !NUMBER.test(value)) {
    throw unrenderable(field, 'a numeric argument is not a number')
  }
  return value
}

/** Render one argument for generated code: numbers stay numbers, everything else is quoted. */
function literal(value: string, numeric: boolean): string {
  return numeric && NUMBER.test(value) ? value : quote(value)
}

/** `field.decimal(12, 2)` etc.: the builder call for a field's type. */
function typeCall(field: FieldSpec): string {
  const args = field.typeArgs
  switch (field.type) {
    case 'string':
    case 'decimal':
      return `field.${field.type}(${args.map((a) => numberArg(field, a)).join(', ')})`
    case 'enum':
    case 'set':
      return `field.${field.type}([${args.map(quote).join(', ')}])`
    case 'manyToMany': {
      const [model = '', through] = args
      return through === undefined
        ? `field.manyToMany(${quote(model)})`
        : `field.manyToMany(${quote(model)}, { through: ${quote(through)} })`
    }
    default:
      return `field.${field.type}(${args.map(quote).join(', ')})`
  }
}

/** `.default(0)`, `.min(1)`, `.label('Due date')`… for one modifier. */
function modifierCall(field: FieldSpec, name: string, args: readonly string[]): string {
  const category = categoryOf(field)
  const numericValue = category === 'integer' || category === 'number'
  switch (name) {
    case 'default': {
      if (category === 'boolean') return `.default(${args[0] === 'true' ? 'true' : 'false'})`
      if (field.type === 'set') return `.default([${args.map(quote).join(', ')}])`
      return `.default(${literal(args[0] ?? '', numericValue)})`
    }
    case 'min':
    case 'max':
    case 'length':
      return `.${name}(${args.map((a) => numberArg(field, a)).join(', ')})`
    default:
      return `.${name}(${args.map(quote).join(', ')})`
  }
}

/** The full builder chain for one field. */
export function fieldBuilder(field: FieldSpec): string {
  assertRenderable(field)
  return `${typeCall(field)}${field.modifiers.map((m) => modifierCall(field, m.name, m.args)).join('')}`
}

/** `app/models/<name>.model.ts`. */
export function modelTemplate(
  n: Names,
  fields: readonly FieldSpec[],
  options: ModelOptions,
): string {
  const fieldLines =
    fields.length === 0
      ? ['    // name: field.string().required(),']
      : fields.map((f) => `    ${f.name}: ${fieldBuilder(f)},`)
  const opts = [
    `timestamps: ${options.timestamps}`,
    ...(options.softDeletes ? ['softDeletes: true'] : []),
    ...(options.tenant === undefined ? [] : [`tenant: ${options.tenant}`]),
    ...(options.audit ? ['audit: true'] : []),
    ...(options.api ? [] : ['api: false']),
    ...(options.ui ? [] : ['ui: false']),
  ]
  return [
    "import { defineModel, field } from '@strutvane/framework'",
    '',
    '/**',
    ` * ${n.pascal}: one row of \`${n.snakePlural}\`. Fields drive the migration, validation, the API,`,
    ' * OpenAPI and the UI. Generated by `sv make:model`; this file is yours to edit.',
    ' */',
    'export default defineModel(',
    `  ${quote(n.pascal)},`,
    '  {',
    ...fieldLines,
    '  },',
    `  { ${opts.join(', ')} },`,
    ')',
    '',
  ].join('\n')
}

/** Policy templates offered by `make:policy --template`. */
export type PolicyTemplate = 'default' | 'owner' | 'tenant-admin' | 'readonly'

/**
 * The role names generated apps use (docs/07 §2.7; the same names as `config/auth.ts`):
 * `admin`, `member`, `viewer`, and `owner` (a tenant's creator, held inside that tenant only).
 */
export const ROLES = {
  admin: 'admin',
  member: 'member',
  viewer: 'viewer',
  owner: 'owner',
} as const

/**
 * One `allow(...)` line, formatted exactly as Biome prints it (line width 100): on one line when
 * it fits, otherwise with the options object broken one property per line.
 */
function allowLine(actions: readonly string[], options: readonly string[]): string[] {
  const list = `[${actions.map(quote).join(', ')}]`
  const inline = `  allow(${list}, { ${options.join(', ')} })`
  if (inline.length <= 100) return [inline]
  return [`  allow(${list}, {`, ...options.map((o) => `    ${o},`), '  })']
}

const roleOption = (roles: readonly string[]): string =>
  roles.length === 1 ? `role: ${quote(roles[0] ?? '')}` : `role: [${roles.map(quote).join(', ')}]`

/** `app/policies/<name>.policy.ts`. Deny-by-default: only listed actions are ever allowed. */
export function policyTemplate(n: Names, template: PolicyTemplate, softDeletes: boolean): string {
  const writes = [
    'create',
    'update',
    'delete',
    'export',
    ...(softDeletes ? ['restore', 'forceDelete'] : []),
  ]
  const { admin, member, viewer, owner } = ROLES
  const readers = roleOption([viewer, member, admin])
  let rules: string[]
  switch (template) {
    case 'owner':
      rules = [
        ...allowLine(['viewAny', 'create'], [roleOption([member, admin])]),
        '  // Members see and change only their own records (needs an ownerId field).',
        ...allowLine(
          ['view', 'update', 'delete'],
          [roleOption([member]), 'when: ({ actor, row }) => row.ownerId.eq(actor.id)'],
        ),
        ...allowLine(['view', ...writes.filter((a) => a !== 'create')], [roleOption([admin])]),
      ]
      break
    case 'tenant-admin':
      rules = [
        '  // Tenant administrators (admin or owner inside the tenant) manage; everyone else reads.',
        ...allowLine(
          ['viewAny', 'view'],
          [roleOption([viewer, member, admin, owner]), "scope: 'tenant'"],
        ),
        ...allowLine(writes, [roleOption([admin, owner]), "scope: 'tenant'"]),
      ]
      break
    case 'readonly':
      rules = allowLine(['viewAny', 'view'], [readers])
      break
    default:
      rules = [
        ...allowLine(['viewAny', 'view'], [readers]),
        ...allowLine(writes, [roleOption([admin])]),
      ]
  }
  return [
    "import { definePolicy } from '@strutvane/auth'",
    "import { policySchema } from '@strutvane/framework'",
    `import ${n.pascal} from '../models/${n.kebab}.model.ts'`,
    '',
    '/**',
    ` * Who may do what with ${n.labelPlural.toLowerCase()}. Deny-by-default: anything not allowed here is`,
    ' * refused, and `deny` always wins over `allow`. Rules compile to SQL, so lists are filtered in',
    ' * the database. Role names match config/auth.ts, whose role map grants on top of these rules',
    ' * (a `deny` here still wins). Generated by `sv make:policy`; this file is yours to edit.',
    ' */',
    `export default definePolicy(${quote(n.camel)}, { schema: policySchema(${n.pascal}) }, ({ allow }) => {`,
    ...rules,
    '})',
    '',
  ].join('\n')
}

/** Lifecycle hooks a resource may declare. */
export const RESOURCE_HOOKS: readonly string[] = [
  'beforeCreate',
  'afterCreate',
  'beforeUpdate',
  'afterUpdate',
  'beforeDelete',
  'afterDelete',
  'beforeRestore',
  'afterRestore',
  'onWrite',
  'afterCommit',
]

/** Parameters of each hook, matching `ResourceHooks` in `@strutvane/framework`. */
const HOOK_PARAMS: Readonly<Record<string, readonly string[]>> = {
  beforeCreate: ['input', 'ctx'],
  afterCreate: ['record', 'ctx'],
  beforeUpdate: ['patch', 'existing', 'ctx'],
  afterUpdate: ['record', 'previous', 'ctx'],
  beforeDelete: ['record', 'ctx'],
  afterDelete: ['record', 'ctx'],
  beforeRestore: ['record', 'ctx'],
  afterRestore: ['record', 'ctx'],
  onWrite: ['change', 'ctx'],
  afterCommit: ['change', 'ctx'],
}

/** `app/resources/<name>.resource.ts`. */
export function resourceTemplate(
  n: Names,
  actions: readonly string[],
  hooks: readonly string[],
): string {
  const body: string[] = []
  if (actions.length === 0) {
    body.push(`  // actions: { approve: { label: 'Approve' } },  // permission: ${n.camel}.approve`)
  } else {
    body.push('  actions: {')
    for (const action of actions) {
      const label = action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
      body.push(
        `    ${action}: { label: ${quote(label.charAt(0).toUpperCase() + label.slice(1))} },`,
      )
    }
    body.push('  },')
  }
  if (hooks.length > 0) {
    body.push('  hooks: {')
    hooks.forEach((hook, i) => {
      const params = HOOK_PARAMS[hook] ?? ['ctx']
      body.push(
        `    async ${hook}(${params.join(', ')}) {`,
        `      // ${hook} logic for ${n.label.toLowerCase()} records`,
        `      void [${params.join(', ')}]`,
        '    },',
      )
      if (i < hooks.length - 1) body.push('')
    })
    body.push('  },')
  }
  return [
    "import { defineResource } from '@strutvane/framework'",
    `import ${n.pascal} from '../models/${n.kebab}.model.ts'`,
    '',
    '/**',
    ` * API and UI behaviour for ${n.labelPlural.toLowerCase()}: custom actions (each gets a route, a`,
    ' * permission and a UI button) and lifecycle hooks. Generated by `sv make:resource`.',
    ' */',
    `export default defineResource(${n.pascal}, {`,
    ...body,
    '})',
    '',
  ].join('\n')
}

/** The fake-data expression for one field, or `undefined` when the factory should skip it. */
function fakeValue(field: FieldSpec): string | undefined {
  const mod = (name: string): string | undefined => {
    const value = field.modifiers.find((m) => m.name === name)?.args[0]
    return value === undefined ? undefined : numberArg(field, value)
  }
  const range = (min: string, max: string): string =>
    `{ min: ${mod('min') ?? min}, max: ${mod('max') ?? max} }`
  const bounds = (min: string, max: string): string =>
    `min: ${mod('min') ?? min}, max: ${mod('max') ?? max}`
  const [first, second] = field.typeArgs
  switch (field.type) {
    case 'string':
      return 'fake.words(3)'
    case 'text':
    case 'richText':
    case 'markdown':
      return 'fake.paragraph()'
    case 'email':
    case 'url':
    case 'phone':
    case 'slug':
    case 'password':
    case 'color':
    case 'uuid':
    case 'ulid':
    case 'address':
    case 'geoPoint':
    case 'boolean':
    case 'date':
    case 'time':
    case 'datetime':
    case 'duration':
      return `fake.${field.type}()`
    case 'timestamp':
      return 'fake.datetime()'
    case 'id':
      return 'fake.uuid()'
    case 'integer':
    case 'bigInteger':
      return `fake.integer(${range('0', '1000')})`
    case 'decimal':
      return `fake.decimal({ ${bounds('0', '10000')}, scale: ${second === undefined ? '2' : numberArg(field, second)} })`
    case 'float':
      return `fake.float(${range('0', '1000')})`
    case 'money':
      return first === undefined ? 'fake.money()' : `fake.money({ currency: ${quote(first)} })`
    case 'percent':
      return `fake.integer(${range('0', '100')})`
    case 'enum':
      return `fake.pick([${field.typeArgs.map(quote).join(', ')}])`
    case 'set':
      return `fake.subset([${field.typeArgs.map(quote).join(', ')}])`
    case 'json':
      return '{}'
    case 'array':
      return '[]'
    case 'belongsTo':
      return `related(${quote(first ?? '')})`
    default:
      return undefined // relations to many, morphs, files and computed fields are not faked
  }
}

/** `database/factories/<name>.factory.ts`. */
export function factoryTemplate(n: Names, fields: readonly FieldSpec[]): string {
  const lines = fields.flatMap((f) => {
    assertRenderable(f)
    const value = fakeValue(f)
    return value === undefined
      ? [`  // ${f.name}: ${f.type} is not generated by the factory`]
      : [`  ${f.name}: ${value},`]
  })
  const usesRelated = fields.some((f) => f.type === 'belongsTo')
  return [
    "import { defineFactory } from '@strutvane/framework/testing'",
    `import ${n.pascal} from '../../app/models/${n.kebab}.model.ts'`,
    '',
    `/** Realistic fake ${n.labelPlural.toLowerCase()} for tests and seeders. Generated by \`sv make:factory\`. */`,
    `export default defineFactory(${n.pascal}, ({ ${usesRelated ? 'fake, related' : 'fake'} }) => ({`,
    ...(lines.length === 0 ? ['  // name: fake.words(3),'] : lines),
    '}))',
    '',
  ].join('\n')
}

/** `database/seeders/<name>.seeder.ts`. */
export function seederTemplate(n: Names, model: Names | undefined, count: number): string {
  const body =
    model === undefined
      ? ['  // await create(SomeFactory, 10, scope)']
      : [`  await create(${model.pascal}Factory, ${count}, scope)`]
  return [
    "import { defineSeeder } from '@strutvane/framework/database'",
    ...(model === undefined
      ? []
      : [`import ${model.pascal}Factory from '../factories/${model.kebab}.factory.ts'`]),
    '',
    `/** Seeds development data. Run with \`sv db:seed --class ${n.pascal}Seeder\`. */`,
    // `scope` carries `sv db:seed --tenant <id>`, so tenant-scoped models seed too (M2).
    `export default defineSeeder(${quote(`${n.pascal}Seeder`)}, async ({ create, scope }) => {`,
    ...body,
    '})',
    '',
  ].join('\n')
}

/** `tests/feature/<plural>.test.ts`: CRUD and deny-by-default checks for a model's API. */
export function featureTestTemplate(n: Names, options: { readonly api: boolean }): string {
  const url = `/api/v1/${n.kebabPlural}`
  if (!options.api) return testTemplate(n, 'feature', n)
  return [
    "import { describe, expect, test } from 'vitest'",
    "import { createTestApp } from '@strutvane/framework/testing'",
    `import ${n.pascal} from '../../app/models/${n.kebab}.model.ts'`,
    `import ${n.pascal}Factory from '../../database/factories/${n.kebab}.factory.ts'`,
    '',
    "const actor = { id: '00000000-0000-4000-8000-000000000001', type: 'user', roles: [], attrs: {} } as const",
    '',
    `describe(${quote(`${n.pascal} API`)}, () => {`,
    `  test(${quote(`lists ${n.labelPlural.toLowerCase()}`)}, async () => {`,
    `    const t = await createTestApp({ resources: [${n.pascal}] })`,
    `    await ${n.pascal}Factory.createMany(t, 3)`,
    `    const res = await t.actingAs(actor).request<{ data: unknown[] }>('GET', ${quote(url)})`,
    '    expect(res.status).toBe(200)',
    '    expect(res.body.data).toHaveLength(3)',
    '    await t.close()',
    '  })',
    '',
    `  test(${quote('denies access without a permission (deny-by-default)')}, async () => {`,
    `    const t = await createTestApp({ resources: [${n.pascal}], permissions: 'deny' })`,
    `    const res = await t.actingAs(actor).request('GET', ${quote(url)})`,
    '    expect(res.status).toBe(403)',
    '    await t.close()',
    '  })',
    '',
    `  test(${quote(`creates a new ${n.label.toLowerCase()}`)}, async () => {`,
    `    const t = await createTestApp({ resources: [${n.pascal}] })`,
    `    const res = await t.actingAs(actor).request('POST', ${quote(url)}, {`,
    `      body: ${n.pascal}Factory.attributes(),`,
    '    })',
    '    expect(res.status).toBe(201)',
    '    await t.close()',
    '  })',
    '})',
    '',
  ].join('\n')
}

/** `tests/<kind>/<name>.test.ts`. */
export function testTemplate(n: Names, kind: TestKind, model: Names | undefined): string {
  if (kind === 'e2e') {
    return [
      "import { expect, test } from '@playwright/test'",
      '',
      `test(${quote(`${n.label.toLowerCase()} page loads`)}, async ({ page }) => {`,
      `  await page.goto(${quote(`/${model?.kebabPlural ?? n.kebabPlural}`)})`,
      `  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()`,
      '})',
      '',
    ].join('\n')
  }
  const imports =
    kind === 'feature' ? ["import { createTestApp } from '@strutvane/framework/testing'"] : []
  return [
    "import { describe, expect, test } from 'vitest'",
    ...imports,
    ...(model === undefined
      ? []
      : [`import ${model.pascal} from '../../app/models/${model.kebab}.model.ts'`]),
    '',
    `describe(${quote(n.label)}, () => {`,
    `  test(${quote('works')}, async () => {`,
    ...(kind === 'feature'
      ? [
          `    const t = await createTestApp({ resources: [${model === undefined ? '' : model.pascal}] })`,
          '    expect(t.http).toBeDefined()',
          '    await t.close()',
        ]
      : []),
    ...(model === undefined
      ? []
      : [`    expect(${model.pascal}.name).toBe(${quote(model.pascal)})`]),
    ...(kind === 'unit' && model === undefined ? ['    expect(true).toBe(true)'] : []),
    '  })',
    '})',
    '',
  ].join('\n')
}

/**
 * A migration stub (`make:migration`): TypeScript (`defineMigration({ up({ db }) })`, run by
 * `sv migrate` inside its transaction) or raw SQL (statements separated by
 * `--> statement-breakpoint`). Both match what `@strutvane/framework` executes today: there is no
 * rollback yet, so `down()` is recorded for later and SQL files have no down section.
 */
export function migrationTemplate(
  name: string,
  options: { readonly sql: boolean; readonly table: string | undefined },
): string {
  const table = options.table
  if (options.sql) {
    return [
      `-- ${name}`,
      '-- Hand-written migration, applied by `sv migrate` in timestamp order inside one transaction.',
      '-- Separate statements with a line containing only: --> statement-breakpoint',
      '',
      table === undefined
        ? '-- UPDATE some_table SET ...;'
        : `-- ALTER TABLE "${table}" ADD COLUMN ...;`,
      '',
    ].join('\n')
  }
  const statement = (verb: string): string =>
    table === undefined
      ? `    // await db.execute('${verb} ...')`
      : `    // await db.execute('ALTER TABLE "${table}" ${verb} ...')`
  return [
    "import { defineMigration } from '@strutvane/framework/database'",
    '',
    '/**',
    ` * ${name}: a hand-written migration (data changes or special DDL). \`sv migrate\` runs up()`,
    ' * in timestamp order inside its transaction; use db.execute(sql, params) with bound parameters.',
    ' */',
    'export default defineMigration({',
    '  async up({ db }) {',
    statement(table === undefined ? 'UPDATE' : 'ADD COLUMN'),
    '    void db',
    '  },',
    '  // Kept for the planned rollback command; not run yet.',
    '  async down({ db }) {',
    statement(table === undefined ? 'UPDATE' : 'DROP COLUMN'),
    '    void db',
    '  },',
    '})',
    '',
  ].join('\n')
}
