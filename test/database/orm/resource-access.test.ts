/**
 * The authorization controls of the generated CRUD API (`ResourceController`) over real ORM
 * models, as properties over random policies, rows and actors:
 *
 * 1. **List scope:** `index` returns exactly the rows the policy's `view` allows: its
 *    `viewScope` (the same rule as SQL conditions) is ANDed into the query, and `view` checks
 *    every row once more. `show` agrees row by row (200 or 404).
 * 2. **Re-check after a write:** after `store` / `update` the row is read again in the same
 *    transaction through `view` (and `update`); a write that moves it out of the caller's reach
 *    is a 403 and is rolled back, so the database is unchanged.
 * 3. **Foreign keys:** an id the client writes must name a row the caller may `view` under the
 *    related model's own policy; missing and not visible are the same 422 `not_found`.
 * 4. **Field-level read rules:** `readableFields(user)` limits the fields of lists, single
 *    records and included rows, and a field the user may not read can't be filtered or sorted.
 * 5. **Includes:** `?include=` shows only the related rows the related policy allows.
 *
 * Plus the boot checks: a `view` that reads the record without a `viewScope`, and a writable
 * foreign key without a relation, stop the boot; a `view` that hides its record parameter
 * (`...rest`) fails closed at the first list.
 *
 * Runs on SQLite, and on PostgreSQL, MySQL and MariaDB when Docker provides them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fc from 'fast-check'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import type { Policy } from '../../../src/auth/gate.ts'
import { PolicyRegistryToken } from '../../../src/auth/policies.ts'
import { type CommandContextLike, commands } from '../../../src/commands.ts'
import { configureOrm, registerSchema, runWithConnection } from '../../../src/database/index.ts'
import { Application } from '../../../src/foundation/application.ts'
import { DatabaseConnectionToken } from '../../../src/foundation/database.ts'
import type { AuthUser } from '../../../src/foundation/registry.ts'
import { ResourceController } from '../../../src/http/app/resource-controller.ts'
import type { Constraint } from '../../../src/http/app/resource-model.ts'
import { defineRoutes, Route } from '../../../src/routing/route.ts'
import { testClient } from '../../../src/testing/app-client.ts'
import { APP_KEY } from '../../app/helpers.ts'
import { serverDatabase, skipReason } from '../../helpers/server-database.ts'
import { Folder } from './fixtures/app/models/folder.ts'
import { LooseNote, Note } from './fixtures/app/models/note.ts'

const FOLDERS = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('folders', (t) => {
      t.id()
      t.integer('owner_id')
      t.string('team', 10)
      t.string('name', 100)
    })
  },
  down(schema) { schema.dropIfExists('folders') },
})
`
const NOTES = `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('notes', (t) => {
      t.id()
      t.foreignId('folder_id').nullable().constrained()
      t.integer('owner_id')
      t.enum('status', ['draft', 'shared', 'archived']).default('draft')
      t.string('team', 10)
      t.string('title', 100)
      t.integer('score').nullable()
    })
  },
  down(schema) { schema.dropIfExists('notes') },
})
`

// ---------------------------------------------------------------------------------------------
// Random rules: a conjunction of clauses, each a disjunction of equalities (what `viewScope`
// constraints can say: a list is ANDed, `anyOf` ORs). `$actor` stands for the actor's id.
// ---------------------------------------------------------------------------------------------

type Column = 'owner_id' | 'status' | 'team'
interface Leaf {
  readonly column: Column
  readonly value: number | string | '$actor'
}
/** `[]` is "every row"; a clause `[]` is "no row" (an empty disjunction). */
type Rule = readonly (readonly Leaf[])[]

const STATUSES = ['draft', 'shared', 'archived'] as const
const TEAMS = ['a', 'b', 'c'] as const
const OWNERS = [1, 2, 3] as const

const leaf: fc.Arbitrary<Leaf> = fc.oneof(
  fc.record({
    column: fc.constant<Column>('owner_id'),
    value: fc.oneof(fc.constantFrom(...OWNERS), fc.constant<'$actor'>('$actor')),
  }),
  fc.record({ column: fc.constant<Column>('status'), value: fc.constantFrom(...STATUSES) }),
  fc.record({ column: fc.constant<Column>('team'), value: fc.constantFrom(...TEAMS) }),
)
const rule: fc.Arbitrary<Rule> = fc.array(fc.array(leaf, { minLength: 0, maxLength: 3 }), {
  minLength: 0,
  maxLength: 3,
})

function leafValue(item: Leaf, user: AuthUser): number | string {
  return item.value === '$actor' ? Number(user.id) : item.value
}

/** The rule in JavaScript: what `view` / `update` answer for one row. */
function holds(current: Rule, user: AuthUser | null, row: object): boolean {
  if (user === null) return false
  return current.every((clause) =>
    clause.some((item) => Reflect.get(row, item.column) === leafValue(item, user)),
  )
}

/** The same rule as list constraints: what `viewScope` answers. */
function scopeOf(current: Rule, user: AuthUser | null): boolean | Constraint[] {
  if (user === null) return false
  if (current.length === 0) return true
  return current.map((clause) => ({
    anyOf: clause.map((item) => ({ column: item.column, equals: leafValue(item, user) })),
  }))
}

/** One random scenario's policies, changed between runs (the registry holds these objects). */
const state = {
  view: [] as Rule,
  update: [] as Rule,
  folderView: [] as Rule,
  readable: undefined as readonly string[] | undefined,
}

const isAdmin = (user: AuthUser | null): boolean =>
  user !== null && Array.isArray(user.roles) && user.roles.includes('admin')

/** The notes policy: random `view`, `update` and readable fields; admins may do everything. */
class NotePolicy implements Policy<Note> {
  before(user: AuthUser | null): boolean | undefined {
    return isAdmin(user) ? true : undefined
  }
  viewAny(user: AuthUser | null): boolean {
    return user !== null
  }
  view(user: AuthUser | null, note: Note): boolean {
    return holds(state.view, user, note)
  }
  viewScope(user: AuthUser | null): boolean | Constraint[] {
    return scopeOf(state.view, user)
  }
  create(user: AuthUser | null): boolean {
    return user !== null
  }
  update(user: AuthUser | null, note: Note): boolean {
    return holds(state.update, user, note)
  }
  readableFields(): readonly string[] | undefined {
    return state.readable
  }
}

/** The folders policy: a random `view` of its own, which also decides which folder ids notes may name. */
class FolderPolicy implements Policy<Folder> {
  viewAny(user: AuthUser | null): boolean {
    return user !== null
  }
  view(user: AuthUser | null, folder: Folder): boolean {
    return holds(state.folderView, user, folder)
  }
  viewScope(user: AuthUser | null): boolean | Constraint[] {
    return scopeOf(state.folderView, user)
  }
}

class NoteController extends ResourceController<typeof Note> {
  protected readonly model = Note
}
class FolderController extends ResourceController<typeof Folder> {
  protected readonly model = Folder
}

// ---------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------

const folders: string[] = []
const apps: Application[] = []
afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.shutdown()))
})
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

function write(root: string, path: string, content: string): void {
  const file = join(root, ...path.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function appFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'sv-access-'))
  folders.push(root)
  write(root, 'database/migrations/2026_01_01_000000_create_folders_table.ts', FOLDERS)
  write(root, 'database/migrations/2026_01_02_000000_create_notes_table.ts', NOTES)
  return root
}

async function migrate(root: string, env: Readonly<Record<string, string>>): Promise<void> {
  const command = commands.find((candidate) => candidate.name === 'migrate')
  if (command === undefined) throw new Error('no migrate command')
  const quiet = (): undefined => undefined
  const ctx: CommandContextLike = {
    flags: {},
    appEnv: 'testing',
    services: { env: { ...env, APP_ENV: 'testing', DB_MIGRATION_REPLAY_TIMEOUT: '2min' } },
    requireProject: () => ({ root }),
    out: { line: quiet, success: quiet, info: quiet, warn: quiet, table: quiet },
  }
  await command.run(ctx)
  registerSchema({ version: 1, tables: {} })
  configureOrm({ tenancy: false })
}

const policies = {
  name: 'test.policies',
  register: () => undefined,
  boot: (app: Application) => {
    const registry = app.make(PolicyRegistryToken)
    registry.register(Note, new NotePolicy())
    registry.register(Folder, new FolderPolicy())
  },
}

function application(
  root: string,
  env: Readonly<Record<string, string>>,
  routes = defineRoutes([
    Route.apiResource('notes', NoteController),
    Route.apiResource('folders', FolderController),
  ]),
): Application {
  const app = Application.configure({
    basePath: root,
    env: { APP_ENV: 'testing', APP_DEBUG: 'false', APP_KEY, ...env },
  })
    .withProviders([policies])
    .withRouting({ api: routes })
    // Hundreds of requests per test from one user: the api limiter is not what is tested here.
    .withMiddleware((middleware) => {
      middleware.rateLimiter('api', { maxAttempts: 100_000, decaySeconds: 60 })
    })
    .create()
  apps.push(app)
  return app
}

interface EngineCase {
  readonly name: 'sqlite' | 'postgres' | 'mysql' | 'mariadb'
  readonly skipped: string | undefined
  readonly runs: number
  database(): Promise<{ env: Record<string, string>; drop: () => Promise<void> }>
}

const server =
  (engine: 'postgres' | 'mysql' | 'mariadb'): EngineCase['database'] =>
  async () => {
    const db = await serverDatabase(engine)
    const connection = engine === 'postgres' ? 'pgsql' : engine
    return { env: { DB_CONNECTION: connection, DB_URL: db.url }, drop: () => db.drop() }
  }

const ENGINES: readonly EngineCase[] = [
  {
    name: 'sqlite',
    skipped: undefined,
    runs: 25,
    database: async () => ({
      env: { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' },
      drop: async () => undefined,
    }),
  },
  { name: 'postgres', skipped: skipReason('postgres'), runs: 6, database: server('postgres') },
  { name: 'mysql', skipped: skipReason('mysql'), runs: 6, database: server('mysql') },
  { name: 'mariadb', skipped: skipReason('mariadb'), runs: 6, database: server('mariadb') },
]

// ---------------------------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------------------------

interface NoteRow {
  folder_id: number | null
  owner_id: number
  status: (typeof STATUSES)[number]
  team: (typeof TEAMS)[number]
  title: string
  score: number | null
}
interface FolderRow {
  owner_id: number
  team: (typeof TEAMS)[number]
  name: string
}

const folderRow: fc.Arbitrary<FolderRow> = fc.record({
  owner_id: fc.constantFrom(...OWNERS),
  team: fc.constantFrom(...TEAMS),
  name: fc.constantFrom('inbox', 'work', 'misc'),
})
const noteRow = (folderCount: number): fc.Arbitrary<NoteRow> =>
  fc.record({
    folder_id: fc.option(fc.integer({ min: 0, max: Math.max(0, folderCount - 1) }), {
      nil: null,
    }),
    owner_id: fc.constantFrom(...OWNERS),
    status: fc.constantFrom(...STATUSES),
    team: fc.constantFrom(...TEAMS),
    title: fc.constantFrom('alpha', 'beta', 'gamma'),
    score: fc.option(fc.integer({ min: 0, max: 99 }), { nil: null }),
  })
const READABLE = ['folder_id', 'owner_id', 'status', 'team', 'title', 'score'] as const
const actor: fc.Arbitrary<AuthUser> = fc
  .record({ id: fc.constantFrom(...OWNERS), admin: fc.boolean() })
  .map(
    ({ id, admin }) =>
      ({
        id: String(id),
        type: 'user',
        roles: admin ? ['admin'] : ['member'],
        attrs: {},
      }) as AuthUser,
  )

const scenario = fc
  .record({
    view: rule,
    update: rule,
    folderView: rule,
    readable: fc.option(fc.subarray([...READABLE]), { nil: undefined }),
    actor,
    folders: fc.array(folderRow, { minLength: 1, maxLength: 4 }),
    patch: fc.record(
      {
        owner_id: fc.constantFrom(...OWNERS),
        status: fc.constantFrom(...STATUSES),
        team: fc.constantFrom(...TEAMS),
      },
      { requiredKeys: [] },
    ),
    pick: fc.nat(),
    create: fc.record({
      owner_id: fc.constantFrom(...OWNERS),
      status: fc.constantFrom(...STATUSES),
      team: fc.constantFrom(...TEAMS),
      folder: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
    }),
  })
  .chain((base) =>
    fc
      .array(noteRow(base.folders.length), { minLength: 0, maxLength: 12 })
      .map((notes) => ({ ...base, notes })),
  )

type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never

/** Every key of a JSON record. */
const keysOf = (record: unknown): string[] =>
  typeof record === 'object' && record !== null ? Object.keys(record) : []

async function runScenario(app: Application, given: Scenario): Promise<void> {
  state.view = given.view
  state.update = given.update
  state.folderView = given.folderView
  state.readable = given.readable
  const connection = () => app.make(DatabaseConnectionToken)

  // Fresh rows for this run.
  const { folderModels, noteModels } = await runWithConnection(connection, async () => {
    for (const note of await Note.all()) await note.forceDelete()
    for (const folder of await Folder.all()) await folder.forceDelete()
    const folderModels: Folder[] = []
    for (const row of given.folders) folderModels.push(await Folder.forceCreate(row))
    const noteModels: Note[] = []
    for (const row of given.notes)
      noteModels.push(
        await Note.forceCreate({
          ...row,
          folder_id: row.folder_id === null ? null : (folderModels[row.folder_id]?.id ?? null),
        }),
      )
    return { folderModels, noteModels }
  })

  const user = given.actor
  const admin = isAdmin(user)
  const client = testClient(app).withoutCsrf().actingAs(user)
  const canView = (row: object): boolean => admin || holds(given.view, user, row)
  const canUpdate = (row: object): boolean => admin || holds(given.update, user, row)
  const canViewFolder = (row: object): boolean => holds(given.folderView, user, row)
  const readable =
    admin || given.readable === undefined ? undefined : new Set<string>(given.readable)
  const assertReadable = (record: unknown): void => {
    if (readable === undefined) return
    for (const key of keysOf(record)) if (key !== 'id') expect(readable.has(key), key).toBe(true)
  }

  // 1. The list is exactly the rows `view` allows; `show` agrees.
  const list = await client.getJson('/api/notes?page[size]=100')
  list.assertStatus(200)
  const listed = (list.json as { data: { id: number }[] }).data
  expect(listed.map((row) => row.id).sort((a, b) => a - b)).toEqual(
    noteModels
      .filter(canView)
      .map((note) => note.id)
      .sort((a, b) => a - b),
  )
  for (const row of listed) assertReadable(row)
  // The scope runs in SQL (not only as a filter on the page): totals and pages count only those rows.
  const counted = await client.getJson('/api/notes?page[size]=1&page[total]=true')
  expect((counted.json as { meta: { page: { total: number } } }).meta.page.total).toBe(
    listed.length,
  )
  for (const note of noteModels.slice(0, 4)) {
    const shown = await client.getJson(`/api/notes/${note.id}`)
    expect(shown.status).toBe(canView(note) ? 200 : 404)
    if (shown.status === 200) assertReadable((shown.json as { data: unknown }).data)
  }

  // 4. A field the user may not read can't be filtered or sorted (it would reveal its values).
  if (readable !== undefined) {
    const hiddenField = READABLE.find((field) => !readable.has(field) && field !== 'folder_id')
    if (hiddenField !== undefined) {
      ;(await client.getJson(`/api/notes?filter[${hiddenField}][eq]=1`)).assertProblem(
        422,
        'validation_failed',
      )
      ;(await client.getJson(`/api/notes?sort=${hiddenField}`)).assertProblem(
        422,
        'validation_failed',
      )
    }
  }

  // 5. An include shows only the related rows the related policy allows.
  const folder = folderModels[given.pick % folderModels.length]
  if (folder !== undefined && canViewFolder(folder)) {
    const withNotes = await client.getJson(`/api/folders/${folder.id}?include=notes`)
    withNotes.assertStatus(200)
    const included = (withNotes.json as { data: { notes: { id: number }[] } }).data.notes
    expect(included.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      noteModels
        .filter((note) => note.folder_id === folder.id && canView(note))
        .map((note) => note.id)
        .sort((a, b) => a - b),
    )
    for (const row of included) assertReadable(row)
  }

  // 2. Update: a write that leaves the caller's reach is a 403 and is rolled back.
  const visible = noteModels.filter(canView)
  const target = visible[given.pick % Math.max(1, visible.length)]
  if (target !== undefined) {
    const after = { ...rowOf(target), ...given.patch }
    const response = await client.patchJson(`/api/notes/${target.id}`, given.patch)
    const stored = await runWithConnection(connection, () => Note.findOrFail(target.id))
    if (!canUpdate(target)) {
      expect(response.status).toBe(403)
      expect(rowOf(stored)).toEqual(rowOf(target))
    } else if (canView(after) && canUpdate(after)) {
      expect(response.status).toBe(200)
      expect(rowOf(stored)).toEqual(after)
    } else {
      response.assertProblem(403, 'forbidden')
      expect(rowOf(stored)).toEqual(rowOf(target))
    }
  }

  // 2 + 3. Store: the folder must be one the caller may view; the new row must stay in reach.
  const chosen = given.create.folder === null ? undefined : folderModels[given.create.folder]
  const folderId = given.create.folder === null ? null : (chosen?.id ?? 999_999)
  const body = {
    title: 'new',
    owner_id: given.create.owner_id,
    status: given.create.status,
    team: given.create.team,
    folder_id: folderId,
  }
  const before = await runWithConnection(connection, () => Note.query().count())
  const created = await client.postJson('/api/notes', body)
  const count = await runWithConnection(connection, () => Note.query().count())
  if (folderId !== null && (chosen === undefined || !canViewFolder(chosen))) {
    created
      .assertProblem(422, 'validation_failed')
      .assertJsonPath('issues.0.path', ['folder_id'])
      .assertJsonPath('issues.0.code', 'not_found')
    expect(count).toBe(before)
  } else if (!canView({ ...body, score: null })) {
    created.assertProblem(403, 'forbidden')
    expect(count).toBe(before)
  } else {
    created.assertStatus(201)
    assertReadable((created.json as { data: unknown }).data)
    expect(count).toBe(before + 1)
  }
}

function rowOf(note: Note): Omit<NoteRow, 'title' | 'score' | 'folder_id'> {
  return { owner_id: note.owner_id, status: note.status, team: note.team as NoteRow['team'] }
}

describe.each(ENGINES)('resource access controls on $name', (engine) => {
  const title = (text: string): string =>
    engine.skipped === undefined ? text : `${text} (skipped: ${engine.skipped})`

  test.skipIf(engine.skipped !== undefined)(
    title('lists, single rows, writes, foreign keys, fields and includes follow random policies'),
    async () => {
      const root = appFolder()
      const { env, drop } = await engine.database()
      try {
        await migrate(root, env)
        const app = application(root, env)
        await app.boot()
        await fc.assert(
          fc.asyncProperty(scenario, (given) => runScenario(app, given)),
          { numRuns: engine.runs, seed: Number(process.env['STRUTVANE_TEST_SEED'] ?? Date.now()) },
        )
      } finally {
        await drop()
      }
    },
    180_000,
  )
})

describe('boot checks for resource access, on SQLite', () => {
  const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/database.sqlite' }

  test('a view() that reads the record without viewScope() stops the boot', async () => {
    const root = appFolder()
    await migrate(root, env)
    class UnscopedController extends ResourceController<typeof Note> {
      protected readonly model = Note
      protected override readonly policy: Policy<Note> = {
        viewAny: () => true,
        view: (_user, note) => note.status === 'shared',
      }
    }
    const app = application(
      root,
      env,
      defineRoutes([Route.apiResource('notes', UnscopedController)]),
    )
    await expect(app.boot()).rejects.toMatchObject({ code: 'view_scope_missing' })
  })

  test('a view() that hides its record parameter fails closed at the first list', async () => {
    const root = appFolder()
    await migrate(root, env)
    class SneakyController extends ResourceController<typeof Note> {
      protected readonly model = Note
      protected override readonly policy: Policy<Note> = {
        viewAny: () => true,
        view: (...args: unknown[]) => Reflect.get(args[1] as object, 'status') === 'shared',
      }
    }
    const app = application(root, env, defineRoutes([Route.apiResource('notes', SneakyController)]))
    await app.boot()
    const client = testClient(app)
      .withoutCsrf()
      .actingAs({
        id: '1',
        type: 'user',
        roles: [],
        attrs: {},
      } as AuthUser)
    const response = await client.getJson('/api/notes')
    response.assertProblem(500, 'internal_error')
    expect(response.text).not.toContain('shared')
    expect(response.text).not.toContain('view()')
  })

  test('a writable foreign key without a relation stops the boot', async () => {
    const root = appFolder()
    await migrate(root, env)
    class LooseController extends ResourceController<typeof LooseNote> {
      protected readonly model = LooseNote
      protected override readonly policy: Policy<LooseNote> = { viewAny: () => true }
    }
    const app = application(root, env, defineRoutes([Route.apiResource('notes', LooseController)]))
    await expect(app.boot()).rejects.toMatchObject({ code: 'unresolved_reference' })
  })
})
