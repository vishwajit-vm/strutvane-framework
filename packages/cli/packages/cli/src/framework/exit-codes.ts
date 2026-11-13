/**
 * Process exit codes (docs/09 §1.4). They are part of the CLI's public contract: CI pipelines and
 * scripts branch on them, so a code never changes meaning once released.
 *
 * @module
 */

/** Every exit code the CLI uses, by meaning. */
export const EXIT: Readonly<{
  /** Success. */
  OK: 0
  /** Generic failure (an unexpected error, a failed child process). */
  FAILURE: 1
  /** Invalid usage: unknown command or flag, bad or missing argument. */
  USAGE: 2
  /** Validation failed: model definition, config, env, registry diagnostics, doctor failures. */
  VALIDATION: 3
  /** Conflict: merge conflicts were written, or a target file exists and is owned. */
  CONFLICT: 4
  /** Database error (connection, migration failure). Used by framework-contributed commands. */
  DATABASE: 5
  /** A pending action is required (stale registry with `--check`, unapplied migrations). */
  PENDING: 6
  /** Incompatible versions: a plugin or package's `strutvane.compat` range does not match. */
  INCOMPATIBLE: 7
  /** Interrupted (Ctrl+C), following the shell convention 128 + SIGINT(2). */
  INTERRUPTED: 130
}> = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  VALIDATION: 3,
  CONFLICT: 4,
  DATABASE: 5,
  PENDING: 6,
  INCOMPATIBLE: 7,
  INTERRUPTED: 130,
})

/** One of the documented exit codes. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
