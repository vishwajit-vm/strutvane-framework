/**
 * Time, behind an interface.
 *
 * **Why?** Code that calls `Date.now()` directly can't be tested deterministically (token expiry,
 * retention, rate limits, log rotation at midnight). Everything in Strutvane takes a {@link Clock};
 * tests inject a {@link TestClock} and move time explicitly.
 *
 * @module
 */

/** A source of the current time. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
}

/** The real system clock. */
export const systemClock: Clock = Object.freeze({ now: (): number => Date.now() })

/** A clock you control, for tests. */
export interface TestClock extends Clock {
  /** Move time forward by `ms` milliseconds (negative values are rejected). */
  advance(ms: number): void
  /** Jump to an absolute time (ms since epoch). */
  set(ms: number): void
}

/** Create a {@link TestClock} starting at `startMs` (default: 2026-01-01T00:00:00Z). */
export function createTestClock(startMs: number = Date.UTC(2026, 0, 1)): TestClock {
  if (!Number.isFinite(startMs))
    throw new RangeError('createTestClock: start must be a finite number')
  let current = startMs
  return {
    now: (): number => current,
    advance(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError('TestClock.advance: ms must be a finite, non-negative number')
      }
      current += ms
    },
    set(ms: number): void {
      if (!Number.isFinite(ms)) throw new RangeError('TestClock.set: ms must be a finite number')
      current = ms
    },
  }
}

/** ISO-8601 timestamp (UTC) for a clock's current time. */
export function isoNow(clock: Clock = systemClock): string {
  return new Date(clock.now()).toISOString()
}
