/**
 * The service container: a small, typed dependency-injection container without reflection or
 * decorators.
 *
 * **Why typed tokens instead of class decorators?** Tokens work with plain functions, interfaces
 * and values, need no compiler metadata (so they survive any bundler and TypeScript 7), and make
 * `make(Logger)` return a `Logger` at compile time. A misspelled or mistyped token is a type error,
 * not a runtime surprise.
 *
 * Lifetimes:
 * - `bind`: a new instance on every `make` (transient).
 * - `singleton`: one instance for the whole application.
 * - `scoped`: one instance per scope (typically one HTTP request). Resolving a scoped token outside
 *   a scope is an error, because it would silently turn request data into shared global state.
 * - `value`: a ready-made value.
 *
 * @module
 */

/** A typed key for a service. Create one per service with {@link token}. */
export interface Token<T> {
  /** Unique identity: two tokens with the same name are still different tokens. */
  readonly id: symbol
  /** Human-readable name, used in error messages. */
  readonly name: string
  /** Phantom field that carries the service type; never present at runtime. */
  readonly __type?: T
}

/**
 * Create a typed token.
 * @example
 * export const Mailer = token<Mailer>('mailer')
 */
export function token<T>(name: string): Token<T> {
  if (name.trim() === '') throw new TypeError('token(name): name must be a non-empty string')
  return Object.freeze({ id: Symbol(name), name })
}

/** What a factory receives: the ability to resolve other services. */
export interface Resolver {
  /** Resolve a service. Throws {@link ContainerError} if it isn't bound. */
  make<T>(token: Token<T>): T
  /** Whether a binding exists (in this container or a parent). */
  has(token: Token<unknown>): boolean
}

/** Builds a service. Receives a resolver for its own dependencies. */
export type Factory<T> = (resolver: Resolver) => T

/** Cleanup for an instance, run when its owning container or scope is disposed. */
export type Disposer<T> = (instance: T) => void | Promise<void>

/** Options for cached lifetimes (`singleton`, `scoped`). */
export interface LifetimeOptions<T> {
  /** Called once with the instance when the owning container/scope is disposed. */
  readonly dispose?: Disposer<T>
}

/** A container (the application root or a scope). */
export interface Container extends Resolver {
  /** A new instance on every resolution. */
  bind<T>(token: Token<T>, factory: Factory<T>): Container
  /** One instance for the whole application, created on first use. */
  singleton<T>(token: Token<T>, factory: Factory<T>, options?: LifetimeOptions<T>): Container
  /** One instance per scope, created on first use within that scope. */
  scoped<T>(token: Token<T>, factory: Factory<T>, options?: LifetimeOptions<T>): Container
  /** A ready-made value. */
  value<T>(token: Token<T>, value: T): Container
  /** Create a child scope (e.g. per request). Scope-local bindings never leak to the parent. */
  createScope(): Container
  /** Register a cleanup to run when this container/scope is disposed. */
  onDispose(cleanup: () => void | Promise<void>): void
  /**
   * Run every cleanup in reverse registration order. All cleanups run even if some fail; failures
   * are reported together in an `AggregateError`. Idempotent: a second call does nothing.
   */
  dispose(): Promise<void>
  /** Whether {@link Container.dispose} has run. */
  readonly disposed: boolean
}

/** Error codes for container failures (programmer errors, so they fail fast and loudly). */
export type ContainerErrorCode =
  | 'UNKNOWN_TOKEN'
  | 'CIRCULAR_DEPENDENCY'
  | 'SCOPE_REQUIRED'
  | 'ALREADY_RESOLVED'
  | 'DISPOSED'

/** Thrown for container misuse. The message always names the token(s) involved. */
export class ContainerError extends Error {
  readonly code: ContainerErrorCode
  constructor(code: ContainerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ContainerError'
    this.code = code
  }
}

type Lifetime = 'transient' | 'singleton' | 'scoped' | 'value'

interface Binding {
  readonly lifetime: Lifetime
  readonly factory?: Factory<unknown>
  readonly value?: unknown
  readonly dispose?: Disposer<unknown>
}

class ContainerImpl implements Container {
  readonly #parent: ContainerImpl | undefined
  readonly #bindings = new Map<symbol, Binding>()
  /** Cached instances owned by this container (singletons at the root, scoped in scopes). */
  readonly #instances = new Map<symbol, unknown>()
  readonly #cleanups: Array<() => void | Promise<void>> = []
  #disposed = false

  constructor(parent?: ContainerImpl) {
    this.#parent = parent
  }

  get disposed(): boolean {
    return this.#disposed
  }

  bind<T>(token: Token<T>, factory: Factory<T>): Container {
    return this.#register(token, { lifetime: 'transient', factory: factory as Factory<unknown> })
  }

  singleton<T>(token: Token<T>, factory: Factory<T>, options?: LifetimeOptions<T>): Container {
    const binding: Binding = { lifetime: 'singleton', factory: factory as Factory<unknown> }
    return this.#register(token, withDispose(binding, options))
  }

  scoped<T>(token: Token<T>, factory: Factory<T>, options?: LifetimeOptions<T>): Container {
    const binding: Binding = { lifetime: 'scoped', factory: factory as Factory<unknown> }
    return this.#register(token, withDispose(binding, options))
  }

  value<T>(token: Token<T>, value: T): Container {
    return this.#register(token, { lifetime: 'value', value })
  }

  has(token: Token<unknown>): boolean {
    return this.#findBinding(token.id) !== undefined
  }

  make<T>(token: Token<T>): T {
    return this.#resolve(token, []) as T
  }

  createScope(): Container {
    this.#assertAlive()
    return new ContainerImpl(this)
  }

  onDispose(cleanup: () => void | Promise<void>): void {
    this.#assertAlive()
    this.#cleanups.push(cleanup)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const errors: unknown[] = []
    for (const cleanup of [...this.#cleanups].reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    this.#cleanups.length = 0
    this.#instances.clear()
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} cleanup(s) failed while disposing the container`,
      )
    }
  }

  #register(token: Token<unknown>, binding: Binding): Container {
    this.#assertAlive()
    if (this.#instances.has(token.id)) {
      throw new ContainerError(
        'ALREADY_RESOLVED',
        `Cannot rebind "${token.name}": it was already resolved, so existing users hold the old instance.`,
      )
    }
    this.#bindings.set(token.id, binding)
    return this
  }

  #findBinding(id: symbol): { binding: Binding; owner: ContainerImpl } | undefined {
    for (let c: ContainerImpl | undefined = this; c; c = c.#parent) {
      const binding = c.#bindings.get(id)
      if (binding) return { binding, owner: c }
    }
    return undefined
  }

  #resolve(token: Token<unknown>, stack: readonly Token<unknown>[]): unknown {
    this.#assertAlive()
    if (stack.some((t) => t.id === token.id)) {
      const path = [...stack, token].map((t) => t.name).join(' -> ')
      throw new ContainerError('CIRCULAR_DEPENDENCY', `Circular dependency: ${path}`)
    }
    const found = this.#findBinding(token.id)
    if (!found) {
      const via = stack.length > 0 ? ` (needed by "${stack.at(-1)?.name}")` : ''
      throw new ContainerError(
        'UNKNOWN_TOKEN',
        `No binding for "${token.name}"${via}. Register it in a service provider.`,
      )
    }
    const { binding, owner } = found
    if (binding.lifetime === 'value') return binding.value

    const nextStack = [...stack, token]
    // Factories resolve their dependencies from the container that is resolving (so scoped
    // dependencies of a transient service come from the current scope).
    const resolver: Resolver = {
      make: <U>(t: Token<U>): U => this.#resolve(t, nextStack) as U,
      has: (t) => this.has(t),
    }
    const factory = binding.factory as Factory<unknown>

    if (binding.lifetime === 'transient') return factory(resolver)

    // Cached lifetimes: decide which container owns the instance.
    let cacheOwner: ContainerImpl
    if (binding.lifetime === 'singleton') {
      cacheOwner = owner
    } else {
      if (this.#parent === undefined && owner === this) {
        throw new ContainerError(
          'SCOPE_REQUIRED',
          `"${token.name}" is scoped (one per request). Resolve it from a scope (container.createScope()), not the root.`,
        )
      }
      cacheOwner = this
    }
    if (cacheOwner.#instances.has(token.id)) return cacheOwner.#instances.get(token.id)
    // Singletons must not depend on scoped services through this resolver: resolve them from the
    // owner so a request scope can never be captured inside an app-wide singleton.
    const ownerResolver: Resolver =
      cacheOwner === this
        ? resolver
        : {
            make: <U>(t: Token<U>): U => cacheOwner.#resolve(t, nextStack) as U,
            has: (t) => cacheOwner.has(t),
          }
    const instance = factory(ownerResolver)
    cacheOwner.#instances.set(token.id, instance)
    if (binding.dispose) {
      const dispose = binding.dispose
      cacheOwner.#cleanups.push(() => dispose(instance))
    }
    return instance
  }

  #assertAlive(): void {
    if (this.#disposed) throw new ContainerError('DISPOSED', 'This container has been disposed.')
  }
}

function withDispose(binding: Binding, options: LifetimeOptions<never> | undefined): Binding {
  return options?.dispose ? { ...binding, dispose: options.dispose as Disposer<unknown> } : binding
}

/** Create an empty root container. Applications get one automatically from `createApp`. */
export function createContainer(): Container {
  return new ContainerImpl()
}
