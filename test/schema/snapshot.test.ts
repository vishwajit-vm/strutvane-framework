/**
 * The ORM's runtime snapshot (`.strutvane/schema.json`), the generated shapes of hidden, secret,
 * tenant and UUID-key columns, and rebuilding a replay from operations recorded elsewhere (what
 * the replay sandbox sends back).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyOperations } from '../../src/schema/apply.ts'
import {
  EMPTY_SCHEMA,
  isHiddenColumn,
  isSecretColumn,
  type SchemaState,
} from '../../src/schema/columns.ts'
import { SchemaError } from '../../src/schema/errors.ts'
import { generateMetadata } from '../../src/schema/generate/metadata.ts'
import { generateModelTypes } from '../../src/schema/generate/types.ts'
import { recordOperations, type SchemaBuilder } from '../../src/schema/migration.ts'
import { modelStub } from '../../src/schema/naming.ts'
import { replayRecorded } from '../../src/schema/replay.ts'
import { parseOperations, parseSchemaSnapshot, schemaSnapshot } from '../../src/schema/snapshot.ts'
import { BLOG_ROOT, replayApp } from './helpers.ts'

const up = (schema: SchemaBuilder): void => {
  schema.create(
    'teams',
    (t) => {
      t.uuid('id').primary()
      t.string('name')
    },
    { global: true },
  )
  schema.create('members', (t) => {
    t.id()
    t.tenant()
    t.string('email').unique()
    t.string('password').nullable()
    t.string('api_key', 64).nullable().secret()
    t.text('notes').nullable().hidden()
    t.foreignUuid('team_id').constrained('teams').cascadeOnDelete()
    t.timestamps()
  })
  schema.create(
    'jobs',
    (t) => {
      t.id()
      t.text('payload')
    },
    { internal: true },
  )
}

const state: SchemaState = applyOperations(EMPTY_SCHEMA, recordOperations(up, EMPTY_SCHEMA))

describe('schema.json', () => {
  test('round-trips through JSON exactly, flags included', () => {
    const snapshot = schemaSnapshot(state)
    expect(Object.keys(snapshot.tables)).toEqual(['teams', 'members', 'jobs'])
    const parsed = parseSchemaSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(parsed).toEqual(snapshot)
    expect(parsed.tables['teams']?.global).toBe(true)
    expect(parsed.tables['jobs']?.internal).toBe(true)
  })

  test('the committed blog snapshot parses and matches a fresh replay', async () => {
    const committed = JSON.parse(readFileSync(join(BLOG_ROOT, '.strutvane', 'schema.json'), 'utf8'))
    expect(parseSchemaSnapshot(committed)).toEqual(
      schemaSnapshot((await replayApp(BLOG_ROOT)).state),
    )
  })

  const good = (): Record<string, unknown> => JSON.parse(JSON.stringify(schemaSnapshot(state)))
  const members = (doc: Record<string, unknown>): Record<string, unknown> =>
    (doc['tables'] as Record<string, Record<string, unknown>>)['members'] ?? {}
  const set = (
    target: Record<string, unknown>,
    key: string,
    value: unknown,
    doc: Record<string, unknown>,
  ): Record<string, unknown> => {
    target[key] = value
    return doc
  }
  const firstColumn = (doc: Record<string, unknown>): Record<string, unknown> =>
    (members(doc)['columns'] as Record<string, unknown>[])[0] ?? {}

  test.each<[string, (doc: Record<string, unknown>) => unknown]>([
    ['not an object', () => 'nope'],
    ['an array', () => []],
    ['a wrong version', (doc) => ({ ...doc, version: 2 })],
    ['no tables', () => ({ version: 1 })],
    [
      'a key that differs from the name',
      (doc) => ({ version: 1, tables: { other: members(doc) } }),
    ],
    ['an unknown column kind', (doc) => set(firstColumn(doc), 'kind', 'money', doc)],
    ['a hostile identifier', (doc) => set(firstColumn(doc), 'name', 'id; DROP TABLE x', doc)],
    ['a non-boolean nullable', (doc) => set(firstColumn(doc), 'nullable', 'no', doc)],
    ['a flag that is not true', (doc) => set(firstColumn(doc), 'tenant', false, doc)],
    ['a table flag that is not true', (doc) => set(members(doc), 'global', 'yes', doc)],
    ['an object default', (doc) => set(firstColumn(doc), 'default', {}, doc)],
    ['a negative length', (doc) => set(firstColumn(doc), 'length', -1, doc)],
    ['enum values that are not text', (doc) => set(firstColumn(doc), 'values', [1], doc)],
    ['a non-text comment', (doc) => set(firstColumn(doc), 'comment', 5, doc)],
    ['columns that are not a list', (doc) => set(members(doc), 'columns', {}, doc)],
    [
      'an index without unique',
      (doc) => set(members(doc), 'indexes', [{ name: 'x', columns: [] }], doc),
    ],
    [
      'a bad referential action',
      (doc) => {
        const column = (members(doc)['columns'] as Record<string, unknown>[]).find(
          (c) => c['name'] === 'team_id',
        )
        if (column !== undefined)
          column['references'] = { table: 'teams', column: 'id', onDelete: 'explode' }
        return doc
      },
    ],
    [
      'a malformed tenant key',
      (doc) => {
        const column = (members(doc)['columns'] as Record<string, unknown>[]).find(
          (c) => c['name'] === 'team_id',
        )
        if (column !== undefined)
          column['references'] = {
            table: 'teams',
            column: 'id',
            onDelete: 'cascade',
            tenant: { column: 'tenant_id' },
          }
        return doc
      },
    ],
  ])('refuses %s', (_name, mutate) => {
    try {
      parseSchemaSnapshot(mutate(good()))
      throw new Error('expected a SchemaError')
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError)
      expect((error as SchemaError).code).toBe('INVALID_SNAPSHOT')
      expect((error as SchemaError).hint).toContain('node strut migrate')
    }
  })

  test('optional column details survive the round trip', () => {
    const rich = applyOperations(
      EMPTY_SCHEMA,
      recordOperations((schema) => {
        schema.create('things', (t) => {
          t.id()
          t.decimal('price', 10, 3).default('1.500').comment('The price')
          t.enum('state', ['a', 'b']).default('a')
          t.string('title', 80)
          t.slug('slug').from('title')
        })
      }, EMPTY_SCHEMA),
    )
    const snapshot = schemaSnapshot(rich)
    expect(parseSchemaSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })
})

describe('hidden, secret, tenant and key columns in the generated shapes', () => {
  const columns = state.tables[1]?.columns ?? []
  const byName = (name: string) => columns.find((column) => column.name === name) ?? columns[0]

  test('secret and hidden columns are recognised', () => {
    const api = byName('api_key')
    const notes = byName('notes')
    const password = byName('password')
    expect(api && isSecretColumn(api)).toBe(true)
    expect(password && isSecretColumn(password)).toBe(true)
    expect(notes && isSecretColumn(notes)).toBe(false)
    expect(notes && isHiddenColumn(notes)).toBe(true)
  })

  test('types: secrets are writable in code but never in JSON; tenant and keys are never inputs', () => {
    const dts = generateModelTypes(state)
    const block = (name: string): string =>
      dts.split(`export interface ${name} {`)[1]?.split('}')[0] ?? ''
    expect(block('NewMember')).toContain('api_key?: string | null')
    expect(block('NewMember')).toContain('password?: string | null')
    expect(block('NewMember')).not.toContain('tenant_id')
    expect(block('NewMember')).not.toMatch(/\bid\b/)
    expect(block('MemberJson')).not.toContain('api_key')
    expect(block('MemberJson')).not.toContain('notes')
    expect(block('MemberJson')).not.toContain('password')
    expect(block('MemberJson')).toContain('tenant_id: string')
    expect(block('NewTeam')).toBe('\n  name: string\n')
    expect(dts).toContain('import type { JsonValue } from "@strutvane/framework/database"')
    expect(dts).toContain('declare module "@strutvane/framework/database" {')
    expect(dts).toContain('/** What creating a member needs.')
  })

  test('metadata: internal tables have no resource, tenant and hidden columns are never queried', () => {
    const metadata = generateMetadata(state)
    expect(metadata.internal).toEqual(['jobs'])
    expect(metadata.resources.map((resource) => resource.table)).toEqual(['teams', 'members'])
    const resource = metadata.resources.find((r) => r.table === 'members')
    expect(resource?.tenant).toBe('tenant_id')
    expect(metadata.resources.find((r) => r.table === 'teams')?.global).toBe(true)
    const field = (name: string) => resource?.fields.find((f) => f.name === name)
    for (const name of ['tenant_id', 'api_key', 'notes', 'password']) {
      expect(field(name), name).toMatchObject({
        searchable: false,
        sortable: false,
        filterOperators: [],
        listed: false,
      })
    }
    expect(field('notes')).toMatchObject({ hidden: true, fillable: true })
    expect(field('api_key')).toMatchObject({ hidden: true, fillable: false, input: 'none' })
    // Unique per tenant still counts as unique for the email field.
    expect(field('email')?.unique).toBe(true)
    expect(field('team_id')?.input).toBe('relation')
    expect(resource?.perPage).toBe(25)
  })

  test('relations to and from internal tables are left out', () => {
    const withLink = applyOperations(
      state,
      recordOperations((schema) => {
        schema.create(
          'audit',
          (t) => {
            t.id()
            t.foreignId('job_id').constrained('jobs')
          },
          { internal: true },
        )
        schema.table('teams', (t) => void t.foreignId('job_id').nullable().constrained('jobs'))
      }, state),
    )
    const metadata = generateMetadata(withLink)
    expect(metadata.internal).toEqual(['jobs', 'audit'])
    expect(
      metadata.resources.find((r) => r.table === 'teams')?.relations.map((r) => r.name),
    ).toEqual(['members'])
  })

  test('at most 10 fields are searched (decision #53)', () => {
    const wide = applyOperations(
      EMPTY_SCHEMA,
      recordOperations((schema) => {
        schema.create('wide', (t) => {
          t.id()
          for (let i = 1; i <= 12; i++) t.string(`field_${i}`)
        })
      }, EMPTY_SCHEMA),
    )
    const fields = generateMetadata(wide).resources[0]?.fields ?? []
    expect(fields.filter((field) => field.searchable !== false)).toHaveLength(10)
    expect(fields.find((field) => field.name === 'field_12')?.searchable).toBe(false)
  })
})

describe('replaying recorded operations', () => {
  test('gives the same replay as recording in process, with states recomputed', () => {
    const ops = recordOperations(up, EMPTY_SCHEMA)
    const down = recordOperations((schema) => {
      schema.dropIfExists('jobs')
      schema.dropIfExists('members')
      schema.dropIfExists('teams')
    }, state)
    const replay = replayRecorded([{ name: '2026_01_01_000000_init', up: ops, down }])
    expect(replay.state).toEqual(state)
    expect(replay.migrations[0]?.before).toEqual(EMPTY_SCHEMA)
    expect(applyOperations(replay.state, replay.migrations[0]?.down ?? [])).toEqual(EMPTY_SCHEMA)
  })

  test('refuses duplicates and names the migration of a bad operation', () => {
    const ops = recordOperations(up, EMPTY_SCHEMA)
    expect(() =>
      replayRecorded([
        { name: 'a', up: ops, down: [] },
        { name: 'a', up: [], down: [] },
      ]),
    ).toThrow(/listed twice/)
    try {
      replayRecorded([
        { name: 'bad', up: [{ type: 'dropTable', table: 'ghosts', ifExists: false }], down: [] },
      ])
      throw new Error('expected a SchemaError')
    } catch (error) {
      expect((error as SchemaError).migration).toBe('bad.ts')
    }
    expect(() =>
      replayRecorded([{ name: 'x', up: [{ type: 'bogus' } as never], down: [] }]),
    ).toThrow()
  })
})

describe('operations received from the replay sandbox', () => {
  test('well-formed operations pass unchanged', () => {
    const ops = recordOperations(up, EMPTY_SCHEMA)
    const more = recordOperations((schema) => {
      schema.table('members', (t) => {
        t.renameColumn('notes', 'remarks')
        t.dropIndex('members_tenant_id_email_unique')
        t.dropColumn('password')
      })
      schema.rename('jobs', 'queue_jobs')
      schema.dropIfExists('teams')
    }, state)
    expect(parseOperations(JSON.parse(JSON.stringify(ops)), 'm')).toEqual(ops)
    expect(parseOperations(JSON.parse(JSON.stringify(more)), 'm')).toEqual(more)
  })

  test.each<[string, unknown]>([
    ['not a list', { type: 'dropTable' }],
    ['an unknown operation', [{ type: 'runSql', sql: 'DROP TABLE users' }]],
    [
      'a quote in a table name',
      [{ type: 'dropTable', table: 'x" ; DROP TABLE users; --', ifExists: true }],
    ],
    ['an upper-case name', [{ type: 'renameTable', from: 'a', to: 'Users' }]],
    ['a 64-character name', [{ type: 'dropTable', table: 'a'.repeat(64), ifExists: true }]],
    ['a missing ifExists', [{ type: 'dropTable', table: 'a' }]],
    ['an unknown table action', [{ type: 'alterTable', table: 'a', actions: [{ type: 'raw' }] }]],
    [
      'a hostile column',
      [
        {
          type: 'alterTable',
          table: 'a',
          actions: [
            { type: 'addColumn', column: { name: 'x', kind: 'string; DROP', nullable: true } },
          ],
        },
      ],
    ],
    [
      'options that are not flags',
      [{ type: 'createTable', table: 'a', actions: [], options: { global: 'yes' } }],
    ],
  ])('refuses %s, naming the migration', (_name, json) => {
    try {
      parseOperations(json, '2026_01_01_000000_evil')
      throw new Error('expected a SchemaError')
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError)
      expect((error as SchemaError).code).toBe('INVALID_MIGRATION')
      expect((error as SchemaError).migration).toBe('2026_01_01_000000_evil.ts')
    }
  })

  test('a recorded migration needs a plain name', () => {
    expect(() => replayRecorded([{ name: '../x y', up: [], down: [] }])).toThrow(SchemaError)
    expect(() => replayRecorded([{ name: 1 as never, up: [], down: [] }])).toThrow(SchemaError)
  })

  test('create options survive a round trip', () => {
    const created = [{ type: 'createTable', table: 'a', actions: [], options: { internal: true } }]
    expect(parseOperations(created, 'm')).toEqual(created)
  })
})

describe('make:migration model stub', () => {
  test('a model with an empty fillable list, importing the ORM entry', () => {
    const stub = modelStub('blog_posts')
    expect(stub).toContain("import { Model } from '@strutvane/framework/database'")
    expect(stub).toContain("export class BlogPost extends Model('blog_posts', {")
    expect(stub).toContain('  fillable: [],')
    expect(stub).not.toMatch(/\bsv\b/)
  })
})
