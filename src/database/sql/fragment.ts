/**
 * SQL fragments: the only way SQL text exists in the ORM.
 *
 * A fragment is a list of parts: trusted SQL text, a bound value, or an identifier. Values are
 * never turned into text; they become `$1` / `?` placeholders when the fragment is rendered for
 * one dialect. Identifiers are validated and quoted at render time. There is deliberately no
 * "raw string" constructor: the `sql` tag only accepts real template literals, so user input can
 * never become SQL text by accident. That is what "no SQL injection by construction" means here.
 *
 * Keeping placeholders symbolic until the end (instead of writing `?` and renumbering, like the
 * framework's `sql.ts` does) also means a literal `?` in raw SQL, such as Postgres' jsonb `?`
 * operator, can never be mistaken for a parameter.
 */
import { OrmUsageError } from '../orm/errors.ts'

/** One piece of a fragment. */
export type SqlPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'identifier'; readonly name: string }

/**
 * A composable, parameterised piece of SQL. Build one with {@link sql}; you cannot construct it
 * from a plain string.
 *
 * @example
 * const recent = sql`created_at > ${since}`
 * Post.query().whereRaw(recent)
 */
export class SqlFragment {
  /** Marks real fragments, so a look-alike object can't sneak text in (`#brand in value`). */
  readonly #brand = true
  /** The parts, in order (frozen: nobody can push text into a fragment after it is made). */
  readonly parts: readonly SqlPart[]

  /**
   * Only this module can make a fragment: the constructor wants a token that is never exported,
   * so app code has no way to turn a string into SQL text, even by calling the class directly.
   */
  constructor(token: symbol, parts: readonly SqlPart[]) {
    if (token !== TRUSTED)
      throw new OrmUsageError(
        'raw_sql_not_template',
        'SQL fragments are made with the sql tag (sql`...`), never constructed directly.',
      )
    this.parts = Object.freeze(parts.map((part) => Object.freeze({ ...part })))
  }

  /**
   * Is this value a genuine fragment (not an object that merely looks like one)?
   *
   * @example
   * SqlFragment.is(sql`1 = 1`) // true
   */
  static is(value: unknown): value is SqlFragment {
    return typeof value === 'object' && value !== null && #brand in value
  }
}

/** The constructor's key; never leaves this module. */
const TRUSTED: unique symbol = Symbol('strutvane.sql.trusted')

/**
 * Internal: a fragment from SQL text the framework itself wrote (the compiler, the migration
 * runner's generated DDL). Not exported from any package entry point; app code uses {@link sql}.
 *
 * @example
 * trustedSql([{ kind: 'text', text: 'SELECT 1' }])
 */
export function trustedSql(parts: readonly SqlPart[]): SqlFragment {
  return new SqlFragment(TRUSTED, parts)
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

/**
 * Check an identifier before it is quoted. Identifiers in the ORM come from the schema
 * snapshot, so this is a second line of defence, not the first.
 *
 * @example
 * assertIdentifier('posts') // ok
 * assertIdentifier('posts; drop table users') // throws
 */
export function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new OrmUsageError(
      'invalid_identifier',
      `"${name}" is not a valid table or column name. Use letters, digits and underscores, starting with a letter (max 63).`,
    )
  }
}

/**
 * Write raw SQL safely. Every `${value}` becomes a bound parameter; a `${fragment}` is spliced
 * in as SQL (that is how fragments compose); `${sql.id('name')}` is a quoted identifier.
 *
 * @example
 * await db.select(sql`SELECT * FROM ${sql.id('posts')} WHERE title = ${userInput}`)
 */
function sqlTag(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment {
  // Template objects are frozen arrays with a frozen `.raw`; a hand-built array is not. This
  // stops `sql([userInput])` style calls from smuggling text in.
  const raw: unknown = Reflect.get(strings, 'raw')
  if (
    !Object.isFrozen(strings) ||
    !Array.isArray(raw) ||
    !Object.isFrozen(raw) ||
    raw.length !== strings.length
  ) {
    throw new OrmUsageError(
      'raw_sql_not_template',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the message shows the sql tag syntax
      'sql must be used as a tagged template (sql`...`), never called with a string. Put values in ${…} so they are bound.',
    )
  }
  const parts: SqlPart[] = []
  strings.forEach((text, index) => {
    if (text !== '') parts.push({ kind: 'text', text })
    if (index < values.length) pushValue(parts, values[index])
  })
  return trustedSql(parts)
}

function pushValue(parts: SqlPart[], value: unknown): void {
  if (SqlFragment.is(value)) parts.push(...value.parts)
  else parts.push({ kind: 'value', value })
}

/**
 * A quoted identifier for use inside the `sql` tag.
 *
 * @example
 * sql`SELECT ${sql.id('title')} FROM ${sql.id('posts')}`
 */
function id(name: string): SqlFragment {
  assertIdentifier(name)
  return trustedSql([{ kind: 'identifier', name }])
}

/**
 * Join fragments with a separator (the separator is trusted SQL text written by the ORM).
 *
 * @example
 * sql.join([sql`a = ${1}`, sql`b = ${2}`], ' AND ')
 */
function join(fragments: readonly SqlFragment[], separator: string): SqlFragment {
  const parts: SqlPart[] = []
  fragments.forEach((fragment, index) => {
    if (index > 0) parts.push({ kind: 'text', text: separator })
    parts.push(...fragment.parts)
  })
  return trustedSql(parts)
}

/**
 * Small builders the compiler uses to assemble fragments without string concatenation of
 * values. Exported for the compiler only.
 *
 * @example
 * text('SELECT '), value(42), identifier('posts')
 */
export const text = (value: string): SqlFragment => trustedSql([{ kind: 'text', text: value }])
export const value = (bound: unknown): SqlFragment => trustedSql([{ kind: 'value', value: bound }])
export const identifier = (name: string): SqlFragment => {
  assertIdentifier(name)
  return trustedSql([{ kind: 'identifier', name }])
}

/**
 * Concatenate fragments with no separator.
 *
 * @example
 * concat(text('SELECT * FROM '), identifier('posts'))
 */
export function concat(...fragments: readonly SqlFragment[]): SqlFragment {
  return join(fragments, '')
}

/**
 * The `sql` tag's shape: a template tag plus {@link SqlTag.id} and {@link SqlTag.join}.
 *
 * @example
 * const where: SqlFragment = sql`${sql.id('status')} = ${'draft'}`
 */
export interface SqlTag {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment
  /** A quoted, validated identifier. */
  id(name: string): SqlFragment
  /** Fragments joined with a trusted separator. */
  join(fragments: readonly SqlFragment[], separator: string): SqlFragment
}

/**
 * Write raw SQL safely. Every `${value}` becomes a bound parameter; a `${fragment}` is spliced
 * in as SQL (that is how fragments compose); `${sql.id('name')}` is a quoted identifier.
 *
 * @example
 * await connection.run(sql`SELECT * FROM ${sql.id('posts')} WHERE title = ${userInput}`)
 */
export const sql: SqlTag = Object.assign(sqlTag, { id, join })
