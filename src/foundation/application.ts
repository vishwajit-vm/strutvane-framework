/**
 * The application: Laravel's `bootstrap/app.php`, as a fluent builder over the framework's core.
 *
 * ```ts
 * export default Application.configure({ basePath: dirname(import.meta.dirname) })
 *   .withConfig(config)
 *   .withProviders([AppServiceProvider])
 *   .withRouting({ web, api, bindings: { post: Post } })
 *   .withMiddleware((m) => m.validateCsrfTokens({ except: ['api/webhooks/*'] }))
 *   .withExceptions((e) => e.dontReport(PaymentDeclined))
 *   .create()
 * ```
 *
 * **One core, not two.** The application wraps a core application (`core/application.ts`:
 * container with typed tokens, logger, clock, ids, messages, error registry, events, hooks) and
 * runs every provider through it: core `Provider` objects and Laravel-style `ServiceProvider`
 * classes alike, every `register()` before any `boot()`, and shutdown in reverse through the core.
 *
 * `create()` is cheap and does no I/O. The work happens in `boot()` (lazy and idempotent: the
 * first request or command calls it): config and env are validated, the boot guards run,
 * providers register then boot, routes are compiled and *every* route is checked (middleware
 * aliases, abilities, bindings, policies, internal tables), so a mistake fails at start-up and in
 * `node strut route:list`, not on the first request.
 *
 * @module
 */

import { PolicyRegistry, PolicyRegistryToken } from '../auth/policies.ts'
import { CacheManagerToken } from '../cache/contract.ts'
import { CacheDriverRegistry, CacheDriverRegistryToken } from '../cache/drivers.ts'
import { createCacheManager } from '../cache/store.ts'
import type { AnyCommand } from '../console/framework/command.ts'
import type { Actor } from '../contracts/actor.ts'
import {
  HTTP_HOOKS,
  type HttpRequestHookPayload,
  type HttpResponseHookPayload,
} from '../contracts/http-hooks.ts'
import type { Logger } from '../contracts/logger.ts'
import {
  type AppState,
  type Application as CoreApplication,
  createApp,
  type Provider,
  ProviderError,
  type ShutdownReport,
} from '../core/application.ts'
import type { DeepReadonly } from '../core/config.ts'
import type { Container, Token } from '../core/container.ts'
import { currentContext, runWithContext } from '../core/context.ts'
import { NotFoundError, StrutvaneError } from '../core/errors/errors.ts'
import { createMessages, type MessageCatalog } from '../core/messages/catalog.ts'
import { negotiateLocale } from '../core/messages/locale.ts'
import {
  ClockToken,
  ErrorRegistryToken,
  EventBusToken,
  HooksToken,
  IdGeneratorToken,
  LoggerToken,
  MessagesToken,
} from '../core/tokens.ts'
import type { Connection } from '../database/db/connection.ts'
import { runWithConnection } from '../database/db/manager.ts'
import { OrmUsageError } from '../database/orm/errors.ts'
import { type ModelEventDispatcher, runWithModelEvents } from '../database/orm/events.ts'
import { runWithTenant } from '../database/orm/tenancy.ts'
import { ExceptionHandler, ExceptionsConfig } from '../exceptions/handler.ts'
import { ExceptionHandlerToken } from '../exceptions/report.ts'
import { type HttpContext as Ctx, HttpContext, runWithHttpContext } from '../http/app/context.ts'
import { cspReportRoutes } from '../http/app/csp-report.ts'
import { checkCsrf } from '../http/app/csrf.ts'
import type { ExceptionRenderer, ExceptionRequestInfo } from '../http/app/errors.ts'
import {
  corsPreflightStage,
  decorateResponse,
  type KernelStage,
  MaintenanceCheckToken,
  maintenanceStage,
  runStages,
  timeoutStage,
  trustedHostStage,
} from '../http/app/kernel.ts'
import { MemoryCacheStore } from '../http/app/memory-cache.ts'
import {
  buildMiddleware,
  type Middleware,
  MiddlewareConfig,
  MiddlewareConfigToken,
  type MiddlewareReference,
} from '../http/app/middleware.ts'
import { CORE_ALIASES } from '../http/app/protections.ts'
import type { RequestState } from '../http/app/request-state.ts'
import { ResourceController } from '../http/app/resource-controller.ts'
import { isInternalResource } from '../http/app/resource-model.ts'
import {
  type ResolvedRouteMiddleware,
  resolveRouteMiddleware,
} from '../http/app/route-middleware.ts'
import { type RouteSecurityProfile, securityProfile } from '../http/app/security-profile.ts'
import { RateLimitStoreToken, resolveLimiter } from '../http/app/throttle.ts'
import { matchesPathPattern } from '../http/csrf.ts'
import { IdempotencyStoreToken, MemoryIdempotencyStore } from '../http/idempotency.ts'
import { forwardedClient } from '../http/proxy.ts'
import { routerPath } from '../http/router-path.ts'
import { acceptRequestId } from '../http/security.ts'
import {
  type SessionCookie,
  SessionCookieToken,
  sessionCookieName,
} from '../http/session-cookie.ts'
import { appLoggingConfig, asLoggingBootError, createAppLogManager } from '../logging/app.ts'
import { type LoggingConfigResult, resolveLoggingConfig } from '../logging/config.ts'
import { runWithLogContext } from '../logging/context.ts'
import type { LogManager } from '../logging/manager.ts'
import { LogManagerToken } from '../logging/token.ts'
import { checkMaintenance } from '../maintenance/maintenance.ts'
import { applicationMessages, registerApplicationErrors } from '../messages.ts'
import {
  defineRoutes,
  Route,
  type RouteEntry,
  type RoutesSource,
  routeEntries,
} from '../routing/route.ts'
import {
  actionLabel,
  allowedMethods,
  type CompiledFallback,
  type CompiledRoute,
  compileRoutes,
  fallbackFor,
  matchRoute,
} from '../routing/router.ts'
import { UrlGenerator, UrlGeneratorToken } from '../routing/url.ts'
import { type AppFilesystemsConfig, storageFromConfig } from '../runtime/storage-config.ts'
import { checkBootGuards } from '../security/boot-guards.ts'
import { Encrypter, EncrypterToken } from '../security/encrypter.ts'
import { HttpClient, HttpClientToken } from '../security/http.ts'
import { inCidr, parseIp } from '../security/ip.ts'
import { type Keyring, KeyringToken } from '../security/keyring.ts'
import { createCspNonce } from '../security/secure-headers.ts'
import { type ResolvedSecurity, SecurityToken } from '../security/settings.ts'
import {
  MemoryUsedSignatureStore,
  UrlSigner,
  UrlSignerToken,
  UsedSignatureStoreToken,
} from '../security/signer.ts'
import { SessionStoreToken } from '../session/contract.ts'
import { FileSessionStore } from '../session/file-store.ts'
import { createStorageManager } from '../storage/manager.ts'
import { type PublicMount, publicMounts, servePublicFile } from '../storage/public-files.ts'
import { closestMatch } from '../support/str.ts'
import { StorageManagerToken } from '../tokens.ts'
import { BootError, isBootError } from './boot-error.ts'
import type { CacheUse } from './bootstrap-cache.ts'
import {
  fingerprintOnce,
  loadConfigWithCache,
  loadListeners,
  routeCacheUse,
  routeManifest,
} from './cached-boot.ts'
import {
  type ConfigFiles,
  type ConfigRepository,
  ConfigRepositoryToken,
  loadConfig,
} from './config.ts'
import { runInApplication } from './current.ts'
import {
  bindDatabase,
  configureTenancy,
  DatabaseConnectionToken,
  databaseEnv,
  loadSchemaSnapshot,
} from './database.ts'
import { type EnvSource, loadEnvSource } from './env.ts'
import { buildUnchecked } from './inject.ts'
import { ListenerRegistry } from './listeners.ts'
import { spoofedMethod } from './method-spoofing.ts'
import { NavigationRegistry } from './navigation.ts'
import { PackageMessages } from './package-messages.ts'
import { type AnyProvider, isProviderClass, type ServiceProvider } from './provider.ts'

/**
 * A model class route model binding can use: `{post}` → `Post.resolveRouteBinding(value)`, a 404
 * when it returns `null`.
 *
 * @example
 * const bindings: Record<string, BindableModel> = { post: Post }
 */
export interface BindableModel {
  readonly name: string
  resolveRouteBinding(value: string, field?: string): Promise<object | null>
}

/**
 * `withRouting` options, Laravel's `withRouting(web:, api:, health:)`.
 *
 * @example
 * .withRouting({ web, api, health: '/up', bindings: { post: Post } })
 */
export interface RoutingOptions {
  /** `routes/web.ts`: a routes list or a `(router) => { … }` callback. Gets the `web` group. */
  readonly web?: RoutesSource
  /** `routes/api.ts`: gets the `api` group and the `apiPrefix`. */
  readonly api?: RoutesSource
  /** Prefix for API routes. Default `/api`. */
  readonly apiPrefix?: string
  /** The liveness route answering `{"status":"ok"}` (CONSISTENCY #45). Default `/up`. */
  readonly health?: string
  /** Route model binding: a `{post}` parameter is resolved through `Post`, or a 404. */
  readonly bindings?: Readonly<Record<string, BindableModel>>
}

/**
 * What `app.handle()` may know about the connection.
 *
 * @example
 * await app.handle(request, { ip: socket.remoteAddress })
 */
export interface RequestInfo {
  /** The peer address from the socket (never from headers). */
  readonly ip?: string
  /**
   * Run work that must not delay the response (deferred tasks, terminable middleware) after it
   * is sent: the Node adapter passes a function that keeps the promise alive. Without it, that
   * work finishes before `handle()` resolves (deterministic tests).
   */
  readonly waitUntil?: (work: Promise<void>) => void
  /**
   * Test-only switches set by the test client (never by a request): refused unless
   * APP_ENV=testing, so they can never weaken a real deployment.
   */
  readonly testing?: { readonly withoutCsrf?: boolean; readonly actor?: Actor | object }
}

/** Everything the builder collected. */
interface Blueprint {
  readonly basePath: string
  readonly env: EnvSource | undefined
  config: ConfigFiles
  providers: AnyProvider[]
  routing: RoutingOptions
  readonly middleware: ((config: MiddlewareConfig) => void)[]
  readonly exceptions: ((config: ExceptionsConfig) => void)[]
  readonly commands: AnyCommand[]
}

/**
 * The fluent builder returned by {@link Application.configure}.
 *
 * @example
 * Application.configure({ basePath }).withRouting({ api }).create()
 */
export class ApplicationBuilder {
  readonly #blueprint: Blueprint

  constructor(basePath: string, env: EnvSource | undefined) {
    this.#blueprint = {
      basePath,
      env,
      config: {},
      providers: [],
      routing: {},
      middleware: [],
      exceptions: [],
      commands: [],
    }
  }

  /**
   * The config files (`config/index.ts` exports them as one object).
   *
   * @example
   * .withConfig({ app, database })
   */
  withConfig(files: ConfigFiles): this {
    this.#blueprint.config = { ...this.#blueprint.config, ...files }
    return this
  }

  /**
   * The service providers (`bootstrap/providers.ts`): classes and core provider objects.
   *
   * @example
   * .withProviders([AppServiceProvider])
   */
  withProviders(providers: readonly AnyProvider[]): this {
    this.#blueprint.providers = [...this.#blueprint.providers, ...providers]
    return this
  }

  /**
   * Routes files, the health route and model bindings.
   *
   * @example
   * .withRouting({ web, api, bindings: { post: Post } })
   */
  withRouting(options: RoutingOptions): this {
    this.#blueprint.routing = { ...this.#blueprint.routing, ...options }
    return this
  }

  /**
   * Configure middleware aliases, groups, rate limiters, abilities and app-wide security.
   *
   * @example
   * .withMiddleware((m) => m.alias({ admin: EnsureAdmin }).rateLimiter('api', { maxAttempts: 120, decaySeconds: 60 }))
   */
  withMiddleware(configure: (middleware: MiddlewareConfig) => void): this {
    this.#blueprint.middleware.push(configure)
    return this
  }

  /**
   * Configure exception reporting and rendering.
   *
   * @example
   * .withExceptions((e) => e.dontReport(PaymentDeclined))
   */
  withExceptions(configure: (exceptions: ExceptionsConfig) => void): this {
    this.#blueprint.exceptions.push(configure)
    return this
  }

  /**
   * App commands for `node strut` (Laravel's `routes/console.php` / `withCommands`).
   *
   * @example
   * .withCommands([inspire])
   */
  withCommands(commands: readonly AnyCommand[]): this {
    this.#blueprint.commands.push(...commands)
    return this
  }

  /**
   * Build the application. No I/O happens here.
   *
   * @example
   * export default Application.configure({ basePath }).withRouting({ api }).create()
   */
  create(): Application {
    return new Application(this.#blueprint)
  }
}

/** What exists once the app has booted. */
interface BootedState {
  readonly config: ConfigRepository
  readonly environment: string
  readonly showDetails: boolean
  readonly routes: readonly CompiledRoute[]
  readonly fallbacks: readonly CompiledFallback[]
  readonly middleware: ReadonlyMap<CompiledRoute, ResolvedRouteMiddleware>
  readonly security: ResolvedSecurity
  readonly sessionCookie: SessionCookie
  readonly renderer: ExceptionRenderer
  readonly stages: readonly KernelStage[]
  readonly logger: Logger
  readonly apiPrefix: string
}

/** Per-request bookkeeping the kernel needs after the response is built. */
interface RequestRun {
  hookHeaders: Headers | undefined
  route: CompiledRoute | undefined
  readonly terminables: { readonly middleware: Middleware; readonly ctx: Ctx }[]
}

const KERNEL = 'strutvane.kernel'
const KERNEL_CHECKS = 'strutvane.kernel.checks'
const DEFAULT_HEALTH = '/up'
/** How long shutdown waits for queued log records to be written (bounded: a hung disk never hangs the exit). */
const LOG_SHUTDOWN_MS = 2_000

/**
 * A Strutvane application. One per process normally; tests create as many as they like.
 *
 * @example
 * const response = await app.handle(new Request('http://localhost/up'))
 */
export class Application implements CoreApplication<object> {
  /** The project root (`bootstrap/..`). */
  readonly basePath: string
  /** Navigation entries from the app and packages, for the sidebar. */
  readonly navigation: NavigationRegistry = new NavigationRegistry()
  /** Listeners (discovered in app/listeners, or from bootstrap/cache/events.json). */
  readonly events: ListenerRegistry
  /** What boot did with each bootstrap cache: used, ignored (stale, other key, tampered) or none. */
  cacheStatus: Readonly<Record<'config' | 'routes' | 'events', CacheUse>> = {
    config: 'none',
    routes: 'none',
    events: 'none',
  }
  readonly #blueprint: Blueprint
  readonly #core: CoreApplication<object>
  readonly #middleware = new MiddlewareConfig()
  readonly #exceptions = new ExceptionsConfig()
  readonly #extraRoutes: {
    readonly source: RoutesSource
    readonly prefix: string
    readonly group: string | undefined
  }[] = []
  readonly #commands = new Map<string, AnyCommand>()
  #config: ConfigRepository | undefined
  #state: BootedState | undefined
  #booting: Promise<void> | undefined
  #registering = false
  #forceDebug = false
  /** The ORM's tenant column once boot read the tenancy switch; `undefined` = single-tenant. */
  #tenantColumn: string | undefined
  /** The merged environment (process env, `.env`, the `env` option), read once at boot. */
  #env: EnvSource | undefined
  /** Message catalogs packages added with {@link Application.addMessages}. */
  readonly #packageMessages = new PackageMessages()
  /** Model events (`post.created`, …) go to this app's event bus, after commit. */
  readonly #modelEvents: ModelEventDispatcher = {
    wants: (type) => this.make(EventBusToken).listenerCount(type) > 0,
    dispatch: async (type, payload, tenantId) => {
      const actor = currentContext()?.actor
      await this.make(EventBusToken).emit(type, payload, {
        ...(tenantId === undefined ? {} : { tenantId }),
        ...(actor !== null &&
        actor !== undefined &&
        typeof actor.id === 'string' &&
        typeof actor.type === 'string'
          ? { actor: { id: actor.id, type: actor.type } }
          : {}),
      })
    },
  }

  constructor(blueprint: Blueprint) {
    this.#blueprint = blueprint
    this.basePath = blueprint.basePath
    this.events = new ListenerRegistry(blueprint.basePath)
    for (const command of blueprint.commands) this.#commands.set(command.name, command)
    this.#core = createApp({
      config: {},
      providers: [
        { name: KERNEL, register: () => undefined, boot: () => this.#bootKernel() },
        ...blueprint.providers.map((provider) => this.#adapt(provider)),
        { name: KERNEL_CHECKS, register: () => undefined, boot: () => this.#bootChecks() },
      ],
    })
    // Before any provider runs, so both can be used (or rebound) in register().
    this.#core.container.singleton(MessagesToken, () =>
      this.#packageMessages.over(createMessages()),
    )
    this.#core.container.value(CacheDriverRegistryToken, new CacheDriverRegistry())
    // Logging (ADR-0022): the log manager replaces core's stdout fallback as the app's Logger. It
    // is built on first use (the kernel resolves it at boot, after config/logging.ts is loaded),
    // a provider or a test may still rebind LoggerToken, and it is closed (drained, bounded) when
    // the container is disposed: the very last step of shutdown, after every provider stopped,
    // so their shutdown messages are written too.
    this.#core.container
      .singleton(LogManagerToken, () => this.#createLogManager(), {
        dispose: async (manager) => {
          await manager.close(LOG_SHUTDOWN_MS)
        },
      })
      .singleton(LoggerToken, (resolver) => resolver.make(LogManagerToken))
  }

  /**
   * The resolved `config/logging.ts` (channels with every `.env` default applied) and the `.env`
   * problems found, without booting the app. The log commands (`log:tail`, `log:list`,
   * `log:clear`) use it, so they work even when the app can't boot.
   *
   * @example
   * app.loggingConfig().config.channels.daily // { driver: 'daily', dir: '/srv/blog/storage/logs', … }
   */
  loggingConfig(): LoggingConfigResult {
    const config = this.#config ?? this.loadFreshConfig()
    const env = this.#env ?? loadEnvSource(this.basePath, this.#blueprint.env)
    const logging = config.has('logging') ? config.get('logging') : undefined
    const appEnv = config.string('app.env', env['APP_ENV'] ?? 'production')
    try {
      return resolveLoggingConfig(appLoggingConfig(logging), {
        env: { ...env, APP_ENV: appEnv },
        root: this.basePath,
      })
    } catch (error) {
      throw asLoggingBootError(error)
    }
  }

  /** The app's log manager, from `config/logging.ts` and the app's environment. */
  #createLogManager(): LogManager {
    const env = this.#env ?? loadEnvSource(this.basePath, this.#blueprint.env)
    const config = this.#config
    const appEnv = config?.string('app.env', env['APP_ENV'] ?? 'production')
    return createAppLogManager({
      config: config?.has('logging') === true ? config.get('logging') : undefined,
      env,
      root: this.basePath,
      ...(appEnv === undefined ? {} : { appEnv }),
    })
  }

  /**
   * Start building an app, Laravel's `Application::configure(basePath: …)`.
   *
   * @example
   * Application.configure({ basePath: '/srv/blog', env: { APP_ENV: 'testing' } })
   */
  static configure(options: {
    readonly basePath: string
    readonly env?: EnvSource
  }): ApplicationBuilder {
    return new ApplicationBuilder(options.basePath, options.env)
  }

  /** The container (the core application's). Bind test doubles here before boot. */
  get container(): Container {
    return this.#core.container
  }

  /** The core lifecycle state: created, booting, booted, failed, shutting-down, stopped. */
  get state(): AppState {
    return this.#core.state
  }

  /** The whole (frozen) config tree. Throws before boot. */
  get settings(): DeepReadonly<object> {
    return this.configRepository.all
  }

  /**
   * Read a config value by dot path (the core's `app.config()`); unknown paths throw. Use the
   * typed `config()` helper in app code.
   *
   * @example
   * app.config('app.name') // 'Blog'
   */
  config(path: string): unknown {
    return this.configRepository.get(path)
  }

  /** The loaded config repository. Throws before boot. */
  get configRepository(): ConfigRepository {
    if (this.#config !== undefined) return this.#config
    throw notBooted('app.configRepository')
  }

  /**
   * Resolve from the container.
   *
   * @example
   * const logger = app.make(LoggerToken)
   */
  make<TValue>(key: Token<TValue>): TValue {
    return this.#core.container.make(key)
  }

  /** The URL generator. Throws before boot. */
  get url(): UrlGenerator {
    this.#booted('app.url')
    return this.make(UrlGeneratorToken)
  }

  /** The compiled route table, in match order. Throws before boot. */
  get routes(): readonly CompiledRoute[] {
    return this.#booted('app.routes').routes
  }

  /** The fallback routes (one per routes file at most). Throws before boot. */
  get fallbacks(): readonly CompiledRoute[] {
    return this.#booted('app.fallbacks').fallbacks.map((fallback) => fallback.route)
  }

  /** The middleware configuration (aliases, groups, limiters, abilities). */
  get middleware(): MiddlewareConfig {
    return this.#middleware
  }

  /** The checked security settings. Throws before boot. */
  get security(): ResolvedSecurity {
    return this.#booted('app.security').security
  }

  /**
   * The middleware a route runs after every style was applied, plus the opt-outs that shaped it.
   * `route:list --security` prints this.
   *
   * @example
   * app.routeMiddleware(app.routes[0]).optOuts // [{ alias: 'csrf', source: 'route' }]
   */
  routeMiddleware(route: CompiledRoute): ResolvedRouteMiddleware {
    const resolved = this.#booted('app.routeMiddleware()').middleware.get(route)
    if (resolved !== undefined) return resolved
    throw new BootError(
      'unknown_route',
      `${route.uri} is not one of this app's routes.`,
      'Pass a route from app.routes.',
    )
  }

  /**
   * The security view of a route: protections, opt-outs (with where they were written) and
   * warnings, for `route:list --security`.
   *
   * @example
   * app.securityProfile(app.routes[0]).warnings // ['unsafe method with no CSRF check']
   */
  securityProfile(route: CompiledRoute): RouteSecurityProfile {
    return securityProfile(route, this.routeMiddleware(route), this.security)
  }

  /** `APP_ENV`: `local`, `testing`, `staging` or `production`. Throws before boot. */
  get environment(): string {
    return this.#booted('app.environment').environment
  }

  /** `true` when debug details may be shown: APP_DEBUG and a local or testing environment. */
  get showsDebugDetails(): boolean {
    return this.#booted('app.showsDebugDetails').showDetails
  }

  /** Every console command the app and its packages added. */
  get commands(): readonly AnyCommand[] {
    return [...this.#commands.values()]
  }

  /**
   * Add routes from a package's provider (call it in `register()`). They get their own prefix and
   * middleware group.
   *
   * @example
   * app.addRoutes(billingRoutes, { prefix: '/api/billing', group: 'api' })
   */
  addRoutes(
    source: RoutesSource,
    options: { readonly prefix?: string; readonly group?: string } = {},
  ): void {
    if (this.#state !== undefined || (this.#booting !== undefined && !this.#registering))
      throw new BootError(
        'routes_after_boot',
        'Routes were added after the app compiled its routes, so they would never be matched.',
        "Call app.addRoutes() in a provider's register() method.",
      )
    this.#extraRoutes.push({ source, prefix: options.prefix ?? '', group: options.group })
  }

  /**
   * Add a console command from a package's provider.
   *
   * @example
   * app.addCommand(billingSyncCommand)
   */
  addCommand(command: AnyCommand): void {
    this.#commands.set(command.name, command)
  }

  /**
   * Run code with this app as the current one, so `route()`, `config()` and the facades work
   * (tests and scripts use it; requests and commands get it automatically).
   *
   * @example
   * const link = await app.run(() => route('posts.index'))
   */
  run<TResult>(work: () => TResult): TResult {
    return this.#scope(work)
  }

  /**
   * Run `work` as this app: helpers and facades find it, and models use its database connection
   * (opened on the first query), never another app's in the same process.
   */
  #scope<TResult>(work: () => TResult): TResult {
    return runInApplication(this, () =>
      runWithConnection(
        () => this.#connection(),
        () => runWithModelEvents(this.#modelEvents, work),
      ),
    )
  }

  /** The app's connection, for the ORM; a friendly error before the kernel bound it. */
  #connection(): Connection {
    if (this.container.has(DatabaseConnectionToken)) return this.make(DatabaseConnectionToken)
    throw new OrmUsageError(
      'no_connection',
      "The database connection is bound when the app boots, so models can't query before that (for example in a provider's register()). Query from boot(), a request or a command; `await app.boot()` first in scripts and tests.",
    )
  }

  /**
   * Read an environment variable: the merged environment the config files saw (process
   * environment, `.env`, and the `env` option of `Application.configure`). Works from the start of
   * boot, so a provider can read a secret in `register()` without putting it in the config tree
   * (where `config:cache` would write it to disk). `undefined` when unset.
   *
   * @example
   * override register(app: Application): void {
   *   const password = app.env('REDIS_PASSWORD')
   * }
   */
  env(name: string): string | undefined {
    const env = this.#env
    if (env === undefined) throw notBooted('app.env()')
    return Object.hasOwn(env, name) ? env[name] : undefined
  }

  /**
   * Add a package's message catalogs (RFC-0003): its error titles and texts in every language it
   * ships. Call it in a provider's `register()` or `boot()`. Package messages only fill keys the
   * app and the framework don't define, so an app can always reword them in its own catalog.
   *
   * @example
   * override register(app: Application): void {
   *   app.addMessages(REDIS_MESSAGES_EN, REDIS_MESSAGES_PT)
   * }
   */
  addMessages(...catalogs: readonly MessageCatalog[]): void {
    this.#packageMessages.add(catalogs)
  }

  /**
   * Allow booting with APP_DEBUG=true in production (the `--force-debug` flag). Without it the boot
   * guard refuses that combination (CONSISTENCY #19). Call it before the app boots.
   *
   * @example
   * app.forceDebug()
   */
  forceDebug(): this {
    if (this.#booting !== undefined)
      throw new BootError(
        'force_debug_after_boot',
        'forceDebug() was called after the app started booting.',
        'Call it before the first request or command (node strut does it for --force-debug).',
      )
    this.#forceDebug = true
    return this
  }

  /**
   * Boot once: config, guards, providers, routes and every start-up check. Safe to call many
   * times (the first call's outcome is shared).
   *
   * @example
   * await app.boot()
   */
  async boot(): Promise<void> {
    this.#booting ??= this.#boot()
    await this.#booting
  }

  /**
   * Build the config from the config files and the environment, ignoring any config cache.
   * `config:cache` uses it, so a cache is always built from the real files.
   *
   * @example
   * const fresh = app.loadFreshConfig()
   */
  loadFreshConfig(): ConfigRepository {
    return loadConfig(this.#blueprint.config, loadEnvSource(this.basePath, this.#blueprint.env))
  }

  /**
   * Stop: providers shut down in reverse, then the container is disposed (the core's shutdown,
   * bounded by a timeout).
   *
   * @example
   * await app.shutdown()
   */
  shutdown(options?: { readonly timeoutMs?: number }): Promise<ShutdownReport> {
    return this.#core.shutdown(options)
  }

  // -------------------------------------------------------------------------------------------
  // Boot.

  async #boot(): Promise<void> {
    const source = loadEnvSource(this.basePath, this.#blueprint.env)
    this.#env = source
    const fingerprint = fingerprintOnce(this.basePath)
    // Warnings wait in a buffer: resolving the logger now would stop a provider from replacing it.
    const pending: string[] = []
    const buffer = { warn: (message: string): void => void pending.push(message) }
    const loaded = loadConfigWithCache(
      this.basePath,
      this.#blueprint.config,
      source,
      buffer,
      fingerprint,
    )
    const config = loaded.config
    this.#config = config
    const environment = config.string('app.env', source['APP_ENV'] ?? 'production')
    const debug = config.boolean('app.debug', false)
    const guards = checkBootGuards({
      environment,
      debug,
      appKey: configText(config, 'app.key') ?? source['APP_KEY'],
      previousKeys: configText(config, 'app.previous_keys') ?? source['APP_PREVIOUS_KEYS'] ?? '',
      forceDebug: this.#forceDebug,
    })
    pending.push(...guards.warnings)
    const showDetails = debug && (environment === 'local' || environment === 'testing')
    if (debug && !showDetails)
      pending.push(
        'APP_DEBUG=true is ignored outside local and testing environments; errors stay plain.',
      )
    const container = this.container
    container.value(ConfigRepositoryToken, config)
    if (!container.has(KeyringToken)) container.value(KeyringToken, guards.keyring)
    container.value(MiddlewareConfigToken, this.#middleware)
    for (const configure of this.#blueprint.middleware) configure(this.#middleware)
    for (const configure of this.#blueprint.exceptions) configure(this.#exceptions)
    this.#registerCoreMiddleware()
    this.#pending = {
      pending,
      fingerprint,
      config,
      environment,
      showDetails,
      loaded: loaded.use,
      env: source,
    }
    try {
      this.#registering = true
      await this.#scope(() => this.#core.boot())
    } catch (error) {
      throw unwrapProviderError(error)
    } finally {
      this.#registering = false
      this.#pending = undefined
    }
  }

  #pending:
    | {
        readonly pending: readonly string[]
        readonly fingerprint: () => string
        readonly config: ConfigRepository
        readonly environment: string
        readonly showDetails: boolean
        readonly loaded: CacheUse
        readonly env: EnvSource
      }
    | undefined

  /** The first boot step, after every provider registered: defaults, security, routes. */
  async #bootKernel(): Promise<void> {
    this.#registering = false
    const boot = this.#pending
    if (boot === undefined) throw notBooted('kernel boot')
    const { config, environment, showDetails } = boot
    const container = this.container
    const logger = container.make(LoggerToken)
    for (const warning of boot.pending) logger.warn(warning)
    const keyring = container.make(KeyringToken)
    const clock = container.make(ClockToken)
    this.#bindDefaults(keyring)
    const publicFiles = this.#bindStorage(config, boot.env)
    // The data layer: the schema and tenancy for the ORM now, the connection on the first query.
    loadSchemaSnapshot(this.basePath)
    this.#tenantColumn = await configureTenancy(this.basePath, config)
    bindDatabase(container, {
      basePath: this.basePath,
      env: () => databaseEnv(config, boot.env, environment),
    })
    const appUrl = config.string('app.url', 'http://localhost')
    const sessionCookie = container.has(SessionCookieToken)
      ? container.make(SessionCookieToken)
      : sessionCookieName({
          ...(config.has('session.cookie') ? { base: String(config.get('session.cookie')) } : {}),
          secure: appUrl.startsWith('https:'),
        })
    if (!container.has(SessionCookieToken)) container.value(SessionCookieToken, sessionCookie)
    const security = this.#middleware.security.resolve({
      appUrl,
      environment,
      keyring,
      sessionCookie,
    })
    container.value(SecurityToken, security)
    const errors = container.make(ErrorRegistryToken)
    registerApplicationErrors(errors)
    const messages = applicationMessages(container.make(MessagesToken))
    const renderer = new ExceptionHandler(this.#exceptions, {
      showDetails,
      environment,
      basePath: this.basePath,
      logger,
      messages,
      errors,
      now: () => clock.now(),
    })
    container.value(ExceptionHandlerToken, renderer)
    const apiPrefix = this.#blueprint.routing.apiPrefix ?? '/api'
    const { routes, fallbacks } = this.#compileRoutes(apiPrefix)
    const middleware = new Map<CompiledRoute, ResolvedRouteMiddleware>()
    for (const route of [...routes, ...fallbacks.map((fallback) => fallback.route)])
      middleware.set(route, resolveRouteMiddleware(route, this.#middleware))
    container.value(
      UrlGeneratorToken,
      new UrlGenerator(routes, {
        appUrl,
        signer: () => container.make(UrlSignerToken),
        now: () => clock.now(),
      }),
    )
    const stages: KernelStage[] = [trustedHostStage(security)]
    // Public disks (`/storage/…`) right after the host check: like files a web server serves,
    // they stay readable during maintenance, and never reach the router or its middleware.
    if (publicFiles.length > 0)
      stages.push(async (ctx, next) => (await servePublicFile(ctx.request, publicFiles)) ?? next())
    if (container.has(MaintenanceCheckToken))
      stages.push(
        maintenanceStage(container.make(MaintenanceCheckToken), {
          basePath: this.basePath,
          keyring,
          healthPath: this.#blueprint.routing.health ?? DEFAULT_HEALTH,
          now: () => clock.now(),
          secureCookies: environment === 'production',
        }),
      )
    stages.push(corsPreflightStage(security), timeoutStage(this.#middleware.timeoutMs))
    this.#state = {
      config,
      environment,
      showDetails,
      routes,
      fallbacks,
      middleware,
      security,
      sessionCookie,
      renderer,
      stages,
      logger,
      apiPrefix,
    }
    warnUnmatchedCsrfExceptions(security, routes, logger)
    const routeUse = routeCacheUse(
      this.basePath,
      keyring,
      logger,
      routeManifest(routes, (route) => this.routeMiddleware(route)).hash,
      boot.fingerprint,
    )
    const listeners = await loadListeners(this.basePath, keyring, logger, boot.fingerprint)
    this.events.useDiscovered(listeners.entries)
    this.events.attach(container.make(EventBusToken), container)
    this.cacheStatus = { config: boot.loaded, routes: routeUse, events: listeners.use }
  }

  /** The last boot step, after every provider booted: the route checks (unless a route cache vouches). */
  async #bootChecks(): Promise<void> {
    if (this.cacheStatus.routes === 'used') return
    await this.#checkRoutes()
  }

  /** Bindings every app has. Defaults only fill gaps: a provider's binding wins. */
  #bindDefaults(keyring: Keyring): void {
    const container = this.container
    const clock = container.make(ClockToken)
    const fill = <TValue>(key: Token<TValue>, make: () => TValue): void => {
      if (!container.has(key)) container.singleton(key, make)
    }
    fill(EncrypterToken, () => new Encrypter(keyring))
    fill(UsedSignatureStoreToken, () => new MemoryUsedSignatureStore({ now: () => clock.now() }))
    fill(
      UrlSignerToken,
      () => new UrlSigner(keyring, { usedSignatures: container.make(UsedSignatureStoreToken) }),
    )
    fill(HttpClientToken, () => new HttpClient())
    fill(MaintenanceCheckToken, () => checkMaintenance)
    fill(CacheManagerToken, () => {
      const drivers = container.make(CacheDriverRegistryToken)
      drivers.seal()
      return createCacheManager({
        basePath: this.basePath,
        clock,
        config: this.configRepository.has('cache') ? this.configRepository.get('cache') : undefined,
        drivers: drivers.factories,
      })
    })
    fill(SessionStoreToken, () => new FileSessionStore(this.basePath))
    fill(IdempotencyStoreToken, () => new MemoryIdempotencyStore())
    fill(RateLimitStoreToken, () =>
      container.has(CacheManagerToken)
        ? container.make(CacheManagerToken).store()
        : new MemoryCacheStore({ clock }),
    )
    fill(PolicyRegistryToken, () => new PolicyRegistry(this.basePath, container))
  }

  /**
   * The storage disks from `config/filesystems.ts` (a default private `local` disk without it),
   * unless a provider bound its own manager (`@strutvane/files`), and the public disks to serve.
   * A bad disk config stops the boot, naming the setting.
   */
  #bindStorage(config: ConfigRepository, env: EnvSource): readonly PublicMount[] {
    const container = this.container
    const raw = config.has('filesystems') ? config.get('filesystems') : undefined
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw)))
      throw new BootError(
        'invalid_filesystems_config',
        'config/filesystems.ts must export an object such as { default, disks }.',
        "Example: defineConfig((env) => ({ default: env.string('FILESYSTEM_DISK', 'local'), disks: { local: { driver: 'local', root: 'storage/app' } } }))",
      )
    const settings = raw as AppFilesystemsConfig | undefined
    if (!container.has(StorageManagerToken)) {
      let storage: ReturnType<typeof storageFromConfig>
      try {
        storage = storageFromConfig(settings, {
          root: this.basePath,
          appKey: configText(config, 'app.key') ?? env['APP_KEY'],
        })
      } catch (error) {
        throw new BootError(
          'invalid_filesystems_config',
          error instanceof Error ? error.message : String(error),
          'Fix the disk in config/filesystems.ts: drivers are local and memory (cloud disks come from @strutvane/files), and default must name a disk.',
        )
      }
      container.value(StorageManagerToken, createStorageManager(storage))
    }
    const manager = container.make(StorageManagerToken)
    const disks =
      typeof settings?.disks === 'object' && settings.disks !== null ? settings.disks : {}
    return publicMounts(
      disks,
      manager.names().map((name) => manager.disk(name)),
    )
  }

  /** The core aliases and groups. App aliases can't take a core name (that would swap a protection). */
  #registerCoreMiddleware(): void {
    for (const [alias, middlewareClass] of Object.entries(CORE_ALIASES)) {
      const existing = this.#middleware.resolveAlias(alias)
      if (existing !== undefined && existing !== middlewareClass)
        throw new BootError(
          'reserved_middleware_alias',
          `"${alias}" is a framework middleware alias and can't be replaced.`,
          'Give your middleware another alias; the framework protections keep their names so route:list --security stays true.',
        )
    }
    this.#middleware.alias(CORE_ALIASES)
    this.#middleware.prependToGroup('web', 'csrf')
    this.#middleware.prependToGroup('api', 'csrf', 'throttle:api')
  }

  #compileRoutes(apiPrefix: string): ReturnType<typeof compileRoutes> {
    const { web, api, health } = this.#blueprint.routing
    const extra: { entries: readonly RouteEntry[]; prefix: string; group: string | undefined }[] =
      this.#extraRoutes.map((route) => ({
        entries: routeEntries(route.source),
        prefix: route.prefix,
        group: route.group,
      }))
    extra.push({ entries: cspReportRoutes().entries, prefix: '', group: undefined })
    extra.push({
      entries: defineRoutes([
        Route.get(health ?? DEFAULT_HEALTH, (ctx) => ctx.json({ status: 'ok' })),
      ]).entries,
      prefix: '',
      group: undefined,
    })
    return compileRoutes({
      ...(web === undefined ? {} : { web: routeEntries(web) }),
      ...(api === undefined ? {} : { api: routeEntries(api) }),
      apiPrefix,
      extra,
    })
  }

  /**
   * The start-up checks (security review F-01, F-11): abilities and limiters exist, signed routes
   * are named, every `{param:field}` has a binding, every controller action exists, resource
   * controllers have a policy and never serve an internal table.
   */
  async #checkRoutes(): Promise<void> {
    const { routes, middleware, fallbacks } = this.#booted('checkRoutes')
    const bindings = this.#blueprint.routing.bindings ?? {}
    for (const route of [...routes, ...fallbacks.map((fallback) => fallback.route)]) {
      const where = `${route.methods.join('|')} ${route.uri}`
      for (const reference of middleware.get(route)?.references ?? [])
        this.#checkReference(reference, route, where)
      for (const parameter of route.parameters) {
        if (parameter.field !== undefined && bindings[parameter.name] === undefined)
          throw new BootError(
            'missing_binding',
            `${route.uri} binds {${parameter.name}:${parameter.field}}, but no model is bound to "${parameter.name}".`,
            `Add it in bootstrap/app.ts: withRouting({ bindings: { ${parameter.name}: YourModel } }).`,
          )
      }
      if (route.action.kind === 'controller') await this.#checkController(route, where)
    }
  }

  #checkReference(reference: MiddlewareReference, route: CompiledRoute, where: string): void {
    if (reference.alias === 'can') {
      const ability = reference.params[0]
      if (ability !== undefined && this.#middleware.ability(ability) !== undefined) return
      const suggestion =
        ability === undefined ? undefined : closestMatch(ability, this.#middleware.abilityNames)
      throw new BootError(
        'unknown_ability',
        `${where} uses can:${ability ?? ''}, but no such ability is defined.`,
        suggestion === undefined
          ? `Define it in bootstrap/app.ts: withMiddleware((m) => m.defineAbility('${ability ?? 'name'}', (user) => …)).`
          : `Did you mean "${suggestion}"?`,
      )
    }
    if (reference.alias === 'throttle') resolveLimiter(reference.params, this.#middleware)
    if (reference.alias === 'signed' && route.name === undefined)
      throw new BootError(
        'signed_route_without_name',
        `${where} uses the signed middleware but has no name.`,
        "Name the route (.name('downloads.show')): signed links are bound to the route name.",
      )
  }

  async #checkController(route: CompiledRoute, where: string): Promise<void> {
    if (route.action.kind !== 'controller') return
    const { controller: controllerClass, method } = route.action
    const controller = this.#scope(() => buildUnchecked(this.container, controllerClass)) as Record<
      string,
      unknown
    >
    if (typeof controller[method] !== 'function')
      throw new BootError(
        'missing_action',
        `${actionLabel(route.action)} doesn't exist (${where}).`,
        `Add a ${method}(ctx: HttpContext) method to ${controllerClass.name}.`,
      )
    if (!(controller instanceof ResourceController)) {
      if (route.resourceAction !== undefined && typeof controller['policy'] !== 'object')
        throw new BootError(
          'resource_without_policy',
          `${controllerClass.name} serves resource routes but has no policy.`,
          'Give it a `protected readonly policy = new PostPolicy()` and call authorize() in every action, or extend ResourceController.',
        )
      return
    }
    const resource = controller.resourceMetadata()
    if (isInternalResource(resource))
      throw new BootError(
        'internal_table_exposed',
        `${controllerClass.name} would serve the internal "${resource.table}" table over the API.`,
        'Framework and identity tables (sessions, tokens, roles, jobs, users…) are never auto resources. Write a purpose-built controller with explicit fields instead.',
      )
    const model = controller.resourceModel()
    const bindings = this.#blueprint.routing.bindings ?? {}
    for (const parameter of route.parameters)
      if (bindings[parameter.name] === undefined)
        throw new BootError(
          'missing_binding',
          `${route.uri} needs the {${parameter.name}} parameter bound to a model.`,
          `Add it in bootstrap/app.ts: withRouting({ bindings: { ${parameter.name}: ${model.name} } }).`,
        )
    if (controller.explicitPolicy() !== undefined) return
    const policy = await this.make(PolicyRegistryToken).discover(model)
    if (policy === undefined)
      throw new BootError(
        'missing_policy',
        `${controllerClass.name} serves ${model.name} but no policy was found for it.`,
        `Create app/policies/${model.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.policy.ts (node strut make:policy ${model.name}), or set \`protected readonly policy\` on the controller.`,
      )
  }

  /** Adapt a provider class or core provider object to the core lifecycle. */
  #adapt(provider: AnyProvider): Provider {
    if (isProviderClass(provider)) {
      const instance: ServiceProvider = new provider()
      return {
        name: provider.name,
        register: () => {
          const result: unknown = instance.register(this)
          if (result instanceof Promise) {
            result.catch(() => undefined)
            throw new BootError(
              'async_register',
              `${provider.name}.register() returned a Promise.`,
              'register() only binds services and must be synchronous; do asynchronous work in boot().',
            )
          }
        },
        boot: () => instance.boot(this),
        shutdown: () => instance.shutdown(this),
      }
    }
    if (
      typeof provider === 'object' &&
      provider !== null &&
      typeof provider.register === 'function'
    ) {
      return {
        name: provider.name,
        register: () => provider.register(this),
        ...(provider.boot === undefined ? {} : { boot: () => provider.boot?.(this) }),
        ...(provider.shutdown === undefined ? {} : { shutdown: () => provider.shutdown?.(this) }),
      }
    }
    throw new BootError(
      'invalid_provider',
      `${String(provider)} is not a service provider.`,
      'List ServiceProvider classes or core provider objects ({ name, register, boot? }) in bootstrap/providers.ts.',
    )
  }

  // -------------------------------------------------------------------------------------------
  // Requests.

  /**
   * Handle one HTTP request: the app's `fetch` handler (the Node adapter, tests, any runtime).
   *
   * @example
   * const response = await app.handle(new Request('http://localhost/up'))
   */
  async handle(request: Request, info: RequestInfo = {}): Promise<Response> {
    await this.boot()
    const booted = this.#booted('app.handle()')
    const state = this.#requestState(request, info, booted)
    const ctx = new HttpContext({ request, state, sessionCookie: booted.sessionCookie })
    const run: RequestRun = { hookHeaders: undefined, route: undefined, terminables: [] }
    // A fresh log scope per request: `Log.withContext()` adds to this request only (ADR-0022 §7).
    // The request id is in the core context from the first stage on, so a record written before
    // routing (a maintenance stage, a hook, the error report of an early failure) carries it; the
    // router later adds the actor and the tenant.
    const ids = { requestId: state.requestId, traceId: state.requestId }
    return runWithLogContext({}, () =>
      runWithContext(ids, () => this.#handleIn(ctx, request, info, run, booted)),
    )
  }

  #handleIn(
    ctx: Ctx,
    request: Request,
    info: RequestInfo,
    run: RequestRun,
    booted: BootedState,
  ): Promise<Response> {
    return this.#scope(() =>
      runWithHttpContext(ctx, async () => {
        let response: Response
        try {
          response = await runStages(booted.stages, ctx, () => this.#route(ctx, run, info, booted))
        } catch (error) {
          response = await booted.renderer.render(error, this.#errorInfo(ctx, run))
        }
        response = decorateResponse(response, ctx, booted.security, {
          environment: booted.environment,
          hookHeaders: run.hookHeaders,
        })
        if (request.method === 'HEAD') response = new Response(null, response)
        await this.#reportResponse(ctx, response, run, booted)
        const after = this.#afterResponse(ctx, response, run, booted.logger)
        if (info.waitUntil === undefined) await after
        else info.waitUntil(after)
        return response
      }),
    )
  }

  #requestState(request: Request, info: RequestInfo, booted: BootedState): RequestState {
    const testing = info.testing
    if (
      (testing?.withoutCsrf === true || testing?.actor !== undefined) &&
      booted.environment !== 'testing'
    )
      throw new BootError(
        'testing_only',
        `withoutCsrf()/actingAs() was used with APP_ENV=${booted.environment}.`,
        'They are test helpers: they only work when APP_ENV=testing, so they can never weaken a real deployment.',
      )
    const client = forwardedClient(info.ip, request, booted.security.proxies)
    const messages = this.make(MessagesToken)
    const ids = this.make(IdGeneratorToken)
    return {
      ip: client.ip ?? 'unknown',
      secure: client.secure,
      host: client.host,
      nonce: createCspNonce(),
      limits: booted.security.limits,
      skipCsrf: testing?.withoutCsrf === true,
      requestId: acceptRequestId(
        request.headers.get('x-request-id') ?? undefined,
        () => ids(),
        trustsPeer(info.ip, booted.security),
      ),
      locale: negotiateLocale(
        request.headers.get('accept-language') ?? undefined,
        messages.locales(),
      ),
      method: request.method.toUpperCase(),
      apiPrefix: booted.apiPrefix,
    }
  }

  /** Spoofing, matching, the early CSRF check, the request hooks, then the route or a 404/405. */
  async #route(
    ctx: Ctx,
    run: RequestRun,
    info: RequestInfo,
    booted: BootedState,
  ): Promise<Response> {
    const method = await spoofedMethod(ctx.request)
    const path = routerPath(ctx.request)
    const matched = matchRoute(booted.routes, method, path)
    const allowed = matched === undefined ? allowedMethods(booted.routes, path) : []
    const fallback =
      matched === undefined && allowed.length === 0 && (method === 'GET' || method === 'HEAD')
        ? fallbackFor(booted.fallbacks, path)
        : undefined
    const route = matched?.route ?? fallback?.route
    const resolved = route === undefined ? undefined : booted.middleware.get(route)
    run.route = route
    // Before the hooks: a route a hook answers itself (sign-in) is covered too (CONSISTENCY #125).
    if (
      resolved === undefined ||
      resolved.references.some((reference) => reference.alias === 'csrf')
    )
      await checkCsrf(ctx, booted.security)
    const hooks = this.make(HooksToken)
    const testingActor = (info.testing?.actor ?? null) as Actor | null
    const initial: HttpRequestHookPayload = {
      request: ctx.request,
      actor: testingActor,
      tenant: undefined,
      ...(ctx.ip === 'unknown' ? {} : { clientAddress: ctx.ip }),
    }
    const hooked = ((await hooks.run(HTTP_HOOKS.request, initial)) ??
      initial) as HttpRequestHookPayload
    run.hookHeaders = hooked.headers
    const actor = hooked.actor ?? testingActor
    ctx.user = actor as Ctx['user']
    if (hooked.tenant !== undefined) ctx.tenant = hooked.tenant
    if (hooked.response instanceof Response)
      return new Response(hooked.response.body, hooked.response)
    return runWithContext(
      {
        requestId: ctx.state.requestId,
        traceId: ctx.state.requestId,
        locale: ctx.state.locale,
        actor,
        ...(hooked.tenant === undefined ? {} : { tenant: hooked.tenant }),
      },
      () =>
        this.#asTenant(hooked.tenant?.id, async () => {
          if (route === undefined || resolved === undefined) {
            if (allowed.length > 0)
              throw new StrutvaneError('method_not_allowed', {
                status: 405,
                headers: { Allow: allowed.join(', ') },
              })
            throw new NotFoundError()
          }
          const routed = ctx.forRoute(
            { name: route.name, method, uri: route.uri, action: actionLabel(route.action) },
            matched?.params ?? { fallbackPlaceholder: path },
            { ...ctx.state, method },
          )
          // The routed context becomes current: `Route.current()` and `report()` see the route.
          return runWithHttpContext(routed, () =>
            this.#dispatch(route, resolved.references, routed, run),
          )
        }),
    )
  }

  /**
   * With tenancy on, run `work` as the request's tenant, so every model query in it is scoped to
   * that tenant (and, on PostgreSQL, row-level security sees it). A request without a tenant runs
   * unscoped: tenant tables then refuse to be queried (fail closed, the ORM's rule).
   */
  #asTenant<TResult>(tenantId: string | undefined, work: () => TResult): TResult {
    if (this.#tenantColumn === undefined || tenantId === undefined) return work()
    return runWithTenant(tenantId, work)
  }

  async #dispatch(
    route: CompiledRoute,
    references: readonly MiddlewareReference[],
    ctx: Ctx,
    run: RequestRun,
  ): Promise<Response> {
    const next = async (index: number): Promise<Response> => {
      const reference = references[index]
      if (reference === undefined) {
        // Binding runs after middleware (Laravel's SubstituteBindings): a guest gets 401 before
        // learning whether a record exists.
        await this.#bindModels(route, ctx)
        return this.#invoke(route, ctx)
      }
      const middlewareClass = this.#middleware.resolveAlias(reference.alias)
      if (middlewareClass === undefined)
        throw this.#middleware.unknownAlias(reference.alias, route.uri)
      const instance = buildMiddleware(this.container, middlewareClass)
      // Recorded so a withCsrf()-style wrapper on the action knows the router already ran it.
      ctx.markApplied(reference.alias)
      if (typeof instance.terminate === 'function')
        run.terminables.push({ middleware: instance, ctx })
      return instance.handle(ctx, () => next(index + 1), ...reference.params)
    }
    return next(0)
  }

  async #bindModels(route: CompiledRoute, ctx: Ctx): Promise<void> {
    const bindings = this.#blueprint.routing.bindings ?? {}
    for (const parameter of route.parameters) {
      const model = Object.hasOwn(bindings, parameter.name) ? bindings[parameter.name] : undefined
      if (model === undefined) continue
      const found = await model.resolveRouteBinding(ctx.param(parameter.name), parameter.field)
      if (found === null || found === undefined) throw new NotFoundError(parameter.name)
      ctx.bindModel(parameter.name, found)
    }
  }

  async #invoke(route: CompiledRoute, ctx: Ctx): Promise<Response> {
    const action = route.action
    let result: unknown
    if (action.kind === 'closure') result = await action.handler(ctx)
    else {
      // A new controller per request: no state can leak from one request to the next.
      const controller = buildUnchecked(this.container, action.controller) as Record<
        string,
        unknown
      >
      const handler = controller[action.method]
      if (typeof handler !== 'function')
        throw new BootError(
          'missing_action',
          `${actionLabel(action)} is not a method.`,
          `Add ${action.method}(ctx: HttpContext) to ${action.controller.name}.`,
        )
      result = await (handler as (ctx: Ctx) => unknown).call(controller, ctx)
    }
    if (result instanceof Response) return result
    throw new BootError(
      'not_a_response',
      `${actionLabel(action)} returned ${result === undefined ? 'nothing' : typeof result} instead of a Response.`,
      'Return ctx.json(...), ctx.html(...) or ctx.noContent().',
    )
  }

  #errorInfo(ctx: Ctx, run: RequestRun): ExceptionRequestInfo {
    return {
      request: ctx.request,
      nonce: ctx.nonce,
      requestId: ctx.state.requestId,
      locale: ctx.state.locale,
      wantsJson: ctx.wantsJson(),
      ...(run.route === undefined
        ? {}
        : {
            route: {
              ...(run.route.name === undefined ? {} : { name: run.route.name }),
              uri: run.route.uri,
              action: actionLabel(run.route.action),
            },
          }),
    }
  }

  async #reportResponse(
    ctx: Ctx,
    response: Response,
    run: RequestRun,
    booted: BootedState,
  ): Promise<void> {
    const payload: HttpResponseHookPayload = {
      request: ctx.request,
      status: response.status,
      requestId: ctx.state.requestId,
      ...(run.route === undefined || run.route.fallback === true ? {} : { route: run.route.uri }),
    }
    try {
      await this.make(HooksToken).run(HTTP_HOOKS.response, payload)
    } catch (error) {
      // Observe-only: a failing response hook never changes the response.
      booted.logger.error('An http.onResponse hook failed', { error: describeError(error) })
    }
  }

  /** Terminable middleware and deferred work: after the response, errors logged, never thrown. */
  async #afterResponse(
    ctx: Ctx,
    response: Response,
    run: RequestRun,
    logger: Logger,
  ): Promise<void> {
    for (const { middleware, ctx: routed } of run.terminables) {
      try {
        await middleware.terminate?.(routed, response)
      } catch (error) {
        logger.error('Terminable middleware failed', {
          requestId: ctx.state.requestId,
          error: describeError(error),
        })
      }
    }
    for (const task of ctx.deferredTasks()) {
      try {
        await task()
      } catch (error) {
        logger.error('Deferred work failed', {
          requestId: ctx.state.requestId,
          error: describeError(error),
        })
      }
    }
  }

  #booted(what: string): BootedState {
    if (this.#state !== undefined) return this.#state
    throw notBooted(what)
  }
}

function notBooted(what: string): BootError {
  return new BootError(
    'not_booted',
    `${what} was used before the app booted.`,
    'Call `await app.boot()` first (requests and commands do it for you).',
  )
}

/**
 * A config value as text, or `undefined` when the key is absent **or holds no value**. An
 * `env.optional('APP_PREVIOUS_KEYS')` that is unset yields `undefined`; `String(undefined)` would
 * turn that into the key list "undefined" and the keyring would refuse to boot.
 */
function configText(config: ConfigRepository, path: string): string | undefined {
  if (!config.has(path)) return undefined
  const value = config.get(path)
  return value === undefined || value === null ? undefined : String(value)
}

/** A friendly boot error from a provider is shown as itself, not wrapped. */
function unwrapProviderError(error: unknown): unknown {
  if (error instanceof ProviderError && isBootError(error.cause)) return error.cause
  if (
    error instanceof ProviderError &&
    (error.provider === KERNEL || error.provider === KERNEL_CHECKS)
  )
    return error.cause
  return error
}

/** A client-sent request id is believed only from a trusted proxy. */
function trustsPeer(peer: string | undefined, security: ResolvedSecurity): boolean {
  if (security.proxies.hops > 0) return true
  const ip = peer === undefined ? undefined : parseIp(peer)
  return ip !== undefined && security.proxies.ranges.some((range) => inCidr(ip, range))
}

/**
 * Log a warning for every CSRF exception pattern that can never match a registered route
 * (CONSISTENCY #18): patterns match the full path, so `webhooks/*` misses `/api/webhooks/x`.
 */
function warnUnmatchedCsrfExceptions(
  security: ResolvedSecurity,
  routes: readonly CompiledRoute[],
  logger: Logger,
): void {
  for (const pattern of security.csrf.except) {
    const sample = `/${pattern.replaceAll('*', 'x')}`
    const matches = routes.some(
      (route) => matchesPathPattern(pattern, route.uri) || route.pattern.test(sample),
    )
    if (!matches)
      logger.warn(
        `The CSRF exception "${pattern}" matches no route. Patterns match the full path without the leading slash (for example "api/webhooks/*").`,
      )
  }
}

function describeError(error: unknown): Record<string, string> {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: typeof error, message: String(error) }
}
