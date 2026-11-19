/**
 * Job payloads (RFC-0006 §2): the plain-data rules, the envelope every driver stores, and its
 * HMAC signature.
 *
 * **Why so strict?** A jobs table (or a Redis list) is data anyone with database access can edit,
 * and it ends up in backups and dashboards. So a payload carries only plain JSON data and the
 * *name* of a registered job (never a module path, never code); keys that look like secrets are
 * refused at dispatch; and every field is signed with a subkey of `APP_KEY`, so an edited row is
 * refused by the worker instead of run, and its tenant can't be swapped.
 *
 * @module
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { sensitiveKeyMatcher } from '../core/logger/serialize.ts'
import { QueueError } from './errors.ts'

/**
 * A JSON value as a job may carry it.
 *
 * @example
 * const data: JsonData = { userId: 'u1', tags: ['a'] }
 */
export type JsonData =
  | string
  | number
  | boolean
  | null
  | readonly JsonData[]
  | { readonly [key: string]: JsonData }

/** The deepest nesting a payload may have. */
export const MAX_PAYLOAD_DEPTH = 32
/**
 * The default envelope size limit: 64 KiB, which fits the portable `TEXT` column of the
 * database driver on MySQL/MariaDB. Large data belongs in storage; the job carries its key.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 65_535
/** The hard ceiling a config may raise the limit to (the Redis driver's limit). */
export const MAX_PAYLOAD_BYTES_CEILING = 1024 * 1024

/**
 * What the worker needs to retry a job, as it travels in the envelope.
 *
 * @example
 * const options: WireOptions = { tries: 3, backoff: [10, 60], timeout: 60 }
 */
export interface WireOptions {
  readonly tries: number
  /** Seconds per failed attempt (the last value repeats), or `'exponential'`. */
  readonly backoff: readonly number[] | 'exponential'
  readonly timeout: number
  /** Stop retrying after this moment (ms since the epoch). */
  readonly retryUntil?: number
}

/**
 * One step of a chain still to run (RFC-0006 §6).
 *
 * @example
 * const step: ChainStep = { job: 'publish-post', data: { id: 'p1' } }
 */
export interface ChainStep {
  readonly job: string
  readonly data: JsonData
  readonly queue?: string
  readonly connection?: string
  readonly delaySeconds?: number
}

/**
 * The unique-job lock a job holds (RFC-0006 §5).
 *
 * @example
 * const unique: UniqueLock = { key: 'queue:unique:import:1', owner: 'x', until: 'processing' }
 */
export interface UniqueLock {
  readonly key: string
  readonly owner: string
  readonly until: 'processing' | 'completed'
}

/**
 * The envelope: what a driver stores, as one JSON string.
 *
 * @example
 * const envelope: Envelope = { v: 1, id, job: 'send-mail', data: {}, queue: 'default', … }
 */
export interface Envelope extends WireOptions {
  readonly v: 1
  readonly id: string
  readonly job: string
  readonly data: JsonData
  readonly queue: string
  readonly connection: string
  readonly dispatchedAt: number
  readonly tenantId?: string
  readonly chain?: readonly ChainStep[]
  readonly chainCatch?: ChainStep
  readonly unique?: UniqueLock
}

/** Keys refused in job data and dropped when parsing: the prototype-pollution vectors. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

let matcher: ((key: string) => boolean) | undefined
function isSensitive(key: string): boolean {
  matcher ??= sensitiveKeyMatcher()
  return matcher(key)
}

/**
 * Check that `value` is plain JSON data with no secret-looking keys, and return it typed.
 * Throws `queue_payload_not_plain` or `queue_payload_sensitive` naming the offending path.
 *
 * @example
 * assertPlainData({ userId: 'u1' }) // ok
 * assertPlainData({ at: new Date() }) // throws queue_payload_not_plain at data.at
 */
export function assertPlainData(value: unknown, path = 'data'): JsonData {
  check(value, path, 0, new Set())
  return value as JsonData
}

function notPlain(path: string, what: string, hint: string): QueueError {
  return new QueueError(
    'queue_payload_not_plain',
    `Job data must be plain JSON data, but ${path} is ${what}.`,
    hint,
  )
}

function check(value: unknown, path: string, depth: number, seen: Set<object>): void {
  if (depth > MAX_PAYLOAD_DEPTH)
    throw notPlain(path, `nested deeper than ${MAX_PAYLOAD_DEPTH} levels`, 'Flatten the data.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw notPlain(path, String(value), 'Use a finite number, or null.')
  }
  if (typeof value === 'bigint')
    throw notPlain(path, 'a bigint', 'Pass it as a string (String(value)).')
  if (typeof value === 'undefined')
    throw notPlain(path, 'undefined', 'Leave the key out, or use null.')
  if (typeof value !== 'object')
    throw notPlain(
      path,
      `a ${typeof value}`,
      'Jobs carry data, never code: register the behaviour as a job and pass only its inputs.',
    )
  if (seen.has(value)) throw notPlain(path, 'a circular reference', 'Remove the cycle.')
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      check(item, `${path}[${index}]`, depth + 1, seen)
    })
  } else {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      const name = value.constructor?.name ?? 'an object with a custom prototype'
      throw notPlain(
        path,
        `a ${name}`,
        value instanceof Date
          ? 'Pass an ISO string (date.toISOString()) and parse it in the handler.'
          : 'Pass the record id (or plain fields) and load it inside the handler.',
      )
    }
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key))
        throw notPlain(`${path}.${key}`, 'a reserved key', 'Rename the key: __proto__, constructor and prototype are refused in job data.')
      if (isSensitive(key)) {
        throw new QueueError(
          'queue_payload_sensitive',
          `Job data must not carry secrets, but ${path}.${key} looks like one.`,
          'Pass an id and load the secret inside the handler: jobs tables end up in backups, dashboards and logs.',
        )
      }
      check((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, seen)
    }
  }
  seen.delete(value)
}

/**
 * JSON with object keys sorted (recursively): the bytes the signature covers, so a store that
 * reorders keys (MySQL `JSON`, `jsonb`) can't break verification.
 *
 * @example
 * canonicalJson({ b: 1, a: 2 }) // '{"a":2,"b":1}'
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/**
 * Signs and verifies envelopes. Keys come from the app keyring (`keyring.deriveAll('queue')`,
 * current first), so jobs queued before `key:rotate` still verify.
 *
 * @example
 * const signer = new EnvelopeSigner(keyring.deriveAll('queue'))
 * const text = signer.encode(envelope)
 * signer.decode(text) // the envelope, or throws queue_payload_tampered
 */
export class EnvelopeSigner {
  readonly #keys: readonly Uint8Array[]
  readonly #current: Uint8Array
  readonly #maxBytes: number

  constructor(keys: readonly Uint8Array[], options: { readonly maxPayloadBytes?: number } = {}) {
    const first = keys[0]
    if (first === undefined || first.byteLength < 32)
      throw new QueueError(
        'queue_not_configured',
        'The queue needs a 32-byte signing key.',
        'Set APP_KEY (node strut key:generate); the queue derives its signing key from it.',
      )
    this.#current = first
    this.#keys = Object.freeze([...keys])
    this.#maxBytes = payloadLimit(options.maxPayloadBytes)
  }

  /** The envelope size limit in bytes. */
  get maxPayloadBytes(): number {
    return this.#maxBytes
  }

  /**
   * Serialise and sign an envelope. Throws `queue_payload_too_large` above the limit.
   *
   * @example
   * await driver.push(envelope.queue, signer.encode(envelope))
   */
  encode(envelope: Envelope): string {
    const body = canonicalJson(envelope)
    const sig = this.#mac(this.#current, body)
    const text = `${body.slice(0, -1)}${body === '{}' ? '' : ','}"sig":${JSON.stringify(sig)}}`
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.#maxBytes)
      throw new QueueError(
        'queue_payload_too_large',
        `The "${envelope.job}" job's payload is ${bytes} bytes; the limit is ${this.#maxBytes}.`,
        'Store large data (storage, a table) and pass its key or id to the job instead.',
      )
    return text
  }

  /**
   * Parse and verify a stored envelope. Throws `queue_payload_tampered` when it can't be parsed,
   * has no valid signature, or doesn't have the envelope's shape.
   *
   * @example
   * const envelope = signer.decode(job.payload)
   */
  decode(text: string): Envelope {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES_CEILING)
      throw tampered('it is not a string within the size ceiling')
    let parsed: unknown
    try {
      parsed = JSON.parse(text, dropDangerousKeys)
    } catch {
      throw tampered('it is not valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw tampered('it is not a JSON object')
    const { sig, ...rest } = parsed as Record<string, unknown>
    if (typeof sig !== 'string') throw tampered('it has no signature')
    const body = canonicalJson(rest)
    const given = Buffer.from(sig, 'base64url')
    const valid = this.#keys.some((key) => {
      const expected = Buffer.from(this.#mac(key, body), 'base64url')
      return expected.length === given.length && timingSafeEqual(expected, given)
    })
    if (!valid) throw tampered('its signature does not match')
    if (!isEnvelope(rest)) throw tampered('it does not have the envelope shape')
    return rest
  }

  #mac(key: Uint8Array, body: string): string {
    return createHmac('sha256', key).update(body, 'utf8').digest('base64url')
  }
}

function payloadLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PAYLOAD_BYTES
  if (!Number.isInteger(value) || value < 1024 || value > MAX_PAYLOAD_BYTES_CEILING)
    throw new QueueError(
      'queue_invalid_option',
      `maxPayloadBytes must be an integer between 1024 and ${MAX_PAYLOAD_BYTES_CEILING}; got ${String(value)}.`,
      'Fix maxPayloadBytes in config/queue.ts, or remove it to use the 64 KiB default.',
    )
  return value
}

function tampered(why: string): QueueError {
  return new QueueError(
    'queue_payload_tampered',
    `A queued job was refused because ${why}.`,
    'Jobs are signed with a key derived from APP_KEY: this row was edited, written by something other than the framework, or signed with a key no longer in APP_KEY / APP_PREVIOUS_KEYS.',
  )
}

/** A JSON.parse reviver that drops keys used for prototype pollution (dispatch refuses them). */
function dropDangerousKeys(key: string, value: unknown): unknown {
  return DANGEROUS_KEYS.has(key) ? undefined : value
}

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)
const isStr = (value: unknown): value is string => typeof value === 'string'

function isStep(value: unknown): value is ChainStep {
  if (value === null || typeof value !== 'object') return false
  const step = value as Record<string, unknown>
  return (
    isStr(step.job) &&
    'data' in step &&
    (step.queue === undefined || isStr(step.queue)) &&
    (step.connection === undefined || isStr(step.connection)) &&
    (step.delaySeconds === undefined || isInt(step.delaySeconds))
  )
}

function isEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & Envelope {
  const backoff = value.backoff
  const unique = value.unique as Record<string, unknown> | undefined
  return (
    value.v === 1 &&
    isStr(value.id) &&
    isStr(value.job) &&
    'data' in value &&
    isStr(value.queue) &&
    isStr(value.connection) &&
    isInt(value.dispatchedAt) &&
    isInt(value.tries) &&
    isInt(value.timeout) &&
    (backoff === 'exponential' || (Array.isArray(backoff) && backoff.every(isInt))) &&
    (value.retryUntil === undefined || isInt(value.retryUntil)) &&
    (value.tenantId === undefined || isStr(value.tenantId)) &&
    (value.chain === undefined || (Array.isArray(value.chain) && value.chain.every(isStep))) &&
    (value.chainCatch === undefined || isStep(value.chainCatch)) &&
    (unique === undefined ||
      (typeof unique === 'object' &&
        unique !== null &&
        isStr(unique.key) &&
        isStr(unique.owner) &&
        (unique.until === 'processing' || unique.until === 'completed')))
  )
}
