/**
 * How an application gets its log manager: `config/logging.ts` (if the app has one) resolved
 * against the app's own environment (`.env` merged with the process environment, the same source
 * every other config file reads) and its project root.
 *
 * Failure scenarios:
 * - **`config/logging.ts` is not an object, or invalid** (unknown driver or channel, a bad level,
 *   size or file name, a stack that contains itself, a path that climbs out of the project): the
 *   boot fails with a `BootError` (`invalid_logging_config`) listing every problem. It's code, so
 *   it should fail fast and loudly.
 * - **A mistake in `.env`** (`LOG_LEVEL=loud`, `LOG_PATH=../../etc`): never fatal. The default is
 *   used and a warning naming the key is logged once on the default channel.
 * - **A `custom` channel and the config cache:** a cached config is JSON, so a channel's `via`
 *   function can't survive `config:cache`; the boot then fails with the same error, naming the
 *   channel, instead of silently dropping it.
 *
 * @module
 */
import { BootError } from '../foundation/boot-error.ts'
import { type Env, type LoggingConfig, LoggingConfigError } from './config.ts'
import { createLogManager, type LogManager } from './manager.ts'

/**
 * What {@link createAppLogManager} needs from the application.
 *
 * @example
 * const options: AppLogManagerOptions = { config: undefined, env: { APP_ENV: 'local' }, root: '/srv/blog' }
 */
export interface AppLogManagerOptions {
  /** The value of `config('logging')`, `undefined` when the app has no `config/logging.ts`. */
  readonly config: unknown
  /** The app's environment (`.env` + process). */
  readonly env: Env
  /** The project root: relative log paths start here. */
  readonly root: string
  /** `APP_ENV` as the app resolved it (`config/app.ts` `env`); shown in `line` headers. */
  readonly appEnv?: string
}

/**
 * Build the log manager for an application.
 *
 * @throws BootError (`invalid_logging_config`) when `config/logging.ts` is invalid
 *
 * @example
 * const manager = createAppLogManager({ config: undefined, env: { APP_ENV: 'local' }, root: '/srv/blog' })
 */
export function createAppLogManager(options: AppLogManagerOptions): LogManager {
  const config = appLoggingConfig(options.config)
  const env: Env =
    options.appEnv === undefined ? options.env : { ...options.env, APP_ENV: options.appEnv }
  try {
    return createLogManager({ config, env, root: options.root, handleShutdown: false })
  } catch (error) {
    throw asLoggingBootError(error)
  }
}

/**
 * A `LoggingConfigError` as the friendly `BootError` the CLI and the boot report show; anything
 * else unchanged.
 *
 * @example
 * throw asLoggingBootError(error)
 */
export function asLoggingBootError(error: unknown): unknown {
  if (!(error instanceof LoggingConfigError)) return error
  return new BootError(
    'invalid_logging_config',
    error.message,
    'Fix config/logging.ts (every problem is listed above). A custom channel can not be stored in the config cache: run node strut config:clear if you cached it.',
  )
}

/**
 * Check the shape of `config('logging')` before resolving it: absent is fine (the built-in
 * channels), anything but an object with an object of `channels` is a `BootError`.
 *
 * @example
 * appLoggingConfig(undefined) // {}
 */
export function appLoggingConfig(value: unknown): LoggingConfig {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new BootError(
      'invalid_logging_config',
      `config/logging.ts must export an object of settings, not ${Array.isArray(value) ? 'an array' : typeof value}.`,
      'Write export default defineConfig(() => defineLoggingConfig({ channels: { … } })) in config/logging.ts.',
    )
  const channels: unknown = Reflect.get(value, 'channels')
  if (
    channels !== undefined &&
    (typeof channels !== 'object' || channels === null || Array.isArray(channels))
  )
    throw new BootError(
      'invalid_logging_config',
      'config/logging.ts: channels must be an object of named channels.',
      "Write channels: { payments: { driver: 'daily', name: 'payments' } }.",
    )
  return value as LoggingConfig
}
