/**
 * The `Log` facade and the `logger()` helper (ADR-0022 §7): Laravel's `Log::info()`,
 * `Log::channel()`, `Log::stack()`, `Log::build()` and `Log::withContext()`, resolved from the
 * **current application's container** on every call (CONSISTENCY #47).
 *
 * Two tokens stand behind it:
 * - the level methods (`Log.info()`, `Log.error()`, …) write through `LoggerToken`, the `Logger`
 *   contract. By default that is the app's log manager, so they go to the default channel
 *   (`LOG_CHANNEL`); a test that binds a memory logger there sees every call.
 * - channel selection and context (`channel`, `stack`, `build`, `withContext`, `shareContext`, …)
 *   use `LogManagerToken`, the manager itself.
 *
 * Redaction is always on (secrets in messages and fields never reach a file), and request id,
 * user id and tenant id are added to every record written during a request.
 *
 * @module
 */
import type { LogFields, Logger } from '../contracts/logger.ts'
import { LoggerToken } from '../core/tokens.ts'
import type { ConfigRegistry, IsFilled } from '../foundation/registry.ts'
import type { BuiltInChannel, ChannelConfig } from '../logging/config.ts'
import { type Level, type LevelName, toLevel } from '../logging/levels.ts'
import type { StrutvaneLogger } from '../logging/logger.ts'
import type { LogManager } from '../logging/manager.ts'
import { LogManagerToken } from '../logging/token.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const loggerBinding: FacadeBinding<Logger> = {
  facade: 'Log',
  token: LoggerToken,
  provides: 'a logger',
  install:
    'The application binds its log manager when it is created; bind your own with app.container.value(LoggerToken, logger).',
}

const managerBinding: FacadeBinding<LogManager> = {
  facade: 'Log',
  token: LogManagerToken,
  provides: 'the log manager',
  install:
    'The application binds it when it is created (Application.configure(…).create()); bind your own with app.container.value(LogManagerToken, manager).',
}

/**
 * The channel names `Log.channel()` and `Log.stack()` accept: the built-ins (`stack`, `single`,
 * `daily`, `slack`, `stderr`, `stdout`, `null`) plus the channels of the app's
 * `config/logging.ts`, once the app fills in `ConfigRegistry`; any string before that.
 *
 * @example
 * const channel: LogChannel = 'daily'
 */
export type LogChannel =
  IsFilled<ConfigRegistry> extends true
    ?
        | BuiltInChannel
        | (ConfigRegistry extends { readonly logging: { readonly channels: infer TChannels } }
            ? Extract<keyof TChannels, string>
            : never)
    : BuiltInChannel | (string & {})

/**
 * A log method: a message plus optional structured fields.
 *
 * @example
 * const method: LogFacadeMethod = Log.info
 */
export type LogFacadeMethod = (message: string, fields?: LogFields) => void

/**
 * What the `Log` facade offers: every RFC 5424 level (and the v1 aliases), channels, stacks,
 * on-demand channels and context.
 *
 * @example
 * const log: LogFacade = Log
 */
export interface LogFacade {
  /** The system is unusable. */
  readonly emergency: LogFacadeMethod
  /** Action must be taken immediately (the database is down). */
  readonly alert: LogFacadeMethod
  /** Critical conditions (a component is unavailable). */
  readonly critical: LogFacadeMethod
  /** A failure that needs attention. */
  readonly error: LogFacadeMethod
  /** Something unexpected but handled. */
  readonly warning: LogFacadeMethod
  /** Normal but significant. */
  readonly notice: LogFacadeMethod
  /** Something normal worth recording. */
  readonly info: LogFacadeMethod
  /** Diagnostics for developers. */
  readonly debug: LogFacadeMethod
  /** Alias of `debug` (the v1 `Logger` contract). */
  readonly trace: LogFacadeMethod
  /** Alias of `warning` (the v1 `Logger` contract). */
  readonly warn: LogFacadeMethod
  /** Alias of `critical` (the v1 `Logger` contract). */
  readonly fatal: LogFacadeMethod
  /**
   * Log at a level chosen at runtime. An unknown level is written at `error` with the name kept in
   * `fields.invalidLevel`, so a typo never loses the record.
   */
  log(level: LevelName, message: string, fields?: LogFields): void
  /** A logger that adds `bindings` to every record (`{ module: 'billing' }`). */
  child(bindings: LogFields): Logger
  /** Whether a level would be written (to skip building expensive fields). */
  isLevelEnabled(level: LevelName): boolean
  /** Write out everything buffered (bounded). */
  flush(): Promise<void>
  /** The logger itself, for code that takes a `Logger`. */
  logger(): Logger
  /**
   * A channel by name (the default channel when omitted). A name that isn't configured writes to
   * the default channel and logs a friendly error once.
   *
   * @example
   * Log.channel('payments').warning('Card declined', { orderId })
   */
  channel(name?: LogChannel): StrutvaneLogger
  /**
   * An on-the-fly stack: every record goes to each channel once.
   *
   * @example
   * Log.stack(['daily', 'slack']).critical('Ledger out of balance')
   */
  stack(channels: readonly LogChannel[]): StrutvaneLogger
  /**
   * A channel from a config object, without adding it to `config/logging.ts` (Laravel's
   * `Log::build`). Throws a `LoggingConfigError` for an invalid config.
   *
   * @example
   * Log.build({ driver: 'single', path: 'storage/logs/imports', name: 'imports' }).info('Done')
   */
  build(config: ChannelConfig): StrutvaneLogger
  /**
   * Add context to every record written during this request (outside a request: for the rest of
   * the process), on every channel.
   *
   * @example
   * Log.withContext({ orderId: order.id })
   */
  withContext(values: LogFields): LogFacade
  /** Remove context added with `withContext`: the given keys, or all of it (request ids stay). */
  withoutContext(keys?: readonly string[]): LogFacade
  /**
   * Add context to every record, on every channel, in every request, for the rest of the process.
   *
   * @example
   * Log.shareContext({ release: '2026.11.17' })
   */
  shareContext(values: LogFields): LogFacade
  /** The context added with `shareContext`. */
  sharedContext(): Readonly<Record<string, unknown>>
  /** Remove everything added with `shareContext`. */
  flushSharedContext(): LogFacade
  /** A deprecation warning, to `LOG_DEPRECATIONS_CHANNEL` (`null` by default). */
  deprecation(message: string, fields?: LogFields): void
  /** The manager behind the facade, for code that wants it injected. */
  manager(): LogManager
}

/** The v1 `Logger` method that stands in for a level the contract doesn't have. */
const CONTRACT_METHOD: Readonly<Record<Level, 'fatal' | 'error' | 'warn' | 'info' | 'debug'>> = {
  emergency: 'fatal',
  alert: 'fatal',
  critical: 'fatal',
  error: 'error',
  warning: 'warn',
  notice: 'info',
  info: 'info',
  debug: 'debug',
}

type Writer = (message: string, fields?: LogFields) => void

/**
 * Write through whatever is bound to `LoggerToken`: the level's own method when the logger has
 * one (the log manager has all eight), else the contract's nearest (`critical` → `fatal`,
 * `notice` → `info`), so a plain `Logger` bound in a test still sees every call.
 */
function write(level: Level, member: string, message: string, fields?: LogFields): void {
  const target = resolveFacade(loggerBinding, member)
  const own: unknown = Reflect.get(target, level)
  const method = (typeof own === 'function' ? own : target[CONTRACT_METHOD[level]]) as Writer
  method.call(target, message, fields)
}

const at =
  (level: Level, member: string = level): LogFacadeMethod =>
  (message, fields) =>
    write(level, member, message, fields)

const manager = (member: string): LogManager => resolveFacade(managerBinding, member)

/**
 * Log through the current app's channels, Laravel's `Log::info(...)`. Fields are redacted
 * (passwords, tokens, cookies, secrets in text…); they are never written raw.
 *
 * @example
 * Log.info('Invoice paid', { invoiceId: invoice.id })
 * Log.channel('payments').warning('Card declined')
 * Log.withContext({ orderId }).error('Charge failed')
 */
export const Log: LogFacade = Object.freeze({
  emergency: at('emergency'),
  alert: at('alert'),
  critical: at('critical'),
  error: at('error'),
  warning: at('warning'),
  notice: at('notice'),
  info: at('info'),
  debug: at('debug'),
  trace: at('debug', 'trace'),
  warn: at('warning', 'warn'),
  fatal: at('critical', 'fatal'),
  log(level: LevelName, message: string, fields?: LogFields): void {
    const canonical = toLevel(level)
    if (canonical !== undefined) write(canonical, 'log', message, fields)
    else write('error', 'log', message, { ...fields, invalidLevel: String(level) })
  },
  child: (bindings: LogFields): Logger => resolveFacade(loggerBinding, 'child').child(bindings),
  isLevelEnabled(level: LevelName): boolean {
    const target = resolveFacade(loggerBinding, 'isLevelEnabled')
    const canonical = toLevel(level)
    if (canonical === undefined) return false
    // A logger with all eight level methods (the manager) understands every name; a plain v1
    // Logger only its six, so it is asked about the nearest one.
    if (typeof Reflect.get(target, 'notice') === 'function')
      return (target as StrutvaneLogger).isLevelEnabled(canonical)
    return target.isLevelEnabled(CONTRACT_METHOD[canonical])
  },
  flush: (): Promise<void> => resolveFacade(loggerBinding, 'flush').flush(),
  logger: (): Logger => resolveFacade(loggerBinding, 'logger'),
  channel: (name?: LogChannel): StrutvaneLogger => manager('channel').channel(name),
  stack: (channels: readonly LogChannel[]): StrutvaneLogger => manager('stack').stack(channels),
  build: (config: ChannelConfig): StrutvaneLogger => manager('build').build(config),
  withContext(values: LogFields): LogFacade {
    manager('withContext').withContext(values)
    return Log
  },
  withoutContext(keys?: readonly string[]): LogFacade {
    manager('withoutContext').withoutContext(keys)
    return Log
  },
  shareContext(values: LogFields): LogFacade {
    manager('shareContext').shareContext(values)
    return Log
  },
  sharedContext: (): Readonly<Record<string, unknown>> => manager('sharedContext').sharedContext(),
  flushSharedContext(): LogFacade {
    manager('flushSharedContext').flushSharedContext()
    return Log
  },
  deprecation: (message: string, fields?: LogFields): void =>
    manager('deprecation').deprecation(message, fields),
  manager: (): LogManager => manager('manager'),
})

/**
 * Laravel's `logger()` helper: with no arguments it returns the `Log` facade; with a message it
 * logs it at `debug` on the default channel.
 *
 * @example
 * logger('Cache warmed', { keys: 120 })
 * logger().channel('payments').info('Paid')
 */
export function logger(): LogFacade
export function logger(message: string, fields?: LogFields): void
export function logger(message?: string, fields?: LogFields): LogFacade | undefined {
  if (message === undefined) return Log
  Log.debug(message, fields)
  return undefined
}
