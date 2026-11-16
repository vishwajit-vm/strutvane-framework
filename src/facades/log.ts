/**
 * The `Log` facade: the current app's `Logger` (`@strutvane/logs` by default, core's fallback
 * otherwise), redaction included.
 *
 * @module
 */
import type { LogFields, Logger, LogLevel } from '../contracts/logger.ts'
import { LoggerToken } from '../core/tokens.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<Logger> = {
  facade: 'Log',
  token: LoggerToken,
  provides: 'a logger',
  install:
    'The core binds a logger when the app is created; bind your own with app.container.value(LoggerToken, logger).',
}

/**
 * What the `Log` facade offers: the `Logger` contract, resolved on every call.
 *
 * @example
 * const log: LogFacade = Log
 */
export interface LogFacade {
  /** Very detailed tracing. */
  trace(message: string, fields?: LogFields): void
  /** Diagnostics for developers. */
  debug(message: string, fields?: LogFields): void
  /** Something normal worth recording. */
  info(message: string, fields?: LogFields): void
  /** Something unexpected but handled. */
  warn(message: string, fields?: LogFields): void
  /** A failure that needs attention. */
  error(message: string, fields?: LogFields): void
  /** The process cannot go on. */
  fatal(message: string, fields?: LogFields): void
  /** A logger that adds `bindings` to every record (`{ module: 'billing' }`). */
  child(bindings: LogFields): Logger
  /** Whether a level would be written (to skip building expensive fields). */
  isLevelEnabled(level: LogLevel): boolean
  /** Write out everything buffered. */
  flush(): Promise<void>
  /** The logger itself, for code that takes a `Logger`. */
  logger(): Logger
}

/**
 * Log through the current app's logger, Laravel's `Log::info(...)`. The logger redacts fields
 * (passwords, tokens, cookies…); they are never written raw.
 *
 * @example
 * Log.info('Invoice paid', { invoiceId: invoice.id })
 * Log.child({ module: 'billing' }).warn('Retrying the charge')
 */
export const Log: LogFacade = Object.freeze({
  trace: (message: string, fields?: LogFields): void =>
    resolveFacade(binding, 'trace').trace(message, fields),
  debug: (message: string, fields?: LogFields): void =>
    resolveFacade(binding, 'debug').debug(message, fields),
  info: (message: string, fields?: LogFields): void =>
    resolveFacade(binding, 'info').info(message, fields),
  warn: (message: string, fields?: LogFields): void =>
    resolveFacade(binding, 'warn').warn(message, fields),
  error: (message: string, fields?: LogFields): void =>
    resolveFacade(binding, 'error').error(message, fields),
  fatal: (message: string, fields?: LogFields): void =>
    resolveFacade(binding, 'fatal').fatal(message, fields),
  child: (bindings: LogFields): Logger => resolveFacade(binding, 'child').child(bindings),
  isLevelEnabled: (level: LogLevel): boolean =>
    resolveFacade(binding, 'isLevelEnabled').isLevelEnabled(level),
  flush: (): Promise<void> => resolveFacade(binding, 'flush').flush(),
  logger: (): Logger => resolveFacade(binding, 'logger'),
})
