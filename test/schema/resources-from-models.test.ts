/**
 * `.strutvane/resources.json` after the skeleton's findings (2026-11-18):
 *
 * 1. Framework and identity tables (sessions, cache, password_reset_tokens, users…) were sidebar
 *    resources because only `{ internal: true }` tables were left out. Now `INTERNAL_TABLES` (the
 *    list the resource controller already refuses, F-01) applies here too.
 * 2. `fillable` came from the migration, not the model: `users.email_verified_at` was fillable
 *    although `User` allows only name and email. Now the model's `fillable`/`hidden`/
 *    `allowSensitive` decide (read from app/models without running it), and secrets, hidden and
 *    privilege-like columns are never fillable without an explicit opt-in.
 * 3. A string primary key was reported as `id`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { type CommandContextLike, commands } from '../../src/commands.ts'
import { INTERNAL_TABLES as CONTROLLER_LIST } from '../../src/http/app/resource-model.ts'
import { applyOperations } from '../../src/schema/apply.ts'
import { EMPTY_SCHEMA } from '../../src/schema/columns.ts'
import {
  type AppMetadata,
  type FieldMetadata,
  generateMetadata,
} from '../../src/schema/generate/metadata.ts'
import { type ModelOptions, readAppModels } from '../../src/schema/generate/model-options.ts'
import { INTERNAL_TABLES, isInternalTable } from '../../src/schema/internal-tables.ts'
import { recordOperations } from '../../src/schema/migration.ts'

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-resources-'))
  folders.push(root)
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return root
}

const IMPORT = "import { Model } from '@strutvane/framework/database'\n"

/** A `customers` table shaped like Laravel's users table (not on the internal list). */
const state = applyOperations(
  EMPTY_SCHEMA,
  recordOperations((schema) => {
    schema.create('customers', (t) => {
      t.id()
      t.string('name')
      t.string('email').unique()
      t.timestamp('email_verified_at').nullable()
      t.string('password')
      t.string('remember_token', 100).nullable()
      t.boolean('is_admin').default(false)
      t.string('api_key', 64).nullable().secret()
      t.text('internal_note').nullable()
      t.timestamps()
    })
    schema.create('sessions', (t) => {
      t.string('id').primary()
      t.text('payload')
    })
    schema.create('cache', (t) => {
      t.string('key').primary()
      t.text('value')
    })
    schema.create('cache_locks', (t) => {
      t.string('key').primary()
      t.string('owner')
    })
    schema.create('password_reset_tokens', (t) => {
      t.string('email').primary()
      t.string('token')
    })
    schema.create('countries', (t) => {
      t.string('code', 2).primary()
      t.string('name')
    })
  }, EMPTY_SCHEMA),
)

const options = (overrides: Partial<ModelOptions>): ModelOptions => ({
  model: 'Customer',
  file: 'app/models/customer.ts',
  fillable: undefined,
  hidden: [],
  allowSensitive: [],
  ...overrides,
})

function fields(metadata: AppMetadata, table: string): Record<string, FieldMetadata> {
  const resource = metadata.resources.find((candidate) => candidate.table === table)
  if (resource === undefined) throw new Error(`no resource ${table}`)
  return Object.fromEntries(resource.fields.map((field) => [field.name, field]))
}

const fillable = (metadata: AppMetadata, table: string): string[] =>
  Object.values(fields(metadata, table))
    .filter((field) => field.fillable)
    .map((field) => field.name)

describe('internal tables never become resources', () => {
  test('sessions, cache, cache_locks and password_reset_tokens: no resource, listed as internal', () => {
    const metadata = generateMetadata(state)
    expect(metadata.resources.map((resource) => resource.table)).toEqual(['customers', 'countries'])
    expect(metadata.internal).toEqual(['sessions', 'cache', 'cache_locks', 'password_reset_tokens'])
  })

  test('the metadata generator and the resource controller use one list', () => {
    expect(CONTROLLER_LIST).toBe(INTERNAL_TABLES)
    for (const table of ['users', 'sessions', 'jobs', 'failed_jobs', 'personal_access_tokens'])
      expect(isInternalTable(table), table).toBe(true)
    expect(isInternalTable('team_invites')).toBe(true)
    expect(isInternalTable('posts')).toBe(false)
  })

  test('the primary key is the real one, also when it is a string', () => {
    const metadata = generateMetadata(state)
    expect(metadata.resources.find((r) => r.table === 'countries')?.primaryKey).toBe('code')
    expect(metadata.resources.find((r) => r.table === 'customers')?.primaryKey).toBe('id')
  })
})

describe('fillable and hidden come from the model', () => {
  test("only the model's fillable columns are fillable (email_verified_at is not)", () => {
    const metadata = generateMetadata(
      state,
      {},
      new Map([['customers', options({ fillable: ['name', 'email'] })]]),
    )
    expect(fillable(metadata, 'customers')).toEqual(['name', 'email'])
    const verified = fields(metadata, 'customers')['email_verified_at']
    expect(verified).toMatchObject({ fillable: false, required: false, input: 'none' })
  })

  test('without a model: no secret, hidden or privilege-like column is fillable', () => {
    expect(fillable(generateMetadata(state), 'customers')).toEqual(['name', 'email', 'internal_note'])
  })

  test('a model without fillable allows nothing, like Model.create()', () => {
    const metadata = generateMetadata(state, {}, new Map([['customers', options({})]]))
    expect(fillable(metadata, 'customers')).toEqual([])
  })

  test("the model's hidden list hides the field everywhere and keeps it out of forms", () => {
    const metadata = generateMetadata(
      state,
      {},
      new Map([
        ['customers', options({ fillable: ['name', 'internal_note'], hidden: ['internal_note'] })],
      ]),
    )
    expect(fields(metadata, 'customers')['internal_note']).toMatchObject({
      hidden: true,
      fillable: false,
      searchable: false,
      sortable: false,
      listed: false,
      input: 'none',
      filterOperators: [],
    })
  })

  test('secrets, hidden and privilege-like columns need allowSensitive as well as fillable', () => {
    const listed = ['name', 'is_admin', 'email_verified_at', 'api_key', 'password']
    const without = generateMetadata(
      state,
      {},
      new Map([['customers', options({ fillable: listed })]]),
    )
    expect(fillable(without, 'customers')).toEqual(['name'])
    const opted = generateMetadata(
      state,
      {},
      new Map([['customers', options({ fillable: listed, allowSensitive: ['is_admin', 'api_key'] })]]),
    )
    expect(fillable(opted, 'customers')).toEqual(['name', 'is_admin', 'api_key'])
    // A secret stays hidden from responses even when a request may set it.
    expect(fields(opted, 'customers')['api_key']).toMatchObject({ hidden: true, fillable: true })
  })

  test('keys and managed columns are never fillable, whatever the model says', () => {
    const metadata = generateMetadata(
      state,
      {},
      new Map([
        [
          'customers',
          options({ fillable: ['id', 'created_at', 'name'], allowSensitive: ['id', 'created_at'] }),
        ],
      ]),
    )
    expect(fillable(metadata, 'customers')).toEqual(['name'])
  })
})

describe('readAppModels: model settings read without running app code', () => {
  test('literal lists, `as const`, nested folders and the class name', () => {
    const root = project({
      'app/models/customer.ts': `${IMPORT}export class Customer extends Model('customers', {\n  fillable: ['name', 'email'] as const,\n  hidden: ['password', 'remember_token'],\n}) {}\n`,
      'app/models/billing/invoice.ts': `${IMPORT}export class Invoice extends Model(\`invoices\`, { fillable: ['total'], allowSensitive: [] }) {}\n`,
      'app/models/plain.ts': `${IMPORT}export class Plain extends Model('plains') {}\n`,
      'app/models/customer.test.ts': `${IMPORT}class Fake extends Model('customers', { fillable: ['is_admin'] }) {}\n`,
    })
    const { tables, problems } = readAppModels(root)
    expect(problems).toEqual([])
    expect(tables.get('customers')).toEqual({
      model: 'Customer',
      file: 'app/models/customer.ts',
      fillable: ['name', 'email'],
      hidden: ['password', 'remember_token'],
      allowSensitive: [],
    })
    expect(tables.get('invoices')).toMatchObject({ model: 'Invoice', fillable: ['total'] })
    expect(tables.get('plains')?.fillable).toBeUndefined()
  })

  test('anything but literals fails closed, with a problem that says how to fix it', () => {
    const root = project({
      'app/models/draft.ts': `${IMPORT}const FIELDS = ['title']\nexport class Draft extends Model('drafts', { fillable: FIELDS }) {}\n`,
      'app/models/spread.ts': `${IMPORT}const base = { fillable: ['a'] }\nexport class Spread extends Model('spreads', { ...base }) {}\n`,
      'app/models/dynamic.ts': `${IMPORT}const table = 'x'\nexport class Dynamic extends Model(table) {}\n`,
      'app/models/broken.ts': 'export class {',
    })
    const { tables, problems } = readAppModels(root)
    expect(tables.get('drafts')?.fillable).toEqual([])
    expect(tables.get('spreads')?.fillable).toEqual([])
    expect(tables.has('x')).toBe(false)
    expect(problems).toHaveLength(4)
    expect(problems.join('\n')).toContain('arrays of strings')
  })

  test('two models for one table merge to the stricter settings', () => {
    const root = project({
      'app/models/a.ts': `${IMPORT}export class A extends Model('customers', { fillable: ['name', 'email'], hidden: ['x'] }) {}\n`,
      'app/models/b.ts': `${IMPORT}export class B extends Model('customers', { fillable: ['name'], hidden: ['y'] }) {}\n`,
    })
    expect(readAppModels(root).tables.get('customers')).toMatchObject({
      fillable: ['name'],
      hidden: ['x', 'y'],
    })
  })

  test('no app/models folder: nothing to read', () => {
    expect(readAppModels(project({})).tables.size).toBe(0)
  })
})

describe('node strut sync writes resources.json from the models', () => {
  test('the skeleton case: users is internal, a customers model decides fillable', async () => {
    const migration = (name: string, body: string): string =>
      `import { migration } from '@strutvane/framework/schema'\nexport default migration({\n  up(schema) { ${body} },\n  down(schema) { schema.dropIfExists('${name}') },\n})\n`
    const root = project({
      'database/migrations/0001_01_01_000000_create_users_table.ts': migration(
        'users',
        "schema.create('users', (t) => { t.id(); t.string('name'); t.string('email').unique(); t.timestamp('email_verified_at').nullable(); t.string('password'); t.rememberToken?.(); t.timestamps() }); schema.create('sessions', (t) => { t.string('id').primary(); t.text('payload') })",
      ),
      'database/migrations/0001_01_02_000000_create_customers_table.ts': migration(
        'customers',
        "schema.create('customers', (t) => { t.id(); t.string('name'); t.string('email'); t.timestamp('email_verified_at').nullable() })",
      ),
      'app/models/customer.ts': `${IMPORT}export class Customer extends Model('customers', { fillable: ['name', 'email'] }) {}\n`,
      'app/models/odd.ts': `${IMPORT}const F = ['name']\nexport class Odd extends Model('customers', { fillable: F }) {}\n`,
    })
    const warnings: string[] = []
    const command = commands.find((candidate) => candidate.name === 'sync')
    if (command === undefined) throw new Error('no sync command')
    const ctx: CommandContextLike = {
      flags: { 'replay-timeout': '2min' },
      appEnv: 'local',
      services: { env: {} },
      requireProject: () => ({ root }),
      out: {
        line: () => undefined,
        success: () => undefined,
        info: () => undefined,
        warn: (text) => warnings.push(text),
        table: () => undefined,
      },
    }
    await command.run(ctx)
    const metadata = JSON.parse(
      readFileSync(join(root, '.strutvane', 'resources.json'), 'utf8'),
    ) as AppMetadata
    expect(metadata.resources.map((resource) => resource.table)).toEqual(['customers'])
    expect(metadata.internal).toEqual(['users', 'sessions'])
    // Two models for customers: the unreadable one fails closed, so nothing is fillable.
    expect(fillable(metadata, 'customers')).toEqual([])
    expect(warnings.join('\n')).toContain('app/models/odd.ts')
  })
})
