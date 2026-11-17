/**
 * The small set of SQL differences between the engines Strutvane targets, kept in one place.
 *
 * The DDL for every engine is generated here; the framework runs it on SQLite, PostgreSQL,
 * MySQL 8.4 and MariaDB 11.4 in its tests.
 *
 * @module
 */

/**
 * A SQL engine.
 *
 * @example
 * const dialect: Dialect = 'postgres'
 */
export type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb'

/**
 * MySQL and MariaDB share quoting, literals, `ENUM`, named foreign keys and `DROP INDEX … ON`; the
 * DDL differs only where {@link isMysqlFamily} callers check for `'mariadb'`.
 *
 * @example
 * isMysqlFamily('mariadb') // true
 */
export function isMysqlFamily(dialect: Dialect): dialect is 'mysql' | 'mariadb' {
  return dialect === 'mysql' || dialect === 'mariadb'
}

/**
 * A value that can be bound as a query parameter.
 *
 * @example
 * const value: SqlValue = 'draft'
 */
export type SqlValue = string | number | boolean | null

/**
 * Quote a table, column or index name. Names were already validated as lower-case snake_case by
 * the recorder, so quoting is about reserved words (`order`, `user`), not about injection.
 *
 * @example
 * quoteIdentifier('order', 'postgres') // '"order"'
 * quoteIdentifier('order', 'mysql') // '`order`'
 */
export function quoteIdentifier(name: string, dialect: Dialect): string {
  return isMysqlFamily(dialect) ? `\`${name}\`` : `"${name}"`
}

/**
 * Write a literal value into SQL (for `DEFAULT` and `CHECK`, where parameters aren't allowed).
 * Single quotes are doubled, which is the standard SQL escape in all three engines.
 *
 * @example
 * sqlLiteral("it's", 'sqlite') // "'it''s'"
 * sqlLiteral(false, 'postgres') // 'FALSE'
 */
export function sqlLiteral(
  value: SqlValue,
  dialect: Dialect,
  context: 'value' | 'comment' = 'value',
): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') {
    // SQLite and MySQL store booleans as 0/1 integers.
    if (dialect === 'postgres') return value ? 'TRUE' : 'FALSE'
    return value ? '1' : '0'
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`Can't write ${value} into SQL: only finite numbers are allowed.`)
    return String(value)
  }
  if (isMysqlFamily(dialect) && value.includes('\\')) {
    // A backslash's meaning depends on the session's sql_mode: by default it escapes, under
    // NO_BACKSLASH_ESCAPES (which the ORM pins) it is literal. A hex literal is the same bytes in
    // every mode, so DEFAULT and ENUM values are exact. COMMENT accepts no hex literal; doubling is
    // valid in both modes (the string can never end early), and a comment is only documentation.
    if (context === 'value') return `X'${Buffer.from(value, 'utf8').toString('hex')}'`
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  }
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Collects query parameters and hands back the right placeholder for the engine:
 * `$1, $2, …` for PostgreSQL, `?1, ?2, …` for SQLite, and plain `?` for MySQL.
 *
 * Why numbered placeholders for SQLite: with anonymous `?`, values bind in the order the
 * placeholders appear in the *text*, not the order `add()` was called. Building a WHERE clause
 * out of order, or reusing one placeholder twice, then silently binds the wrong values. The spike
 * hit exactly that (a uniqueness check and a soft delete that worked on PostgreSQL and misfired on
 * SQLite). Numbered placeholders make the order irrelevant on both engines. MySQL has no numbered
 * form, so a MySQL driver must build SQL strictly left to right *(unverified: no MySQL here)*.
 *
 * Every user-supplied value goes through here. Nothing from a request is ever spliced into SQL.
 *
 * @example
 * const params = new SqlParams('postgres')
 * const sql = `SELECT * FROM "posts" WHERE "id" = ${params.add(5)}` // … = $1
 * db.query(sql, params.values)
 */
export class SqlParams {
  readonly values: SqlValue[] = []
  readonly #dialect: Dialect

  constructor(dialect: Dialect) {
    this.#dialect = dialect
  }

  /** Remember a value and return its placeholder. */
  add(value: SqlValue): string {
    this.values.push(value)
    const position = this.values.length
    if (this.#dialect === 'postgres') return `$${position}`
    if (this.#dialect === 'sqlite') return `?${position}`
    return '?'
  }
}
