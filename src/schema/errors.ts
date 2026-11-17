/**
 * Friendly, structured errors for everything that can go wrong while reading migrations.
 *
 * Each error has a stable `code` (so tests and tools can match on it, in the spirit of RFC-0003),
 * a plain-language `message` saying what went wrong, and a `hint` saying how to fix it.
 *
 * @module
 */

/**
 * Stable codes for schema problems. Tests match on these, never on message text.
 *
 * @example
 * const code: SchemaErrorCode = 'unknown_table'
 */
export type SchemaErrorCode =
  | 'invalid_identifier'
  | 'table_exists'
  | 'unknown_table'
  | 'column_exists'
  | 'unknown_column'
  | 'index_exists'
  | 'unknown_index'
  | 'invalid_column'
  | 'invalid_default'
  | 'invalid_foreign_key'
  | 'invalid_slug_source'
  | 'not_allowed_in_create'
  | 'invalid_migration'
  | 'duplicate_migration'
  | 'async_migration'
  | 'index_not_portable'
  | 'invalid_tenancy'
  | 'invalid_snapshot'

/**
 * A schema problem, with what went wrong and how to fix it.
 *
 * @example
 * throw new SchemaError('unknown_table', 'There is no table "post".', 'Did you mean "posts"?')
 */
export class SchemaError extends Error {
  /** A stable code that tools can match on. */
  readonly code: SchemaErrorCode
  /** One friendly sentence on how to fix the problem. */
  readonly hint: string
  /** The migration file this happened in, once known (filled in by the replayer). */
  migration: string | undefined

  constructor(code: SchemaErrorCode, message: string, hint: string) {
    super(message)
    this.name = 'SchemaError'
    this.code = code
    this.hint = hint
    this.migration = undefined
  }

  /**
   * A one-line, human-readable description: where, what, and how to fix it.
   *
   * @example
   * error.describe() // '[UNKNOWN_TABLE] in 2026_01_03_….ts: There is no table "post". Hint: Did you mean "posts"?'
   */
  describe(): string {
    const where = this.migration === undefined ? '' : ` in ${this.migration}`
    return `[${this.code}]${where}: ${this.message} Hint: ${this.hint}`
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * PostgreSQL silently truncates identifiers longer than 63 bytes, which turns two different long
 * names into the same name. We refuse them up front instead of letting that happen.
 */
const MAX_IDENTIFIER_LENGTH = 63

/**
 * Check that a table, column or index name is a safe, portable SQL identifier.
 *
 * Why so strict: these names are spliced into SQL (identifiers cannot be bound as parameters), so
 * only lower-case snake_case is accepted. That also avoids quoting and case-folding differences
 * between SQLite, PostgreSQL and MySQL.
 *
 * @example
 * assertIdentifier('blog_posts', 'table') // ok
 * assertIdentifier('Posts; drop table users', 'table') // throws INVALID_IDENTIFIER
 */
export function assertIdentifier(name: string, what: 'table' | 'column' | 'index'): void {
  // `__proto__` would become an object's prototype wherever names key a plain object.
  if (IDENTIFIER.test(name) && name.length <= MAX_IDENTIFIER_LENGTH && name !== '__proto__') return
  throw new SchemaError(
    'invalid_identifier',
    `The ${what} name ${JSON.stringify(name)} can't be used.`,
    `Use lower-case snake_case (letters, digits and _), start with a letter or _, and keep it under ${MAX_IDENTIFIER_LENGTH + 1} characters, for example "blog_posts".`,
  )
}
