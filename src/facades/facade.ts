/**
 * The machinery behind every facade: resolve a service from the **current application's
 * container** on every call (CONSISTENCY #47).
 *
 * **Why resolve on every call, and never cache?** A facade is a typed static accessor such as
 * `Cache.get('stats')`. Laravel resolves `Cache::` from the container; Strutvane does the same,
 * without `__callStatic` magic: each facade is a frozen object whose methods look the service up
 * through `currentApplication()` (AsyncLocalStorage). So:
 * - two apps in one process (every test suite) never see each other's cache or logger;
 * - a test swaps a facade by binding a different value in *its* app's container
 *   (`app.container.value(CacheManagerToken, fake)`), with no global to reset afterwards;
 * - outside a request or command the facade fails with a friendly error instead of silently
 *   reading some other app's state.
 *
 * @module
 */
import type { Token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'
import { currentApplication } from '../foundation/current.ts'

/**
 * Which service a facade stands for, and what to install when nothing is bound.
 *
 * @example
 * const binding: FacadeBinding<CacheManager> = { facade: 'Cache', token: CacheManagerToken, provides: 'the cache manager', install: 'It is bound when the app boots.' }
 */
export interface FacadeBinding<TService> {
  /** The facade's name, as the developer typed it (`Cache`). */
  readonly facade: string
  readonly token: Token<TService>
  /** What the service is, for the error message ("the cache manager"). */
  readonly provides: string
  /** How to get it bound: the provider to install or the config to add. */
  readonly install: string
}

/**
 * The service behind a facade, from the current application's container. Throws a friendly
 * `BootError` outside an app (`no_current_application`) or when nothing is bound
 * (`facade_not_bound`, naming the facade and what to install).
 *
 * @example
 * resolveFacade(CacheBinding, 'get').store().get('stats')
 */
export function resolveFacade<TService>(
  binding: FacadeBinding<TService>,
  member: string,
): TService {
  const call = `${binding.facade}.${member}()`
  const { container } = currentApplication(call)
  if (!container.has(binding.token))
    throw new BootError(
      'facade_not_bound',
      `${call} needs ${binding.provides}, but nothing is bound to "${binding.token.name}" in this app.`,
      binding.install,
    )
  return container.make(binding.token)
}

/**
 * The error every member of a facade that arrives later throws (`Mail`, `Queue`, `Bus`,
 * `Notification`, `Hash`).
 *
 * @example
 * throw notAvailable('Mail', 'send', 'Send mail with your provider SDK until then.')
 */
export function notAvailable(facade: string, member: string, hint: string): BootError {
  return new BootError(
    'facade_not_available',
    `${facade}.${member}() is not available yet: the ${facade} facade arrives in Strutvane 0.3.`,
    hint,
  )
}
