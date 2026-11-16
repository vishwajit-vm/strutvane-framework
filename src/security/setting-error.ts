/**
 * The error each security area's resolver throws with *all* the problems it found. The settings
 * collector ({@link SecuritySettings} in `settings.ts`) gathers them from every area into one
 * `BootError`, so a developer fixes everything in one go instead of one restart per mistake.
 *
 * Why not a `BootError` straight away: an area resolver used on its own (a test, `createHttpApp`)
 * still fails loudly, but the collector can tell "a bad setting" (collect it, keep checking) from
 * a real bug (rethrow it) by the class.
 *
 * @module
 */

/**
 * Every problem one area found.
 *
 * @example
 * throw new SecuritySettingError(['cors: "*" can\'t be combined with credentials: true'])
 */
export class SecuritySettingError extends Error {
  /** One line per bad setting, each saying what is wrong and what is allowed. */
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(problems.join('\n'))
    this.name = 'SecuritySettingError'
    this.problems = Object.freeze([...problems])
  }
}

/**
 * Throw a {@link SecuritySettingError} when an area found problems; a no-op for none.
 *
 * @example
 * failIfAny(problems) // no-op for []
 */
export function failIfAny(problems: readonly string[]): void {
  if (problems.length > 0) throw new SecuritySettingError(problems)
}
