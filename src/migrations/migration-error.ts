/**
 * The error every v2 migration command throws when it can't do its job.
 *
 * @module
 */

/** Stable codes of {@link MigrationError} (lowercase snake_case, decision #68). */
export type MigrationErrorCode =
  | 'migration_file_missing'
  | 'migration_changed'
  | 'migration_partial'
  | 'migration_failed'
  | 'rollback_failed'
  | 'migration_locked'
  | 'migration_not_portable'
  | 'not_null_without_default'
  | 'reserved_table'

/**
 * A migration command could not do its job. `message` says what happened in plain words, `hint`
 * what to do next. For a failed statement, `applied` lists what did commit (MySQL/MariaDB) and
 * `failed` the statement that broke.
 *
 * @example
 * try { await migrate(connection, replay) } catch (error) {
 *   if (error instanceof MigrationError) report(error.message, error.hint)
 * }
 */
export class MigrationError extends Error {
  override readonly name = 'MigrationError'
  /** A stable code tools can match on. */
  readonly code: MigrationErrorCode
  /** One friendly sentence (or two) on how to recover. */
  readonly hint: string
  /** The migration concerned, when there is one. */
  readonly migration: string | undefined
  /** Statements of this migration that are applied in the database (MySQL/MariaDB). */
  readonly applied: readonly string[]
  /** The statement that failed, when one did. */
  readonly failed: string | undefined

  constructor(
    code: MigrationErrorCode,
    message: string,
    hint: string,
    details: {
      readonly migration?: string
      readonly applied?: readonly string[]
      readonly failed?: string
      readonly cause?: unknown
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.code = code
    this.hint = hint
    this.migration = details.migration
    this.applied = details.applied ?? []
    this.failed = details.failed
  }
}
