/**
 * Friendly helpers, Laravel's `config()`, `now()`, `app()` and `redirect()`, without facades:
 * plain functions you import, fully typed, that read the *current* app (`current.ts`), so nothing
 * is a global singleton and two apps in one process never see each other.
 *
 * @module
 */
import { ClockToken } from '../core/tokens.ts'
import { Redirector } from '../security/redirect.ts'
import { type ConfigPath, ConfigRepositoryToken, type ConfigValue } from './config.ts'
import { type ApplicationScope, currentApplication } from './current.ts'
import type { ConfigRegistry, IsFilled } from './registry.ts'

/**
 * A config key: a dot path into the app's `ConfigRegistry` once it fills it in, any string before.
 *
 * @example
 * const key: ConfigKey = 'app.debug'
 */
export type ConfigKey =
  IsFilled<ConfigRegistry> extends true ? ConfigPath<ConfigRegistry> & string : string

/**
 * The type of the value at a config key (`unknown` before the app fills in `ConfigRegistry`).
 *
 * @example
 * type Debug = ConfigResult<'app.debug'> // boolean
 */
export type ConfigResult<TKey extends string> =
  IsFilled<ConfigRegistry> extends true ? ConfigValue<ConfigRegistry, TKey> : unknown

/**
 * Read a config value by dot path. The key and the return type come from the app's config files;
 * an unknown key throws (never `undefined`).
 *
 * @example
 * config('app.name')  // string
 * config('app.debug') // boolean
 * config('app.nmae')  // compile error once ConfigRegistry is filled in
 */
export function config<TKey extends ConfigKey>(key: TKey): ConfigResult<TKey> {
  // The repository was built from the same files the registry types come from.
  return currentApplication('config()')
    .container.make(ConfigRepositoryToken)
    .get(key) as ConfigResult<TKey>
}

/**
 * The current time from the app's clock, Laravel's `now()`. Tests freeze it by binding
 * `ClockToken` to a `TestClock`, so timestamps written through it are deterministic.
 *
 * @example
 * await post.update({ published_at: now() })
 */
export function now(): Date {
  return new Date(currentApplication('now()').container.make(ClockToken).now())
}

/**
 * The current application (its container and base path).
 *
 * @example
 * const logger = app().container.make(LoggerToken)
 */
export function app(): ApplicationScope {
  return currentApplication('app()')
}

/**
 * A redirector for the current app, with the open-redirect guard built in (`security/redirect.ts`):
 * `.to()` only for same-origin paths, `.intended()` falls back for anything else, `.away()` is the
 * one explicit way off-site.
 *
 * @example
 * return redirect().intended(ctx, '/dashboard')
 */
export function redirect(): Redirector {
  const container = currentApplication('redirect()').container
  return new Redirector(container.make(ConfigRepositoryToken).string('app.url', 'http://localhost'))
}
