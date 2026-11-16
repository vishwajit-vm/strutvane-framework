/**
 * Primary keys the ORM generates itself.
 *
 * `t.id()` keys come from the database (auto-increment). `t.uuid('id')` keys are generated here
 * as UUIDv7, Laravel 13's default too: time-ordered, so new rows land at the end of the index
 * (fast inserts) and `ORDER BY id` is creation order, while staying unguessable enough to put in
 * URLs.
 */
import { randomBytes } from 'node:crypto'

/** Highest value of the 12-bit counter kept in `rand_a` (RFC 9562 §6.2, method 1). */
const MAX_SEQUENCE = 0xfff
let lastMillis = 0
let sequence = 0

/**
 * A new UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, a 12-bit counter, then random bits.
 * The counter makes ids created in the same millisecond still sort in creation order.
 *
 * @example
 * uuidv7() // '019a8b2c-6a7f-7b12-9d6f-2f8a4e0c9c11'
 */
export function uuidv7(now: number = Date.now()): string {
  const millis = nextTimestamp(now)
  const bytes = randomBytes(16)
  // Big-endian 48-bit timestamp in bytes 0–5.
  let time = BigInt(millis)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn)
    time >>= 8n
  }
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f) // version 7 + top 4 counter bits
  bytes[7] = sequence & 0xff // low 8 counter bits
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80 // RFC 9562 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Advance the clock/counter pair; never goes backwards, even if the system clock does. */
function nextTimestamp(now: number): number {
  if (now > lastMillis) {
    lastMillis = now
    // Start each millisecond at a random low counter, leaving room to count up.
    sequence = (randomBytes(1)[0] ?? 0) & 0x3f
    return lastMillis
  }
  sequence += 1
  if (sequence > MAX_SEQUENCE) {
    // 4,096 ids in one millisecond: borrow the next millisecond rather than repeat an order.
    lastMillis += 1
    sequence = 0
  }
  return lastMillis
}
