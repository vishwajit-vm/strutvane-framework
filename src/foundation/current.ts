/**
 * The *current application*: which app a helper (`route()`, `config()`, `encrypt()`) or a facade
 * (`Log`, `Cache`, `Crypt`) talks to.
 *
 * **Why AsyncLocalStorage and not a module-level global?** Every request and every console
 * command runs inside `runInApplication(app, …)`, so helpers find *their* app even when two apps
 * live in one process (tests do this all the time) and never see each other. Outside a request
 * or command the helpers fail with a message that says how to get the app explicitly, instead of
 * silently reading another app's state (CONSISTENCY #47).
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Container } from '../core/container.ts'
import { BootError } from './boot-error.ts'

/**
 * What helpers and facades need from the running application. `Application` implements it.
 *
 * @example
 * const scope: ApplicationScope = app
 */
export interface ApplicationScope {
  /** The application's container: every facade resolves from here. */
  readonly container: Container
  /** The project root (`bootstrap/..`). */
  readonly basePath: string
}

const storage = new AsyncLocalStorage<ApplicationScope>()

/**
 * Run `work` with `app` as the current application.
 *
 * @example
 * const url = runInApplication(app, () => route('posts.index'))
 */
export function runInApplication<TResult>(app: ApplicationScope, work: () => TResult): TResult {
  return storage.run(app, work)
}

/**
 * The current application, or a friendly error naming the helper that needed it.
 *
 * @example
 * currentApplication('config()').container
 */
export function currentApplication(helper: string): ApplicationScope {
  const app = storage.getStore()
  if (app !== undefined) return app
  throw new BootError(
    'no_current_application',
    `${helper} was called outside a request or console command, so there is no current app.`,
    'Call it from a controller, middleware or command, or wrap the code in app.run(() => …) (tests: await app.run(async () => …)).',
  )
}

/**
 * The current application, or `undefined` (never throws).
 *
 * @example
 * const scope = maybeCurrentApplication()
 */
export function maybeCurrentApplication(): ApplicationScope | undefined {
  return storage.getStore()
}
