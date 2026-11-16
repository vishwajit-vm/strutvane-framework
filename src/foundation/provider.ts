/**
 * Service providers: Laravel's `register()` / `boot()` lifecycle, typed.
 *
 * - `register(app)` only *binds* things into the container. It runs for every provider before any
 *   `boot`, so a provider never sees a half-registered app. It is synchronous, like the core's.
 * - `boot(app)` may *use* other services (read config, add navigation, listen to events).
 * - `shutdown(app)` (optional) runs in reverse order when the app stops.
 *
 * The application accepts both these classes and the core's `Provider` objects
 * (`{ name, register, boot?, shutdown? }`), so a package written against the core plugs in too.
 * Packages ship a provider and the installer adds one line to `bootstrap/providers.ts`; there is
 * no auto-discovery from `node_modules`: the app lists what runs at boot.
 *
 * @module
 */
import type { Provider } from '../core/application.ts'
import type { Application } from './application.ts'

/**
 * The base class for service providers.
 *
 * @example
 * export class AppServiceProvider extends ServiceProvider {
 *   override register(app: Application): void {
 *     app.container.singleton(MailerToken, () => new LogMailer())
 *   }
 * }
 */
export abstract class ServiceProvider {
  /**
   * Bind services. Don't resolve other services here: they may not be registered yet.
   *
   * @example
   * override register(app: Application): void { app.container.singleton(Mailer, () => new LogMailer()) }
   */
  register(_app: Application): void {}

  /**
   * Use services: add commands, navigation entries, event listeners.
   *
   * @example
   * override boot(app: Application): void { app.navigation.add({ … }) }
   */
  boot(_app: Application): void | Promise<void> {}

  /**
   * Release what `boot` opened (connections, timers). Runs in reverse provider order.
   *
   * @example
   * override async shutdown(): Promise<void> { await this.pool.end() }
   */
  shutdown(_app: Application): void | Promise<void> {}
}

/**
 * A provider class with a no-argument constructor, as listed in `bootstrap/providers.ts`.
 *
 * @example
 * export default [AppServiceProvider] satisfies ProviderClass[]
 */
export type ProviderClass = new () => ServiceProvider

/**
 * What `withProviders([...])` accepts: provider classes and core provider objects.
 *
 * @example
 * .withProviders([AppServiceProvider, logsProvider])
 */
export type AnyProvider = ProviderClass | Provider

/**
 * `true` for a provider class (as opposed to a core provider object).
 *
 * @example
 * isProviderClass(AppServiceProvider) // true
 */
export function isProviderClass(value: unknown): value is ProviderClass {
  return typeof value === 'function' && value.prototype instanceof ServiceProvider
}
