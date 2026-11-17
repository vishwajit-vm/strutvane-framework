/**
 * Constructor injection for controllers, middleware, policies and commands, on top of the core
 * container (`core/container.ts`), without decorators or reflection.
 *
 * A class lists its dependencies in a `static inject` array, in constructor order:
 *
 * ```ts
 * class PostController {
 *   static readonly inject = [LoggerToken, ClockToken] as const
 *   constructor(private readonly logger: Logger, private readonly clock: Clock) {}
 * }
 * ```
 *
 * {@link CheckInjectable} makes a list that doesn't match the constructor a compile error, and
 * {@link build} resolves each entry: a token from the container, a class by building it the same
 * way (recursively). Classes are built fresh every time, so no request state can leak between
 * requests through a controller or middleware instance.
 *
 * **Why tokens can't be confused with classes:** core tokens carry `id: symbol`, which no class
 * has, so `isToken()` never mistakes a class for a token (spike 12 finding 1: a `{ name }` token
 * shape matched every class and skipped the `inject` check).
 *
 * @module
 */
import type { Resolver, Token } from '../core/container.ts'
import { BootError } from './boot-error.ts'

/**
 * A class the container can build: no constructor arguments, or a `static inject` list.
 *
 * @example
 * const injectable: Injectable<Greeter> = Greeter
 */
export type Injectable<TInstance> =
  | (new () => TInstance)
  | {
      new (...args: never[]): TInstance
      readonly inject: readonly Key<unknown>[]
    }

/**
 * What can be injected: a container token or an injectable class.
 *
 * @example
 * const keys: readonly Key<unknown>[] = [LoggerToken, Greeter]
 */
export type Key<TValue> = Token<TValue> | Injectable<TValue>

/**
 * The resolved values of an `inject` list, position by position.
 *
 * @example
 * type V = ResolvedList<[typeof LoggerToken]> // [Logger]
 */
export type ResolvedList<TKeys extends readonly unknown[]> = {
  -readonly [Index in keyof TKeys]: TKeys[Index] extends Token<infer TValue>
    ? TValue
    : TKeys[Index] extends abstract new (
          ...args: never[]
        ) => infer TInstance
      ? TInstance
      : never
}

/**
 * `TClass` when its `static inject` list matches its constructor, else `never` (a compile error at
 * the call site).
 *
 * @example
 * build(container, Greeter as CheckInjectable<typeof Greeter>)
 */
export type CheckInjectable<TClass> = TClass extends {
  readonly inject: infer TList extends readonly unknown[]
  new (...args: infer TArgs): unknown
}
  ? ResolvedList<TList> extends TArgs
    ? TClass
    : never
  : TClass extends new () => unknown
    ? TClass
    : never

/**
 * Whether a key is a core container token (has a symbol id), not a class.
 *
 * @example
 * isToken(LoggerToken) // true
 */
export function isToken(key: unknown): key is Token<unknown> {
  return (
    typeof key === 'object' &&
    key !== null &&
    typeof (key as { id?: unknown }).id === 'symbol' &&
    typeof (key as { name?: unknown }).name === 'string'
  )
}

/**
 * Build a class, resolving its `static inject` list from the container. The list is checked
 * against the constructor at compile time; at runtime a missing token fails with the container's
 * own error naming it, and a dependency loop is reported with the whole chain.
 *
 * @example
 * const controller = build(app.container, PostController)
 */
export function build<TClass extends Injectable<unknown>>(
  resolver: Resolver,
  target: TClass & CheckInjectable<TClass>,
): InstanceType<TClass> {
  return buildAny(resolver, target, []) as InstanceType<TClass>
}

/**
 * Build a class whose `inject` list was already checked where it was declared (route tables
 * store controllers as `Injectable<object>`).
 *
 * @example
 * const instance = buildUnchecked(app.container, route.controller)
 */
export function buildUnchecked(resolver: Resolver, target: Injectable<unknown>): unknown {
  return buildAny(resolver, target, [])
}

/**
 * Resolve one key: a token from the container, a class by building it.
 *
 * @example
 * resolveKey(app.container, LoggerToken)
 */
export function resolveKey<TValue>(resolver: Resolver, key: Key<TValue>): TValue {
  return (isToken(key) ? resolver.make(key) : buildAny(resolver, key, [])) as TValue
}

function buildAny(
  resolver: Resolver,
  target: Injectable<unknown>,
  stack: readonly Injectable<unknown>[],
): unknown {
  if (typeof target !== 'function') {
    throw new BootError(
      'not_injectable',
      `${String(target)} is neither a container token nor a class.`,
      'Inject tokens (token<T>("name")) or classes with a static inject list.',
    )
  }
  if (stack.includes(target)) {
    const chain = [...stack, target].map((entry) => entry.name).join(' → ')
    throw new BootError(
      'dependency_cycle',
      `These classes depend on each other in a loop: ${chain}.`,
      'Break the loop by injecting a factory (() => service) instead of the service itself.',
    )
  }
  const keys: readonly Key<unknown>[] = 'inject' in target ? target.inject : []
  if (!Array.isArray(keys)) {
    throw new BootError(
      'invalid_inject_list',
      `${target.name}.inject must be an array of tokens and classes.`,
      'Write: static readonly inject = [LoggerToken] as const',
    )
  }
  const next = [...stack, target]
  const args = keys.map((key) =>
    isToken(key) ? resolver.make(key) : buildAny(resolver, key, next),
  )
  // The public `build` overload checked, at compile time, that `inject` matches the constructor.
  const Constructor = target as unknown as new (...values: unknown[]) => unknown
  return new Constructor(...args)
}
