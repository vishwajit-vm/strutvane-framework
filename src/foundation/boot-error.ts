/**
 * The friendly error the application core throws for developer mistakes: a typo in a route, an
 * unknown middleware alias, a missing binding, a weak `APP_KEY`.
 *
 * **Why a class of its own (and not `StrutvaneError`)?** `StrutvaneError` is for problems a
 * *client* sees: it renders through the message catalogs into an RFC 9457 response. A
 * `BootError` is for the *developer*: it stops boot (or a command) and says what went wrong and
 * how to fix it. The CLI and the dev error page print `message` plus `hint` without a stack
 * trace, because the stack of a config typo only adds noise. It never reaches an HTTP client:
 * the exception handler turns it into a plain 500 outside local development.
 *
 * Codes are lowercase `snake_case` (CONSISTENCY #68).
 *
 * @module
 */

/**
 * A developer-facing error with a stable code and a fix-it hint.
 *
 * @example
 * throw new BootError('unknown_middleware', 'No middleware is called "auht".', 'Did you mean "auth"?')
 */
export class BootError extends Error {
  /** A stable, grep-able code such as `unknown_middleware`. */
  readonly code: string
  /** One sentence on how to fix it. */
  readonly hint: string

  constructor(code: string, message: string, hint: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BootError'
    this.code = code
    this.hint = hint
  }

  /**
   * The message and the hint together, ready to print.
   *
   * @example
   * error.describe() // 'No middleware is called "auht".\n  → Did you mean "auth"?'
   */
  describe(): string {
    return `${this.message}\n  → ${this.hint}`
  }
}

/**
 * Whether a value is a {@link BootError} (also across module copies, by name and shape).
 *
 * @example
 * if (isBootError(error)) out.error(error.describe())
 */
export function isBootError(value: unknown): value is BootError {
  return (
    value instanceof BootError ||
    (value instanceof Error &&
      value.name === 'BootError' &&
      typeof (value as { hint?: unknown }).hint === 'string')
  )
}
