/**
 * Typed, immutable application configuration.
 *
 * **Why deep-freeze?** Config is read everywhere. If any module could mutate it at runtime,
 * behaviour would depend on import order and timing. A frozen object turns such bugs into an
 * immediate `TypeError` in strict mode.
 *
 * **Why typed paths?** `app.config('database.default')` is checked at compile time, so a typo or a
 * removed setting is a type error instead of a silent `undefined`.
 *
 * @module
 */

/** Recursively readonly view of a value. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

type Prev = [never, 0, 1, 2, 3, 4, 5, 6]

/**
 * Every dotted path into a config object, e.g. `"database" | "database.default"`.
 * Arrays and functions are leaves. Depth is capped at 6 to keep the compiler fast.
 */
export type ConfigPath<T, D extends number = 6> = [D] extends [never]
  ? never
  : T extends readonly unknown[] | ((...args: never[]) => unknown)
    ? never
    : T extends object
      ? {
          [K in keyof T & string]: K | `${K}.${ConfigPath<T[K], Prev[D]>}`
        }[keyof T & string]
      : never

/** The type at a dotted path. */
export type ConfigValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? ConfigValue<T[K], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never

/** Deep-freeze an object graph (cycles are handled). Returns the same object. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  const seen = new WeakSet<object>()
  const visit = (v: unknown): void => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return
    const obj = v as object
    if (seen.has(obj)) return
    seen.add(obj)
    for (const key of Reflect.ownKeys(obj)) {
      visit((obj as Record<PropertyKey, unknown>)[key])
    }
    Object.freeze(obj)
  }
  visit(value)
  return value as DeepReadonly<T>
}

/**
 * Declare application configuration. Returns a deep-frozen copy-free view of the same object.
 * @example
 * export default defineConfig({ app: { name: 'acme' }, database: { default: 'postgres' } })
 */
export function defineConfig<const T extends object>(config: T): DeepReadonly<T> {
  return deepFreeze(config)
}

/**
 * Read a value at a dotted path. Throws (fail closed) if any segment is missing, because a missing
 * setting is almost always a bug, not a reason to continue with `undefined`.
 */
export function getConfigValue<T extends object, P extends ConfigPath<T>>(
  config: T,
  path: P,
): DeepReadonly<ConfigValue<T, P>> {
  let current: unknown = config
  const segments = path.split('.')
  for (const [i, segment] of segments.entries()) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      const at = segments.slice(0, i + 1).join('.')
      throw new RangeError(`Config path "${path}" does not exist (missing "${at}")`)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current as DeepReadonly<ConfigValue<T, P>>
}
