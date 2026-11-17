/**
 * Every error devkit throws is a {@link DevkitError} with a stable, machine-readable `code`, so the
 * CLI can map it to a friendly message (RFC-0003) and tests can assert on the code instead of on
 * wording. Messages name the cause and, where possible, the fix.
 *
 * @module
 */

/** Stable error codes. Never rename one: CLIs and docs refer to them. */
export type DevkitErrorCode =
  | 'path_outside_project'
  | 'invalid_path'
  | 'file_exists'
  | 'file_not_found'
  | 'invalid_env_key'
  | 'invalid_env_value'
  | 'invalid_package_json'
  | 'local_dependency_spec'
  | 'config_not_found'
  | 'config_shape_unrecognised'
  | 'invalid_installer'
  | 'installer_failed'
  | 'uninstall_not_supported'
  | 'invalid_generator'
  | 'generator_input_invalid'
  | 'transaction_aborted'
  | 'interrupted_transaction'

/** Base class of all devkit errors. */
export class DevkitError extends Error {
  /** Stable machine-readable code. */
  readonly code: DevkitErrorCode

  constructor(code: DevkitErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DevkitError'
    this.code = code
  }
}

/**
 * A multi-file commit failed. `rolledBack` tells whether every already-applied change was undone;
 * when it is `false`, the journal was kept and `recoverTransactions()` finishes the job.
 */
export class TransactionAbortedError extends DevkitError {
  readonly rolledBack: boolean

  constructor(message: string, rolledBack: boolean, options?: { readonly cause?: unknown }) {
    super('transaction_aborted', message, options)
    this.name = 'TransactionAbortedError'
    this.rolledBack = rolledBack
  }
}

/** One problem with generator input, in the RFC-0003 issue shape (path + message). */
export interface InputIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
}

/** Generator input failed validation. `issues` lists every problem, not just the first. */
export class GeneratorInputError extends DevkitError {
  readonly issues: readonly InputIssue[]

  constructor(generator: string, issues: readonly InputIssue[]) {
    const summary = issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(input)'}: ${i.message}`)
      .join('; ')
    super('generator_input_invalid', `invalid input for generator "${generator}": ${summary}`)
    this.name = 'GeneratorInputError'
    this.issues = issues
  }
}

/** Describe an unknown thrown value in one line, for error messages. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
