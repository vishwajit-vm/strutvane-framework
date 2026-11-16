/**
 * The in-memory recorder: Blueprint + schema builder + fold. Every mistake is caught offline with
 * a stable code and a friendly hint, before any SQL runs.
 */
import { describe, expect, test } from 'vitest'
import { applyOperations } from '../../src/schema/apply.ts'
import { EMPTY_SCHEMA, findColumn, findTable, type SchemaState } from '../../src/schema/columns.ts'
import { SchemaError } from '../../src/schema/errors.ts'
import { recordOperations, type SchemaBuilder } from '../../src/schema/migration.ts'

/** Record and apply one `up()` body against a state. */
function run(state: SchemaState, up: (schema: SchemaBuilder) => void): SchemaState {
  return applyOperations(state, recordOperations(up, state))
}

/** A schema with `users` and `posts`, the starting point for most cases. */
function baseSchema(): SchemaState {
  return run(EMPTY_SCHEMA, (schema) => {
    schema.create('users', (t) => {
      t.id()
      t.string('name')
    })
    schema.create('posts', (t) => {
      t.id()
      t.string('title', 200)
      t.slug('slug').from('title')
      t.text('body').nullable()
      t.foreignId('author_id').constrained('users')
    })
  })
}

/** Assert that `work` throws a SchemaError with this code, and that it explains how to fix it. */
function expectSchemaError(work: () => unknown, code: SchemaError['code']): SchemaError {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError)
    const schemaError = error as SchemaError
    expect(schemaError.code).toBe(code)
    expect(schemaError.hint.length).toBeGreaterThan(10)
    return schemaError
  }
  throw new Error(`Expected a SchemaError with code ${code}, but nothing was thrown.`)
}

describe('create', () => {
  test('records columns with their modifiers, and slugs get a unique index', () => {
    const state = baseSchema()
    const posts = findTable(state, 'posts')
    expect(posts?.columns.map((column) => column.name)).toEqual([
      'id',
      'title',
      'slug',
      'body',
      'author_id',
    ])
    expect(posts === undefined ? undefined : findColumn(posts, 'title')).toEqual({
      name: 'title',
      kind: 'string',
      nullable: false,
      length: 200,
    })
    expect(posts === undefined ? undefined : findColumn(posts, 'author_id')?.references).toEqual({
      table: 'users',
      column: 'id',
      onDelete: 'no action',
      name: 'posts_author_id_foreign',
    })
    expect(posts?.indexes).toEqual([{ name: 'posts_slug_unique', columns: ['slug'], unique: true }])
  })

  test('constrained() without a table guesses it from the column name, Laravel-style', () => {
    const state = run(baseSchema(), (schema) => {
      schema.create('categories', (t) => {
        t.id()
      })
      schema.table('posts', (t) => {
        t.foreignId('category_id').nullable().constrained().nullOnDelete()
      })
    })
    const posts = findTable(state, 'posts')
    expect(posts === undefined ? undefined : findColumn(posts, 'category_id')?.references).toEqual({
      table: 'categories',
      column: 'id',
      onDelete: 'set null',
      name: 'posts_category_id_foreign',
    })
  })

  test('a self-referencing key works inside create', () => {
    const state = run(EMPTY_SCHEMA, (schema) => {
      schema.create('comments', (t) => {
        t.id()
        t.foreignId('parent_id').nullable().constrained('comments').cascadeOnDelete()
      })
    })
    expect(findTable(state, 'comments')?.columns).toHaveLength(2)
  })

  test.each([
    [
      'a duplicate table',
      (schema: SchemaBuilder) => schema.create('posts', (t) => t.id()),
      'table_exists',
    ],
    [
      'a duplicate column',
      (schema: SchemaBuilder) =>
        schema.create('tags', (t) => {
          t.string('name')
          t.text('name')
        }),
      'column_exists',
    ],
    [
      'two primary keys',
      (schema: SchemaBuilder) =>
        schema.create('tags', (t) => {
          t.id()
          t.id('other_id')
        }),
      'invalid_column',
    ],
    [
      'a rename inside create',
      (schema: SchemaBuilder) =>
        schema.create('tags', (t) => {
          t.string('a')
          t.renameColumn('a', 'b')
        }),
      'not_allowed_in_create',
    ],
    [
      'an unsafe table name',
      (schema: SchemaBuilder) => schema.create('Posts; DROP TABLE users', (t) => t.id()),
      'invalid_identifier',
    ],
    [
      'an unsafe column name',
      (schema: SchemaBuilder) => schema.create('tags', (t) => t.string('Name')),
      'invalid_identifier',
    ],
    [
      'a 64-character name',
      (schema: SchemaBuilder) => schema.create('t'.repeat(64), (t) => t.id()),
      'invalid_identifier',
    ],
    [
      'a key to a missing table',
      (schema: SchemaBuilder) => schema.create('tags', (t) => t.foreignId('team_id').constrained()),
      'invalid_foreign_key',
    ],
    [
      'nullOnDelete on a required column',
      (schema: SchemaBuilder) =>
        schema.create('tags', (t) => t.foreignId('user_id').constrained().nullOnDelete()),
      'invalid_foreign_key',
    ],
    [
      'an on-delete rule without constrained()',
      (schema: SchemaBuilder) =>
        schema.create('tags', (t) => t.foreignId('user_id').cascadeOnDelete()),
      'invalid_foreign_key',
    ],
    [
      'a slug built from a missing column',
      (schema: SchemaBuilder) => schema.create('tags', (t) => t.slug('slug').from('name')),
      'invalid_slug_source',
    ],
    [
      'an enum default off the list',
      (schema: SchemaBuilder) =>
        schema.create('tags', (t) => t.enum('kind', ['a', 'b']).default('c' as 'a')),
      'invalid_default',
    ],
    [
      'a null default on a required column',
      (schema: SchemaBuilder) => schema.create('tags', (t) => t.string('name').default(null)),
      'invalid_default',
    ],
    [
      'a decimal scale bigger than its precision',
      (schema: SchemaBuilder) => schema.create('tags', (t) => t.decimal('price', 4, 6)),
      'invalid_column',
    ],
    [
      'a zero string length',
      (schema: SchemaBuilder) => schema.create('tags', (t) => t.string('name', 0)),
      'invalid_column',
    ],
    [
      'an enum with a repeated value',
      (schema: SchemaBuilder) => schema.create('tags', (t) => t.enum('kind', ['a', 'a'])),
      'invalid_column',
    ],
  ] as const)('refuses %s', (_, up, code) => {
    expectSchemaError(() => run(baseSchema(), up), code)
  })

  test('JavaScript migrations (no type checks) still get runtime default checks', () => {
    // A boolean default written as text is a compile error in TS; in plain JS this is the safety net.
    const sneaky = (schema: SchemaBuilder): void =>
      schema.create('tags', (t) => t.boolean('active').default('yes' as unknown as boolean))
    const error = expectSchemaError(() => run(baseSchema(), sneaky), 'invalid_default')
    expect(error.message).toContain('boolean')
  })
})

describe('alter (schema.table)', () => {
  test('rename follows indexes, slug sources and foreign keys in other tables', () => {
    const state = run(baseSchema(), (schema) => {
      schema.table('posts', (t) => t.renameColumn('title', 'headline'))
      schema.table('users', (t) => t.renameColumn('id', 'user_id'))
    })
    const posts = findTable(state, 'posts')
    expect(posts === undefined ? undefined : findColumn(posts, 'slug')?.slugFrom).toBe('headline')
    expect(
      posts === undefined ? undefined : findColumn(posts, 'author_id')?.references?.column,
    ).toBe('user_id')
  })

  test('dropping a column also drops the indexes that cover it', () => {
    const state = run(baseSchema(), (schema) => {
      schema.table('posts', (t) => {
        t.string('code').nullable()
        t.index(['code', 'title'])
        t.dropColumn('code')
      })
    })
    expect(findTable(state, 'posts')?.indexes.map((index) => index.name)).toEqual([
      'posts_slug_unique',
    ])
  })

  test('hasTable / hasColumn answer from the recorded history, so defensive migrations replay correctly', () => {
    const seen: boolean[] = []
    run(baseSchema(), (schema) => {
      seen.push(
        schema.hasTable('posts'),
        schema.hasTable('tags'),
        schema.hasColumn('posts', 'body'),
      )
      schema.table('posts', (t) => t.renameColumn('body', 'content'))
      seen.push(schema.hasColumn('posts', 'body'), schema.hasColumn('posts', 'content'))
    })
    expect(seen).toEqual([true, false, true, false, true])
  })

  test.each([
    [
      'a missing table',
      (schema: SchemaBuilder) => schema.table('post', (t) => t.string('x').nullable()),
      'unknown_table',
    ],
    [
      'renaming a missing column',
      (schema: SchemaBuilder) => schema.table('posts', (t) => t.renameColumn('nope', 'x')),
      'unknown_column',
    ],
    [
      'renaming onto an existing column',
      (schema: SchemaBuilder) => schema.table('posts', (t) => t.renameColumn('title', 'body')),
      'column_exists',
    ],
    [
      'dropping a missing column',
      (schema: SchemaBuilder) => schema.table('posts', (t) => t.dropColumn('nope')),
      'unknown_column',
    ],
    [
      "dropping a slug's source",
      (schema: SchemaBuilder) => schema.table('posts', (t) => t.dropColumn('title')),
      'invalid_slug_source',
    ],
    [
      'dropping a referenced column',
      (schema: SchemaBuilder) => schema.table('users', (t) => t.dropColumn('id')),
      'invalid_foreign_key',
    ],
    [
      'adding a required column with no default',
      (schema: SchemaBuilder) => schema.table('posts', (t) => t.string('subtitle')),
      'invalid_column',
    ],
    [
      'adding a primary key later',
      (schema: SchemaBuilder) => schema.table('users', (t) => t.id('other_id')),
      'invalid_column',
    ],
    [
      'an index on a missing column',
      (schema: SchemaBuilder) => schema.table('posts', (t) => t.index('nope')),
      'unknown_column',
    ],
    [
      'a duplicate index name',
      (schema: SchemaBuilder) =>
        schema.table('users', (t) => t.unique('name', 'posts_slug_unique')),
      'index_exists',
    ],
    [
      'dropping a missing index',
      (schema: SchemaBuilder) => schema.table('posts', (t) => t.dropIndex('posts_title_index')),
      'unknown_index',
    ],
  ] as const)('refuses %s', (_, up, code) => {
    expectSchemaError(() => run(baseSchema(), up), code)
  })

  test('the error lists what does exist, so the fix is obvious', () => {
    const error = expectSchemaError(
      () => run(baseSchema(), (schema) => schema.table('posts', (t) => t.dropColumn('titel'))),
      'unknown_column',
    )
    expect(error.hint).toContain('title')
  })
})

describe('drop and rename tables', () => {
  test('rename carries foreign keys along; dropIfExists tolerates a missing table', () => {
    const state = run(baseSchema(), (schema) => {
      schema.rename('users', 'members')
      schema.dropIfExists('never_existed')
    })
    const posts = findTable(state, 'posts')
    expect(
      posts === undefined ? undefined : findColumn(posts, 'author_id')?.references?.table,
    ).toBe('members')
  })

  test.each([
    ['dropping a missing table', (schema: SchemaBuilder) => schema.drop('tags'), 'unknown_table'],
    [
      'dropping a parent while children point at it',
      (schema: SchemaBuilder) => schema.drop('users'),
      'invalid_foreign_key',
    ],
    [
      'renaming onto an existing table',
      (schema: SchemaBuilder) => schema.rename('users', 'posts'),
      'table_exists',
    ],
    [
      'renaming to an unsafe name',
      (schema: SchemaBuilder) => schema.rename('users', 'Users'),
      'invalid_identifier',
    ],
  ] as const)('refuses %s', (_, up, code) => {
    expectSchemaError(() => run(baseSchema(), up), code)
  })

  test('the input state is never mutated (every intermediate state stays valid)', () => {
    const before = baseSchema()
    const snapshot = JSON.stringify(before)
    run(before, (schema) => {
      schema.table('posts', (t) => t.renameColumn('body', 'content'))
      schema.drop('posts')
    })
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('async migrations are refused, not half-recorded', () => {
  test('an async up() or create() callback fails with a clear error instead of dropping the operations after its first await', async () => {
    // Before the fix, everything after the first await was silently lost: the types, metadata and
    // SQL described a different schema from the one migrate would build.
    const asyncUp = async (schema: SchemaBuilder): Promise<void> => {
      schema.create('a', (t) => t.id())
      await Promise.resolve()
      schema.create('b', (t) => t.id())
    }
    let pending: Promise<void> | undefined
    const thrown = (() => {
      try {
        recordOperations((schema) => {
          pending = asyncUp(schema)
          return pending as unknown as undefined
        }, EMPTY_SCHEMA)
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(thrown).toBeInstanceOf(SchemaError)
    expect((thrown as SchemaError).code).toBe('async_migration')
    // The part after the await runs later, on a sealed recorder: it fails instead of recording nothing.
    await expect(pending).rejects.toBeInstanceOf(SchemaError)
    const asyncDefine = async (t: {
      id(): unknown
      string(name: string): unknown
    }): Promise<void> => {
      t.id()
      await Promise.resolve()
      t.string('late')
    }
    expect(() =>
      recordOperations(
        (schema) => schema.create('c', (t) => asyncDefine(t) as unknown as undefined),
        EMPTY_SCHEMA,
      ),
    ).toThrow(/ASYNC_MIGRATION|synchronous/)
    // Late calls on a recorder that already returned fail loudly too.
    let kept: SchemaBuilder | undefined
    recordOperations((schema) => {
      kept = schema
    }, EMPTY_SCHEMA)
    expect(() => kept?.create('late', (t) => t.id())).toThrow(SchemaError)
  })
})
