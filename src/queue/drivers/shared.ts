/**
 * Small helpers every built-in queue driver shares.
 *
 * @module
 */
import { uuidv7 } from '../../core/uuid.ts'
import { QueueError } from '../errors.ts'
import { MAX_DELAY_SECONDS } from '../job.ts'

/** Laravel's `retry_after`: how long a reservation lasts by default. */
export const DEFAULT_RETRY_AFTER_SECONDS = 90

/**
 * A new job id: a UUIDv7, so ids sort by creation time.
 *
 * @example
 * newJobId() // '0193…'
 */
export function newJobId(): string {
  return uuidv7()
}

/**
 * Check a driver seconds argument (delay, visibility).
 *
 * @example
 * checkDriverSeconds(60, 'delaySeconds') // 60
 */
export function checkDriverSeconds(value: number, option: string, min = 0): number {
  if (!Number.isInteger(value) || value < min || value > MAX_DELAY_SECONDS)
    throw new QueueError(
      'queue_invalid_option',
      `${option} must be a whole number of seconds from ${min} to ${MAX_DELAY_SECONDS}; got ${String(value)}.`,
      'Pass whole seconds.',
    )
  return value
}

/**
 * A database integer as a JS number (drivers return number, bigint or string for BIGINT).
 *
 * @example
 * toInt(12n) // 12
 */
export function toInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  throw new TypeError(`Expected an integer from the database, got ${typeof value}.`)
}

/**
 * A nullable database integer.
 *
 * @example
 * toIntOrUndefined(null) // undefined
 */
export function toIntOrUndefined(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : toInt(value)
}
