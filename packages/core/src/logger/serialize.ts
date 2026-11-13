/**
 * Safe conversion of arbitrary values into JSON-ready, redacted data for log records.
 *
 * **Why not just `JSON.stringify`?** It throws on circular references and BigInt, drops `Error`
 * details, and happily writes passwords. Logging must never throw into application code
 * (RFC-0004) and must never store secrets, so every value goes through this function first.
 *
 * @module
 */
import type { LogError } from '@strutvane/contracts'

/** Key fragments that mark a value as sensitive (matched case-insensitively, ignoring `-` and `_`). */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = Object.freeze([
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
  'credential',
  'sessionid',
])

export const REDACTED = '[REDACTED]'
const MAX_DEPTH = 8
const MAX_STRING = 8192
const MAX_ARRAY = 100
const MAX_CAUSE_DEPTH = 5

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '')

/** Build a matcher for sensitive keys. */
export function sensitiveKeyMatcher(
  fragments: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): (key: string) => boolean {
  const normalized = fragments.map(normalizeKey).filter(Boolean)
  return (key) => {
    const k = normalizeKey(key)
    return normalized.some((f) => k.includes(f))
  }
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
  isSensitive: (key: string) => boolean = sensitiveKeyMatcher(),
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
