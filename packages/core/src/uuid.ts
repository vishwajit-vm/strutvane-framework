/**
 * UUID version 7 (RFC 9562): time-ordered, random, globally unique ids.
 *
 * **Why UUIDv7?** Strutvane uses them for primary keys, events and audit records:
 * - they sort by creation time, so B-tree indexes stay compact (unlike random v4 ids);
 * - they are not guessable or enumerable (unlike sequential integers), which prevents IDOR-style
 *   probing of `/invoices/1`, `/invoices/2`, …;
 * - Postgres's `uuid` type and the tenancy policies (ADR-0007) accept them directly.
 *
 * Layout: 48-bit Unix milliseconds | 4-bit version (7) | 12-bit counter | 2-bit variant | 62 random bits.
 * The 12-bit field is a counter that keeps ids **strictly increasing within one generator**, even when
 * many are created in the same millisecond or the system clock steps backwards.
 *
 * @module
 */
import { webcrypto } from 'node:crypto'
import { type Clock, systemClock } from './clock.ts'

/** Fills a buffer with cryptographically secure random bytes. */
export type RandomSource = (bytes: Uint8Array) => void

const defaultRandom: RandomSource = (bytes) => {
  webcrypto.getRandomValues(bytes)
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Whether a string is a canonical lowercase UUIDv7. */
export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value)
}

/** A function that returns a new UUIDv7 on every call. */
export type UuidGenerator = () => string

/**
 * Create an independent, monotonic UUIDv7 generator.
 * @param options.clock time source (inject a TestClock in tests)
 * @param options.random secure random source (inject a deterministic one in tests)
 */
export function createUuidV7Generator(
  options: { readonly clock?: Clock; readonly random?: RandomSource } = {},
): UuidGenerator {
  const clock = options.clock ?? systemClock
  const random = options.random ?? defaultRandom
  let lastMs = -1
  let counter = 0

  return () => {
    let ms = Math.floor(clock.now())
    if (!Number.isFinite(ms) || ms < 0)
      throw new RangeError('uuidv7: clock returned an invalid time')
    if (ms <= lastMs) {
      // Same millisecond, or the clock stepped backwards: keep ordering by advancing the counter
      // (and, if it overflows, the logical timestamp) instead of trusting the clock.
      ms = lastMs
      counter++
      if (counter > 0xfff) {
        ms = lastMs + 1
        counter = 0
      }
    } else {
      // New millisecond: start the counter at a random point in its lower half, so ids from
      // different processes in the same millisecond still differ, with room left to count up.
      const seed = new Uint8Array(2)
      random(seed)
      counter = (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & 0x7ff
    }
    lastMs = ms

    const bytes = new Uint8Array(16)
    random(bytes.subarray(8)) // 64 random bits; the top 2 become the variant below
    // 48-bit big-endian timestamp. Use division (not bit shifts) because ms exceeds 32 bits.
    let t = ms
    for (let i = 5; i >= 0; i--) {
      bytes[i] = t % 256
      t = Math.floor(t / 256)
    }
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f) // version 7 + top 4 counter bits
    bytes[7] = counter & 0xff
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f) // RFC 9562 variant (10xx)

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

/** Generate a UUIDv7 using the shared default generator (system clock, secure randomness). */
export const uuidv7: UuidGenerator = createUuidV7Generator()

/** The millisecond timestamp encoded in a UUIDv7. Throws if the value is not a UUIDv7. */
export function uuidV7Timestamp(value: string): number {
  if (!isUuidV7(value)) throw new TypeError(`not a UUIDv7: "${value}"`)
  return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
}
