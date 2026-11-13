/**
 * The application: config + container + service providers, with a predictable lifecycle.
 *
 * Lifecycle (04-architecture §2):
 * 1. **register**: every provider binds its services, in order. Synchronous and side-effect
 *    free, so registration order never depends on timing.
 * 2. **boot**: every provider starts (connects, subscribes, warms up), in order. Fails fast and
 *    names the provider that failed.
 * 3. **shutdown**: providers stop in **reverse** order, then the container is disposed. Always
 *    bounded by a timeout, so a hung connection can never keep the process alive forever.
 *
 * Core binds sensible defaults (clock, ids, logger, messages, error registry, events, hooks)
 * before providers register, so a provider can replace any of them (e.g. `@strutvane/logs`
 * rebinds the logger).
 *
 * @module
 */
import { type Clock, systemClock } from './clock.ts'
import {
  type ConfigPath,
  type ConfigValue,
  type DeepReadonly,
  deepFreeze,
  getConfigValue,
} from './config.ts'
import { type Container, createContainer, type Token } from './container.ts'
import { createErrorRegistry } from './errors/registry.ts'
import { createEventBus } from './events.ts'
import { createHooks } from './hooks.ts'
import { createLogger } from './logger/logger.ts'
import { createMessages } from './messages/catalog.ts'
import {
  ClockToken,
  ErrorRegistryToken,
  EventBusToken,
  HooksToken,
  IdGeneratorToken,
  LoggerToken,
  MessagesToken,
} from './tokens.ts'
import { createUuidV7Generator } from './uuid.ts'

/** Where the application is in its lifecycle. */
export type AppState = 'created' | 'booting' | 'booted' | 'failed' | 'shutting-down' | 'stopped'

/** A unit that plugs into the application. Every Strutvane package ships one. */
export interface Provider<C extends object = object> {
  /** Unique name, e.g. `"@strutvane/logs"`. */
  readonly name: string
  /** Bind services. Must be synchronous. */
  register(app: Application<C>): void
  /** Start: connect, subscribe, warm caches. */
  boot?(app: Application<C>): void | Promise<void>
  /** Stop: close connections, flush buffers. Called in reverse boot order. */
  shutdown?(app: Application<C>): void | Promise<void>
}

/** Identity helper that gives provider objects full type inference. */
export function defineProvider<C extends object = object>(provider: Provider<C>): Provider<C> {
  return provider
}

/** A failure in one provider during one phase. */
export class ProviderError extends Error {
  readonly provider: string
  readonly phase: 'register' | 'boot' | 'shutdown'
  constructor(provider: string, phase: 'register' | 'boot' | 'shutdown', cause: unknown) {
    super(
      `Provider "${provider}" failed during ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'ProviderError'
    this.provider = provider
    this.phase = phase
  }
}

/** What happened during shutdown. */
export interface ShutdownReport {
  /** `true` if the timeout was reached before everything stopped. */
  readonly timedOut: boolean
  /** Failures from providers or container cleanups. Shutdown continues past each one. */
  readonly errors: readonly ProviderError[]
}

/** Config paths of `C`; any string when the shape is unknown (`object`). */
export type AppConfigPath<C extends object> = object extends C ? string : ConfigPath<C>

/** Value at path `P`; `unknown` when the shape is unknown (`object`). */
export type AppConfigValue<C extends object, P extends string> = object extends C
  ? unknown
  : DeepReadonly<ConfigValue<C, P>>

/** The running application. */
export interface Application<C extends object = object> {
  readonly state: AppState
  readonly container: Container
  /** The whole (deep-frozen) config. */
  readonly settings: DeepReadonly<C>
  /**
   * Read a config value by typed dotted path. Throws if the path doesn't exist.
   * Inside a reusable package provider (`Provider<object>`) the app's config shape is
   * unknown, so any path is accepted and the value is `unknown`: validate it before use.
   */
  config<P extends AppConfigPath<C>>(path: P): AppConfigValue<C, P>
  /** Resolve a service from the root container. */
  make<T>(token: Token<T>): T
  boot(): Promise<void>
  shutdown(options?: { readonly timeoutMs?: number }): Promise<ShutdownReport>
}

/** Options for {@link createApp}. */
export interface CreateAppOptions<C extends object> {
  readonly config: C
  readonly providers?: readonly Provider<NoInfer<C>>[]
  /** Clock for the default services (inject a TestClock in tests). */
  readonly clock?: Clock
}

/** Create an application. Nothing runs until {@link Application.boot}. */
export function createApp<const C extends object>(options: CreateAppOptions<C>): Application<C> {
  const providers = options.providers ?? []
  const names = new Set<string>()
  for (const p of providers) {
    if (!p.name) throw new TypeError('Every provider needs a non-empty name')
    if (names.has(p.name))
      throw new Error(`Duplicate provider "${p.name}": each provider may be registered once`)
    names.add(p.name)
  }

  const settings = deepFreeze(options.config)
  const container = createContainer()
  const clock = options.clock ?? systemClock
  let state: AppState = 'created'
  const booted: Provider<C>[] = []
  let shutdownPromise: Promise<ShutdownReport> | undefined

  // Defaults first, so providers can rebind them during register().
  container
    .value(ClockToken, clock)
    .singleton(IdGeneratorToken, () => createUuidV7Generator({ clock }))
    .singleton(LoggerToken, () => createLogger({ clock }))
    .singleton(MessagesToken, () => createMessages())
    .singleton(ErrorRegistryToken, () => createErrorRegistry())
    .singleton(EventBusToken, () => createEventBus({ clock }))
    .singleton(HooksToken, () => createHooks())

  const app: Application<C> = {
    get state() {
      return state
    },
    container,
    settings,
    config: (path) => getConfigValue(settings as C, path as never) as never,
    make: (t) => container.make(t),

    async boot() {
      if (state !== 'created') throw new Error(`Cannot boot an application in state "${state}"`)
      state = 'booting'
      for (const provider of providers) {
        try {
          const result: unknown = provider.register(app)
          if (result instanceof Promise) {
            result.catch(() => undefined)
            throw new TypeError('register() must be synchronous; do asynchronous work in boot()')
          }
        } catch (error) {
          state = 'failed'
          throw new ProviderError(provider.name, 'register', error)
        }
      }
      for (const provider of providers) {
        try {
          await provider.boot?.(app)
          booted.push(provider)
        } catch (error) {
          state = 'failed'
          throw new ProviderError(provider.name, 'boot', error)
        }
      }
      state = 'booted'
    },

    shutdown(shutdownOptions = {}) {
      // Idempotent: concurrent or repeated calls share one shutdown.
      shutdownPromise ??= runShutdown(shutdownOptions.timeoutMs ?? 10_000)
      return shutdownPromise
    },
  }

  async function runShutdown(timeoutMs: number): Promise<ShutdownReport> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be >= 0')
    state = 'shutting-down'
    const errors: ProviderError[] = []
    const work = (async () => {
      for (const provider of [...booted].reverse()) {
        try {
          await provider.shutdown?.(app)
        } catch (error) {
          errors.push(new ProviderError(provider.name, 'shutdown', error))
        }
      }
      try {
        await container.dispose()
      } catch (error) {
        errors.push(new ProviderError('container', 'shutdown', error))
      }
    })()
    let timer: NodeJS.Timeout | undefined
    const timedOut = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    state = 'stopped'
    return { timedOut, errors: [...errors] }
  }

  return app
}
