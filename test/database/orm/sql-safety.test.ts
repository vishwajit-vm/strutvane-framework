/**
 * "No SQL injection by construction", held against app code that tries hard: no way to make a
 * fragment from a string (not the constructor, not a hand-built template object), fragments can't
 * be changed after they are made, identifiers are checked again where they become text, request
 * inputs are bounded, and table names can't reach an object's prototype.
 */
import { describe, expect, test } from 'vitest'
import { configureOrm, OrmUsageError, SqlFragment, sql } from '../../../src/database/index.ts'
import { hasTable, registerSchema, tableInfo } from '../../../src/database/schema/registry.ts'
import { trustedSql } from '../../../src/database/sql/fragment.ts'
import { postgresGrammar } from '../../../src/database/sql/grammar.ts'
import { assertIdentifier, SchemaError } from '../../../src/schema/errors.ts'
import { User } from './fixtures/app/models/user.ts'
import { snapshot } from './fixtures/schema.ts'

describe('fragments', () => {
  test('the constructor refuses anyone without the module token', () => {
    const Construct = SqlFragment as unknown as new (token: symbol, parts: unknown[]) => unknown
    expect(
      () => new Construct(Symbol('strutvane.sql.trusted'), [{ kind: 'text', text: 'x' }]),
    ).toThrow(OrmUsageError)
    expect(Reflect.get(SqlFragment, 'trusted')).toBeUndefined()
  })

  test.each([
    ['a plain array', () => Reflect.apply(sql, undefined, [['DROP TABLE users']])],
    [
      'a frozen array with an empty raw',
      () =>
        Reflect.apply(sql, undefined, [
          Object.freeze(Object.assign(['DROP TABLE users'], { raw: Object.freeze([]) })),
        ]),
    ],
    [
      'a frozen array with a mutable raw',
      () =>
        Reflect.apply(sql, undefined, [
          Object.freeze(Object.assign(['DROP TABLE users'], { raw: ['DROP TABLE users'] })),
        ]),
    ],
  ])('the sql tag refuses %s', (_what, call) => {
    expect(call).toThrow(/tagged template/)
  })

  test('parts are frozen: nothing can be pushed into a fragment later', () => {
    const fragment = sql`title = ${'x'}`
    expect(Object.isFrozen(fragment.parts)).toBe(true)
    expect(() => (fragment.parts as unknown[]).push({ kind: 'text', text: '; DROP' })).toThrow()
    const first = fragment.parts[0]
    expect(first !== undefined && Object.isFrozen(first)).toBe(true)
  })

  test('an identifier is checked again where it becomes text', () => {
    expect(() =>
      postgresGrammar.render(
        trustedSql([{ kind: 'identifier', name: 'users" ; DROP TABLE x; --' }]),
      ),
    ).toThrow(/not a valid table or column name/)
    expect(postgresGrammar.render(sql`SELECT ${sql.id('title')}`).sql).toBe('SELECT "title"')
  })
})

describe('request inputs are bounded', () => {
  test('contains / startsWith / search text and sort terms', () => {
    configureOrm({})
    registerSchema(snapshot)
    const long = 'x'.repeat(201)
    for (const attempt of [
      () => User.query().filter('name', 'contains', long),
      () => User.query().filter('name', 'startsWith', long),
      () => User.query().whereContains('name', long),
      () => User.query().search(long, ['name']),
    ])
      expect(attempt).toThrow(expect.objectContaining({ code: 'search_too_long' }))
    expect(() => User.query().sort(Array.from({ length: 9 }, () => 'name').join(','))).toThrow(
      expect.objectContaining({ code: 'sort_too_long' }),
    )
    expect(() => User.query().sort('name,-email')).not.toThrow()
  })
})

describe('table names never reach a prototype', () => {
  test('__proto__ is not a valid name; lookups only see the snapshot own tables', () => {
    expect(() => assertIdentifier('__proto__', 'table')).toThrow(SchemaError)
    registerSchema(snapshot)
    expect(hasTable('constructor')).toBe(false)
    expect(hasTable('toString')).toBe(false)
    expect(hasTable('users')).toBe(true)
    expect(() => tableInfo('constructor')).toThrow(/not in the schema snapshot/)
  })
})
