/**
 * The tenancy rules the recorder applies (security review F-04/F-05, decisions #92 and #93), the
 * SQL they compile to on every engine, and (on SQLite and PGlite, for real) proof that a row can
 * never point at another tenant's parent.
 */
import { DatabaseSync } from 'node:sqlite'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyOperations } from '../../src/schema/apply.ts'
import {
  EMPTY_SCHEMA,
  findColumn,
  findTable,
  primaryKeyOf,
  type SchemaState,
  tenantColumnOf,
} from '../../src/schema/columns.ts'
import { compileOperations, createSchemaSql } from '../../src/schema/ddl/ddl.ts'
import type { Dialect } from '../../src/schema/ddl/dialect.ts'
import { SchemaError } from '../../src/schema/errors.ts'
import { recordOperations, type SchemaBuilder } from '../../src/schema/migration.ts'

function run(state: SchemaState, up: (schema: SchemaBuilder) => void): SchemaState {
  return applyOperations(state, recordOperations(up, state))
}

function failure(state: SchemaState, up: (schema: SchemaBuilder) => void): SchemaError {
  try {
    run(state, up)
  } catch (error) {
    if (error instanceof SchemaError) return error
    throw error
  }
  throw new Error('Expected a SchemaError')
}

/** A small multi-tenant app: a global lookup table, tenant tables, a self-reference, a pivot. */
const app = (schema: SchemaBuilder): void => {
  schema.create(
    'countries',
    (t) => {
      t.id()
      t.string('name').unique()
    },
    { global: true },
  )
  schema.create('projects', (t) => {
    t.uuid('id').primary()
    t.tenant()
    t.string('name')
    t.slug('slug').from('name')
    t.foreignId('country_id').nullable().constrained('countries').nullOnDelete()
  })
  schema.create('tasks', (t) => {
    t.id()
    t.foreignUuid('project_id').constrained('projects').cascadeOnDelete()
    t.foreignId('parent_id').nullable().constrained('tasks').cascadeOnDelete()
    t.string('title')
    t.tenant()
  })
  schema.create('labels', (t) => {
    t.id()
    t.tenant()
    t.string('name').unique()
  })
  schema.create('label_task', (t) => {
    t.tenant()
    t.foreignId('task_id').constrained('tasks').cascadeOnDelete()
    t.foreignId('label_id').constrained('labels').cascadeOnDelete()
    t.unique(['task_id', 'label_id'])
  })
  schema.create(
    'sessions',
    (t) => {
      t.string('key', 64).unique()
      t.text('payload')
    },
    { internal: true },
  )
}

const state = run(EMPTY_SCHEMA, app)
const table = (name: string) => {
  const found = findTable(state, name)
  if (found === undefined) throw new Error(name)
  return found
}

describe('the recorder applies the tenancy rules', () => {
  test('create options and markers land in the state', () => {
    expect(table('countries').global).toBe(true)
    expect(table('sessions').internal).toBe(true)
    expect(table('projects').global).toBeUndefined()
    expect(tenantColumnOf(table('projects'))?.name).toBe('tenant_id')
    expect(primaryKeyOf(table('projects'))).toMatchObject({
      name: 'id',
      kind: 'uuid',
      primary: true,
    })
    expect(findColumn(table('projects'), 'tenant_id')).toEqual({
      name: 'tenant_id',
      kind: 'uuid',
      nullable: false,
      tenant: true,
    })
  })

  test('unique means unique per tenant, and tenant tables get a (tenant, id) key', () => {
    expect(table('projects').indexes).toEqual([
      { name: 'projects_tenant_id_slug_unique', columns: ['tenant_id', 'slug'], unique: true },
      { name: 'projects_tenant_id_id_unique', columns: ['tenant_id', 'id'], unique: true },
    ])
    expect(table('labels').indexes.map((index) => index.columns)).toEqual([
      ['tenant_id', 'name'],
      ['tenant_id', 'id'],
    ])
    // A pivot without an id gets no (tenant, id) key; its composite unique is per tenant too.
    expect(table('label_task').indexes).toEqual([
      {
        name: 'label_task_tenant_id_task_id_label_id_unique',
        columns: ['tenant_id', 'task_id', 'label_id'],
        unique: true,
      },
    ])
    // Global tables are untouched.
    expect(table('countries').indexes).toEqual([
      { name: 'countries_name_unique', columns: ['name'], unique: true },
    ])
  })

  test('a custom unique index name is kept', () => {
    const custom = run(state, (schema) =>
      schema.table('labels', (t) => {
        t.string('code', 20).nullable()
        t.unique('code', 'labels_code_per_tenant')
      }),
    )
    expect(findTable(custom, 'labels')?.indexes.at(-1)).toEqual({
      name: 'labels_code_per_tenant',
      columns: ['tenant_id', 'code'],
      unique: true,
    })
  })

  test('keys between tenant tables are composite; a key to a global table is not', () => {
    expect(findColumn(table('tasks'), 'project_id')?.references).toEqual({
      table: 'projects',
      column: 'id',
      onDelete: 'cascade',
      name: 'tasks_project_id_foreign',
      tenant: { column: 'tenant_id', parentColumn: 'tenant_id' },
    })
    // Self-reference: the table's own (tenant, id) key, declared before t.tenant() even.
    expect(findColumn(table('tasks'), 'parent_id')?.references?.tenant).toEqual({
      column: 'tenant_id',
      parentColumn: 'tenant_id',
    })
    expect(findColumn(table('projects'), 'country_id')?.references?.tenant).toBeUndefined()
  })

  test('the operations themselves carry the rules, so replay and SQL agree', () => {
    const ops = recordOperations(app, EMPTY_SCHEMA)
    const create = ops.find((op) => op.type === 'createTable' && op.table === 'countries')
    expect(create).toMatchObject({ options: { global: true } })
    const projects = ops.find((op) => op.type === 'createTable' && op.table === 'projects')
    expect(JSON.stringify(projects)).toContain('projects_tenant_id_id_unique')
  })

  test('a tenant column with a team name works the same', () => {
    const teams = run(EMPTY_SCHEMA, (schema) => {
      schema.create('boards', (t) => {
        t.id()
        t.tenant('team_id')
        t.string('title').unique()
      })
    })
    expect(findTable(teams, 'boards')?.indexes.map((index) => index.name)).toEqual([
      'boards_team_id_title_unique',
      'boards_team_id_id_unique',
    ])
  })

  test.each([
    [
      'a global table with a tenant column',
      (schema: SchemaBuilder) =>
        schema.create(
          'x',
          (t) => {
            t.id()
            t.tenant()
          },
          { global: true },
        ),
    ],
    [
      'two tenant columns',
      (schema: SchemaBuilder) =>
        schema.create('x', (t) => {
          t.tenant()
          t.tenant('team_id')
        }),
    ],
    [
      'a nullable tenant column',
      (schema: SchemaBuilder) => schema.create('x', (t) => void t.tenant().nullable()),
    ],
    [
      'nullOnDelete between tenant tables',
      (schema: SchemaBuilder) =>
        schema.create('notes', (t) => {
          t.tenant()
          t.foreignUuid('project_id').nullable().constrained('projects').nullOnDelete()
        }),
    ],
    [
      'dropping the tenant column a key relies on',
      (schema: SchemaBuilder) => schema.table('tasks', (t) => t.dropColumn('tenant_id')),
    ],
    [
      "dropping the parent's (tenant, id) key",
      (schema: SchemaBuilder) =>
        schema.table('projects', (t) => t.dropIndex('projects_tenant_id_id_unique')),
    ],
    [
      'dropping the parent tenant column children key on',
      (schema: SchemaBuilder) => schema.table('labels', (t) => t.dropColumn('tenant_id')),
    ],
  ])('refuses %s', (_name, up) => {
    const error = failure(state, up)
    expect(['INVALID_TENANCY', 'INVALID_FOREIGN_KEY']).toContain(error.code)
    expect(error.hint).not.toBe('')
  })

  test('unknown or malformed create options are refused', () => {
    expect(
      failure(EMPTY_SCHEMA, (schema) =>
        schema.create('x', (t) => void t.id(), { shared: true } as never),
      ).code,
    ).toBe('INVALID_MIGRATION')
    expect(
      failure(EMPTY_SCHEMA, (schema) => schema.create('x', (t) => void t.id(), 'global' as never))
        .code,
    ).toBe('INVALID_MIGRATION')
    const plain = recordOperations(
      (schema) => schema.create('x', (t) => void t.id(), {}),
      EMPTY_SCHEMA,
    )
    expect(plain[0]).not.toHaveProperty('options')
  })

  test('a key must match the parent key type (foreignId vs foreignUuid)', () => {
    const wrong = failure(state, (schema) =>
      schema.create('notes', (t) => {
        t.tenant()
        t.foreignId('project_id').constrained('projects')
      }),
    )
    expect(wrong.code).toBe('INVALID_FOREIGN_KEY')
    expect(wrong.hint).toContain("t.foreignUuid('project_id')")
    expect(
      failure(state, (schema) =>
        schema.create('notes', (t) => void t.foreignUuid('country_id').constrained('countries')),
      ).hint,
    ).toContain("t.foreignId('country_id')")
  })

  test('a uuid primary key or a second key cannot be added later, and is never nullable', () => {
    expect(
      failure(state, (schema) =>
        schema.table('countries', (t) => void t.uuid('code').primary().nullable()),
      ).code,
    ).toBe('INVALID_COLUMN')
    expect(
      failure(EMPTY_SCHEMA, (schema) =>
        schema.create('x', (t) => void t.uuid('id').primary().nullable()),
      ).code,
    ).toBe('INVALID_COLUMN')
    expect(
      failure(EMPTY_SCHEMA, (schema) =>
        schema.create('x', (t) => {
          t.id()
          t.uuid('uuid').primary()
        }),
      ).code,
    ).toBe('INVALID_COLUMN')
  })

  test('renaming a tenant column keeps composite keys pointing at it', () => {
    const renamed = run(state, (schema) => {
      schema.table('tasks', (t) => t.renameColumn('tenant_id', 'team_id'))
      schema.table('projects', (t) => t.renameColumn('tenant_id', 'org_id'))
    })
    expect(
      findColumn(findTable(renamed, 'tasks') ?? table('tasks'), 'project_id')?.references?.tenant,
    ).toEqual({
      column: 'team_id',
      parentColumn: 'org_id',
    })
  })

  test('hidden and secret columns are recorded', () => {
    const users = run(EMPTY_SCHEMA, (schema) =>
      schema.create('users', (t) => {
        t.id()
        t.string('api_key').secret()
        t.text('notes').nullable().hidden()
      }),
    )
    const found = findTable(users, 'users')
    expect(found && findColumn(found, 'api_key')).toMatchObject({ secret: true, hidden: true })
    expect(found && findColumn(found, 'notes')).toMatchObject({ hidden: true })
  })
})

describe('composite keys compile on every engine', () => {
  test.each(['sqlite', 'postgres', 'mysql', 'mariadb'] as const)('%s', (dialect: Dialect) => {
    const sql = createSchemaSql(state, dialect).join(';\n')
    const q = (name: string): string =>
      dialect === 'mysql' || dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`
    const key = `CONSTRAINT ${q('tasks_project_id_foreign')} FOREIGN KEY (${q('tenant_id')}, ${q('project_id')}) REFERENCES ${q('projects')} (${q('tenant_id')}, ${q('id')}) ON DELETE CASCADE`
    expect(sql).toContain(key)
    if (dialect === 'sqlite') {
      // Inside CREATE TABLE: SQLite can't add a constraint to an existing table.
      expect(sql).not.toContain(`ALTER TABLE ${q('tasks')} ADD CONSTRAINT`)
    } else {
      // After the indexes, so the parent's (tenant, id) key exists, even for a self-reference.
      expect(sql).toContain(`ALTER TABLE ${q('tasks')} ADD ${key}`)
      expect(
        sql.indexOf(`ALTER TABLE ${q('tasks')} ADD CONSTRAINT ${q('tasks_parent_id_foreign')}`),
      ).toBeGreaterThan(sql.indexOf(q('tasks_tenant_id_id_unique')))
    }
    // The plain key to the global table stays a plain key.
    expect(sql).toMatch(
      dialect === 'mysql' || dialect === 'mariadb'
        ? /FOREIGN KEY \(`country_id`\) REFERENCES `countries` \(`id`\)/
        : /"country_id" BIGINT NULL REFERENCES "countries" \("id"\)|"country_id" INTEGER NULL REFERENCES "countries" \("id"\)/,
    )
    // A UUID primary key.
    expect(sql).toMatch(
      new RegExp(
        `${q('id').replace(/[`"]/g, '.')} (UUID|VARCHAR\\(36\\)|CHAR\\(36\\) COLLATE utf8mb4_(0900|nopad)_bin) NOT NULL PRIMARY KEY`,
      ),
    )
  })
})

/** The engines the composite keys are checked on for real. */
interface Engine {
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

const A = '0190a000-0000-7000-8000-00000000000a'
const B = '0190a000-0000-7000-8000-00000000000b'
const P = '0190a000-0000-7000-8000-0000000000aa'

const engines: readonly [string, Dialect, () => Promise<Engine>][] = [
  [
    'SQLite (node:sqlite)',
    'sqlite',
    async () => {
      const db = new DatabaseSync(':memory:')
      db.exec('PRAGMA foreign_keys = ON')
      return {
        exec: async (sql) => void db.exec(sql),
        close: async () => db.close(),
      }
    },
  ],
  [
    'PostgreSQL (PGlite)',
    'postgres',
    async () => {
      const db = await PGlite.create()
      return {
        exec: async (sql) => void (await db.exec(sql)),
        close: () => db.close(),
      }
    },
  ],
]

describe.each(engines)('on %s, a row can never point at another tenant', (_name, dialect, open) => {
  let db: Engine
  beforeAll(async () => {
    db = await open()
    for (const statement of compileOperations(
      EMPTY_SCHEMA,
      recordOperations(app, EMPTY_SCHEMA),
      dialect,
    )) {
      await db.exec(statement)
    }
    await db.exec(
      `INSERT INTO "projects" ("id", "tenant_id", "name", "slug") VALUES ('${P}', '${A}', 'Apollo', 'apollo')`,
    )
  })
  afterAll(() => db.close())

  test("the same tenant's parent is accepted", async () => {
    await db.exec(
      `INSERT INTO "tasks" ("id", "project_id", "title", "tenant_id") VALUES (1, '${P}', 'Launch', '${A}')`,
    )
  })

  test("another tenant's parent is refused by the database", async () => {
    await expect(
      db.exec(
        `INSERT INTO "tasks" ("id", "project_id", "title", "tenant_id") VALUES (2, '${P}', 'Steal', '${B}')`,
      ),
    ).rejects.toThrow(/foreign key/i)
    await expect(
      db.exec(
        `INSERT INTO "tasks" ("id", "project_id", "parent_id", "title", "tenant_id") VALUES (3, '${P}', 1, 'Child', '${B}')`,
      ),
    ).rejects.toThrow(/foreign key/i)
  })

  test('a slug may repeat across tenants, never within one', async () => {
    await db.exec(
      `INSERT INTO "projects" ("id", "tenant_id", "name", "slug") VALUES ('0190a000-0000-7000-8000-0000000000bb', '${B}', 'Apollo', 'apollo')`,
    )
    await expect(
      db.exec(
        `INSERT INTO "projects" ("id", "tenant_id", "name", "slug") VALUES ('0190a000-0000-7000-8000-0000000000cc', '${A}', 'Apollo', 'apollo')`,
      ),
    ).rejects.toThrow(/unique|duplicate/i)
  })

  test('a rebuild is refused on SQLite while other tables point at the table', () => {
    const add = (schema: SchemaBuilder): void =>
      schema.table(
        'labels',
        (t) => void t.foreignUuid('project_id').nullable().constrained('projects'),
      )
    const compiled = () => compileOperations(state, recordOperations(add, state), dialect)
    if (dialect === 'sqlite') expect(compiled).toThrow(SchemaError)
    else expect(compiled()).toHaveLength(2)
  })

  test('adding a composite key later and rolling it back works (SQLite rebuilds the table)', async () => {
    const notes = (schema: SchemaBuilder): void =>
      schema.create('notes', (t) => {
        t.id()
        t.tenant()
        t.string('body')
      })
    const base = run(EMPTY_SCHEMA, app)
    for (const statement of compileOperations(base, recordOperations(notes, base), dialect))
      await db.exec(statement)
    const before = run(base, notes)
    const add = (schema: SchemaBuilder): void =>
      schema.table('notes', (t) => {
        t.foreignUuid('project_id').nullable().constrained('projects').cascadeOnDelete()
      })
    const after = run(before, add)
    for (const statement of compileOperations(before, recordOperations(add, before), dialect))
      await db.exec(statement)
    await db.exec(
      `INSERT INTO "notes" ("id", "tenant_id", "body", "project_id") VALUES (1, '${A}', 'hi', '${P}')`,
    )
    await expect(
      db.exec(
        `INSERT INTO "notes" ("id", "tenant_id", "body", "project_id") VALUES (2, '${B}', 'hi', '${P}')`,
      ),
    ).rejects.toThrow(/foreign key/i)
    const drop = (schema: SchemaBuilder): void =>
      schema.table('notes', (t) => t.dropColumn('project_id'))
    for (const statement of compileOperations(after, recordOperations(drop, after), dialect))
      await db.exec(statement)
    await db.exec(`INSERT INTO "notes" ("id", "tenant_id", "body") VALUES (3, '${B}', 'hi')`)
  })
})
