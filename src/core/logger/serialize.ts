/**
 * Safe conversion of arbitrary values into JSON-ready, redacted data for log records.
 *
 * **Why not just `JSON.stringify`?** It throws on circular references and BigInt, drops `Error`
 * details, and happily writes passwords. Logging must never throw into application code
 * (RFC-0004) and must never store secrets, so every value goes through this function first.
 *
 * @module
 */
import type { LogError } from '../../contracts/index.ts'

/**
 * Key **fragments** that mark a value as sensitive. A key matches when its normalised form
 * (lowercase, without `-`, `_` and whitespace) *contains* a fragment, so `api_key`, `X-API-Key` and
 * `stripeApiKey` all match `apikey`. False positives (e.g. `tokenCount`) are preferred over leaks.
 *
 * `@strutvane/logs` builds its redactor on {@link sensitiveKeyMatcher} with these lists, so the
 * fallback logger and the full logger hide exactly the same keys.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = Object.freeze([
  // Passwords and secrets
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'salt',
  'credential',
  // Tokens, keys and signatures
  'token',
  'jwt',
  'bearer',
  'authorization',
  'apikey',
  'appkey',
  'accesskey',
  'privatekey',
  'signingkey',
  'encryptionkey',
  'signature',
  'csrf',
  'xsrf',
  // Sessions
  'cookie',
  'session',
  // Second factors and recovery
  'totp',
  'mfa',
  'recoverycode',
  'backupcode',
  // Payment and identity data
  'cardnumber',
  'cvv',
  'cvc',
  'iban',
])

/**
 * Short sensitive **words**. As fragments they would match far too much (`pin` is inside
 * `shipping`, `sid` inside `inside`, `ssn` inside `className`), so they match only as whole words
 * of a key: `pin`, `userPin`, `PIN_CODE` and `card-pin` match `pin`; `shipping` doesn't.
 *
 * Words are split at non-alphanumeric characters and camelCase boundaries (`userPIN` → `user pin`).
 */
export const DEFAULT_SENSITIVE_WORDS: readonly string[] = Object.freeze([
  'pin',
  'ssn',
  'sid',
  'sig',
  'otp',
  'pan',
])

export const REDACTED = '[REDACTED]'
const MAX_DEPTH = 8
const MAX_STRING = 8192
const MAX_ARRAY = 100
const MAX_CAUSE_DEPTH = 5
/** Matcher results cached per key: enough for any real schema, bounded against key flooding. */
const MATCHER_CACHE_SIZE = 10_000
/** Upper bound on registered keys, so a registration bug can't grow the registry without limit. */
const MAX_REGISTERED_KEYS = 10_000
const MAX_REGISTERED_KEY_LENGTH = 200

/**
 * Normalise a key for fragment matching: lowercase, without `-`, `_` and whitespace, so `api_key`,
 * `api-key`, `API Key` and `apiKey` all become `apikey`.
 */
export function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '')
}

/**
 * Split a key into lowercase words at separators and camelCase boundaries, returned as
 * `.word.word.` so a contiguous word sequence can be found with one `includes`.
 */
function wordPath(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  return words.length === 0 ? '' : `.${words.join('.')}.`
}

/**
 * Keys registered at runtime (e.g. by the framework, for model fields marked `sensitive` or
 * `hidden`). Process-wide on purpose: every logger in the process (core's fallback and
 * `@strutvane/logs`) must hide them, whichever was created first. The set only grows, so a
 * registration can never make a logger reveal more.
 */
const registry: { readonly entries: Set<string>; version: number } = {
  entries: new Set<string>(),
  version: 0,
}

/**
 * Register extra sensitive keys for every logger in the process, at runtime. Each key matches as a
 * whole word sequence (registering `taxNumber` hides `taxNumber`, `tax_number` and
 * `customerTaxNumber`, but not `syntaxNumber`) and by its exact normalised form (`TAXNUMBER`).
 *
 * Use it for application data whose names aren't generic secrets, such as model fields marked
 * `sensitive` or `hidden`. Loggers that already exist pick the keys up with their next record.
 *
 * @throws TypeError if a key is not a non-empty string of at most 200 characters
 * @throws RangeError if more than 10,000 entries would be registered
 *
 * @example
 * registerSensitiveKeys(['dateOfBirth', 'taxNumber'])
 */
export function registerSensitiveKeys(keys: readonly string[]): void {
  const entries: string[] = []
  for (const key of keys) {
    if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_REGISTERED_KEY_LENGTH) {
      throw new TypeError(
        `registerSensitiveKeys: every key must be a non-empty string of at most ${MAX_REGISTERED_KEY_LENGTH} characters`,
      )
    }
    const path = wordPath(key)
    if (path !== '') entries.push(path)
    entries.push(`=${normalizeSensitiveKey(key)}`)
  }
  const fresh = [...new Set(entries)].filter((e) => !registry.entries.has(e))
  if (fresh.length === 0) return
  if (registry.entries.size + fresh.length > MAX_REGISTERED_KEYS) {
    throw new RangeError(
      `registerSensitiveKeys: at most ${MAX_REGISTERED_KEYS} entries can be registered`,
    )
  }
  for (const e of fresh) registry.entries.add(e)
  registry.version++
}

/** Options for {@link sensitiveKeyMatcher}. */
export interface SensitiveKeyMatcherOptions {
  /** Whole-word keys (see {@link DEFAULT_SENSITIVE_WORDS}). Default: the built-in words. */
  readonly words?: readonly string[]
  /** Also match keys added with {@link registerSensitiveKeys}. Default: `true`. */
  readonly registered?: boolean
}

/**
 * Build a matcher for sensitive keys: `fragments` match anywhere in the normalised key, `words`
 * match whole words, and keys registered at runtime match as described in
 * {@link registerSensitiveKeys}. Results are cached per key (bounded); the cache resets whenever
 * new keys are registered.
 */
export function sensitiveKeyMatcher(
  fragments: readonly string[] = DEFAULT_SENSITIVE_KEYS,
  options: SensitiveKeyMatcherOptions = {},
): (key: string) => boolean {
  const normalized = fragments.map(normalizeSensitiveKey).filter(Boolean)
  const words = (options.words ?? DEFAULT_SENSITIVE_WORDS).map(wordPath).filter(Boolean)
  const useRegistry = options.registered !== false
  const cache = new Map<string, boolean>()
  let seenVersion = registry.version

  const compute = (key: string): boolean => {
    const k = normalizeSensitiveKey(key)
    if (normalized.some((f) => k.includes(f))) return true
    const path = wordPath(key)
    if (path !== '' && words.some((w) => path.includes(w))) return true
    if (!useRegistry || registry.entries.size === 0) return false
    if (registry.entries.has(`=${k}`)) return true
    if (path === '') return false
    for (const e of registry.entries) if (e.startsWith('.') && path.includes(e)) return true
    return false
  }

  return (key) => {
    if (useRegistry && seenVersion !== registry.version) {
      cache.clear()
      seenVersion = registry.version
    }
    let hit = cache.get(key)
    if (hit === undefined) {
      hit = compute(key)
      if (cache.size < MATCHER_CACHE_SIZE) cache.set(key, hit)
    }
    return hit
  }
}

let sharedMatcher: ((key: string) => boolean) | undefined
/** The default matcher, built once so its cache is shared by every default `toLoggable` call. */
function defaultMatcher(): (key: string) => boolean {
  sharedMatcher ??= sensitiveKeyMatcher()
  return sharedMatcher
}

/** Serialise an Error (stack, code and cause chain) without ever throwing. */
export function serializeError(error: Error, depth = 0): LogError {
  const code = (error as { code?: unknown }).code
  const cause = (error as { cause?: unknown }).cause
  return {
    name: String(error.name),
    message: String(error.message),
    ...(error.stack ? { stack: String(error.stack) } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    ...(cause instanceof Error && depth < MAX_CAUSE_DEPTH
      ? { cause: serializeError(cause, depth + 1) }
      : {}),
  }
}

/**
 * Convert a value to JSON-safe data: redacts sensitive keys at any depth, replaces cycles with
 * `"[Circular]"`, BigInt with strings, drops functions and symbols, truncates huge strings and
 * arrays, and stops at a fixed depth. Never throws.
 */
export function toLoggable(
  value: unknown,
  isSensitive: (key: string) => boolean = defaultMatcher(),
): unknown {
  const seen = new WeakSet<object>()

  const visit = (v: unknown, depth: number): unknown => {
    switch (typeof v) {
      case 'string':
        return v.length > MAX_STRING
          ? `${v.slice(0, MAX_STRING)}…[truncated ${v.length - MAX_STRING} chars]`
          : v
      case 'number':
        return Number.isFinite(v) ? v : String(v)
      case 'boolean':
        return v
      case 'bigint':
        return v.toString()
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined
    }
    if (v === null) return null
    const obj = v as object
    if (seen.has(obj)) return '[Circular]'
    if (depth >= MAX_DEPTH) return '[Depth limit]'
    seen.add(obj)
    try {
      if (obj instanceof Error) return serializeError(obj)
      if (obj instanceof Date)
        return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString()
      if (ArrayBuffer.isView(obj)) return `[${obj.constructor.name}(${obj.byteLength} bytes)]`
      if (obj instanceof Map) return visit(Object.fromEntries(obj), depth)
      if (obj instanceof Set) return visit([...obj], depth)
      if (Array.isArray(obj)) {
        const items = obj.slice(0, MAX_ARRAY).map((item) => visit(item, depth + 1) ?? null)
        if (obj.length > MAX_ARRAY) items.push(`…[${obj.length - MAX_ARRAY} more]`)
        return items
      }
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(obj)) {
        let child: unknown
        try {
          child = (obj as Record<string, unknown>)[key]
        } catch {
          child = '[Unreadable]'
        }
        if (isSensitive(key)) {
          if (child !== undefined) out[key] = REDACTED
          continue
        }
        const serialized = visit(child, depth + 1)
        if (serialized !== undefined) out[key] = serialized
      }
      return out
    } catch {
      return '[Unserializable]'
    } finally {
      seen.delete(obj)
    }
  }

  return visit(value, 0)
}
