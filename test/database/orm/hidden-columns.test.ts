/**
 * Hidden and secret columns, decided by the **migration** (security review: the ORM must honour
 * `.hidden()`, `.secret()` and secret-looking names, not only the model's own `hidden` list).
 *
 * Every column of each kind goes through every path that could leak it: `toJSON()`, nested JSON,
 * `util.inspect`, request filters/sorts/searches, page cursors, "did you mean" hints and mass
 * assignment. The `User` fixture model lists no `hidden` of its own, so all of this comes from the
 * schema alone. Runs on every engine.
 */
import { inspect } from 'node:util'
import { describe, expect, test } from 'vitest'
import { Model, OrmUsageError } from '../../../src/database/index.ts'
import { isSensitiveColumn } from '../../../src/schema/columns.ts'
import { Post } from './fixtures/app/models/post.ts'
import { User } from './fixtures/app/models/user.ts'
import { engines, engineTitle, useEngine } from './support/engines.ts'
import { makePost, makeUser } from './support/seed.ts'

/** One column of each kind the migration can hide. */
const HIDDEN: readonly (readonly [string, string])[] = [
  ['password', 'a secret by name'],
  ['api_token', 'a secret by name (*_token)'],
  ['backup_phrase', '.secret()'],
  ['internal_note', '.hidden()'],
]

/** The error a request gets for a column that doesn't exist at all. */
function missingColumnCode(): string {
  try {
    User.query().filter('nowhere', 'eq', 'x')
  } catch (error) {
    if (error instanceof OrmUsageError) return error.code
  }
  throw new Error('expected an unknown-column error')
}

function thrown(attempt: () => unknown): unknown {
  try {
    attempt()
  } catch (error) {
    return error
  }
  return undefined
}

describe('secret-looking names (the schema default)', () => {
  test.each([
    'password',
    'Password',
    'password_hash',
    'old_password',
    'token',
    'remember_token',
    'refresh_token',
    'secret',
    'client_secret',
    'two_factor_secret',
    'api_key',
    'stripe_api_key',
    'private_key',
    'aws_secret_key',
    'aws_access_key',
    'webhook_signing_key',
    'recovery_codes',
    'two_factor_recovery_codes',
    'salt',
  ])('%s is a secret', (name) => {
    expect(isSensitiveColumn(name)).toBe(true)
  })

  test.each(['name', 'token_count', 'tokenizer', 'passwordless', 'secretary', 'key', 'sort_key'])(
    '%s is not',
    (name) => {
      expect(isSensitiveColumn(name)).toBe(false)
    },
  )
})

describe.each(engines)('hidden columns on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => {
    useEngine(engine)

    test.each(HIDDEN)(
      '%s (%s) never appears in toJSON, JSON.stringify, inspect or nested JSON',
      async (column) => {
        const ada = await makeUser('Ada')
        ada.forceFill({ backup_phrase: 'correct horse', internal_note: 'vip customer' })
        await ada.save()
        expect(Reflect.get(ada, column)).not.toBeNull()
        expect(ada.toJSON()).not.toHaveProperty(column)
        expect(JSON.parse(JSON.stringify(ada))).not.toHaveProperty(column)
        expect(inspect(ada, { depth: 4 })).not.toContain(column)
        const reloaded = await User.query().where('id', ada.id).firstOrFail()
        expect(reloaded.toJSON()).not.toHaveProperty(column)
        await makePost(ada, 'Hello', 'published')
        const post = await Post.with('author').firstOrFail()
        expect(JSON.parse(JSON.stringify(post)).author).not.toHaveProperty(column)
        const page = await User.query().paginate(10)
        expect(JSON.parse(JSON.stringify(page.data))[0]).not.toHaveProperty(column)
        // The visible columns are still there.
        expect(ada.toJSON()).toMatchObject({ name: 'Ada', email: 'ada@example.test' })
      },
    )

    test.each(HIDDEN)(
      '%s (%s) answers every request-driven query like a missing column',
      async (column) => {
        await makeUser('Ada')
        const expected = missingColumnCode()
        const attempts: readonly [string, () => unknown][] = [
          ['filter eq', () => User.query().filter(column, 'eq', 'x')],
          ['filter startsWith', () => User.query().filter(column, 'startsWith', 'x')],
          ['filter contains', () => User.query().filter(column, 'contains', 'x')],
          ['filter in', () => User.query().filter(column, 'in', ['x'])],
          ['filter null', () => User.query().filter(column, 'null', false)],
          ['filter gt', () => User.query().filter(column, 'gt', 'a')],
          ['sort', () => User.query().sort(column)],
          ['sort desc', () => User.query().sort(`name,-${column}`)],
          ['search', () => User.query().search('x', ['name', column])],
          ['whereContains', () => User.query().whereContains(column, 'x')],
          ['whereStartsWith', () => User.query().whereStartsWith(column, 'x')],
        ]
        for (const [label, attempt] of attempts) {
          const error = thrown(attempt)
          expect(error, label).toBeInstanceOf(OrmUsageError)
          expect((error as OrmUsageError).code, label).toBe(expected)
          expect((error as Error).message, label).not.toMatch(/Did you mean/)
        }
      },
    )

    test.each(HIDDEN)('%s (%s) is never suggested for a typo', (column) => {
      const typo = `${column.slice(0, -1)}x`
      for (const attempt of [
        () => User.query().sort(typo),
        () => User.query().filter(typo, 'eq', 'x'),
        () => Reflect.apply(User.query().where, User.query(), [typo, 'x']),
        () => new User().fill(JSON.parse(`{"${typo}": "x"}`)),
      ]) {
        const error = thrown(attempt)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).not.toContain(column)
      }
    })

    test.each(HIDDEN)('%s (%s) can never be mass-assigned from a request', (column) => {
      const error = thrown(() => new User().fill(JSON.parse(`{"${column}": "x"}`)))
      expect(error).toBeInstanceOf(Error)
    })

    test('a page cursor never carries a hidden value: sorting a cursor by one is refused', async () => {
      await makeUser('Ada')
      const sorted = Reflect.apply(User.query().orderBy, User.query(), ['api_token', 'asc'])
      await expect(sorted.cursorPaginate(1)).rejects.toMatchObject({ code: 'cursor_hidden_column' })
    })

    test('trusted, typed server code may still use a hidden column (opt-in by writing it)', async () => {
      const ada = await makeUser('Ada')
      expect(await User.query().where('api_token', 'token-Ada').count()).toBe(1)
      expect(await User.query().orderBy('api_token').count()).toBe(1)
      expect(Reflect.get(ada, 'password')).toBe('not-a-real-secret')
    })
  })
})

describe('model settings (no database needed)', () => {
  test('a secret column listed as fillable is refused at boot unless acknowledged', () => {
    class Leaky extends Model('users', { fillable: ['name', 'password'] }) {}
    expect(() => new Leaky().fill({ name: 'Ada' })).toThrow(/secret.*allowSensitive/s)
    class Deliberate extends Model('users', {
      fillable: ['name', 'api_token'],
      allowSensitive: ['api_token'],
    }) {}
    const made = new Deliberate().fill({ name: 'Ada', api_token: 't' })
    expect(Reflect.get(made, 'api_token')).toBe('t')
    // Still hidden from output, even when it may be written.
    expect(made.toJSON()).toEqual({ name: 'Ada' })
  })

  test("a model's own hidden list adds to the schema's, never replaces it", () => {
    class Quiet extends Model('users', { hidden: ['email'] }) {}
    const made = new Quiet().forceFill({
      name: 'Ada',
      email: 'ada@example.test',
      password: 'p',
      api_token: 't',
      backup_phrase: 'b',
      internal_note: 'n',
    })
    expect(made.toJSON()).toEqual({ name: 'Ada' })
  })
})
