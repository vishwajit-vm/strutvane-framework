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
  /** The parts, in order. */
  readonly parts: readonly SqlPart[]

  private constructor(parts: readonly SqlPart[]) {
    this.parts = parts
  }

  /**
   * Internal constructor for trusted text produced by the compiler. Not exported from the
   * package entry point; app code uses the {@link sql} tag.
   *
   * @example
   * SqlFragment.trusted([{ kind: 'text', text: 'SELECT 1' }])
   */
  static trusted(parts: readonly SqlPart[]): SqlFragment {
    return new SqlFragment(parts)
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
    throw new OrmUsageError('INVALID_IDENTIFIER', `"${name}" is not a valid table or column name. Use letters, digits and underscores, starting with a letter (max 63).`)
  }
}

/**
 * Write raw SQL safely. Every `${value}` becomes a bound parameter; a `${fragment}` is spliced
 * in as SQL (that is how fragments compose); `${sql.id('name')}` is a quoted identifier.
 *
 * @example
 * await db.select(sql`SELECT * FROM ${sql.id('posts')} WHERE title = ${userInput}`)
 */
export function sql(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment {
  // Template objects are frozen arrays with a frozen `.raw`; a hand-built array is not. This
  // stops `sql([userInput])` style calls from smuggling text in.
  if (!Object.isFrozen(strings) || !Array.isArray(strings.raw)) {
    throw new OrmUsageError('RAW_SQL_NOT_TEMPLATE', 'sql must be used as a tagged template (sql`...`), never called with a string. Put values in ${…} so they are bound.')
  }
  const parts: SqlPart[] = []
  strings.forEach((text, index) => {
    if (text !== '') parts.push({ kind: 'text', text })
    if (index < values.length) pushValue(parts, values[index])
  })
  return SqlFragment.trusted(parts)
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
sql.id = function id(name: string): SqlFragment {
  assertIdentifier(name)
  return SqlFragment.trusted([{ kind: 'identifier', name }])
}

/**
 * Join fragments with a separator (the separator is trusted SQL text written by the ORM).
 *
 * @example
 * sql.join([sql`a = ${1}`, sql`b = ${2}`], ' AND ')
 */
sql.join = function join(fragments: readonly SqlFragment[], separator: string): SqlFragment {
  const parts: SqlPart[] = []
  fragments.forEach((fragment, index) => {
    if (index > 0) parts.push({ kind: 'text', text: separator })
    parts.push(...fragment.parts)
  })
  return SqlFragment.trusted(parts)
}

/**
 * Small builders the compiler uses to assemble fragments without string concatenation of
 * values. Exported for the compiler only.
 *
 * @example
 * text('SELECT '), value(42), identifier('posts')
 */
export const text = (value: string): SqlFragment => SqlFragment.trusted([{ kind: 'text', text: value }])
export const value = (bound: unknown): SqlFragment => SqlFragment.trusted([{ kind: 'value', value: bound }])
export const identifier = (name: string): SqlFragment => {
  assertIdentifier(name)
  return SqlFragment.trusted([{ kind: 'identifier', name }])
}

/**
 * Concatenate fragments with no separator.
 *
 * @example
 * concat(text('SELECT * FROM '), identifier('posts'))
 */
export function concat(...fragments: readonly SqlFragment[]): SqlFragment {
  return sql.join(fragments, '')
}
