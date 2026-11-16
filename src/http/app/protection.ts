/**
 * The "many ways" rule from the blueprint (§5.2), written once. Any middleware alias becomes a
 * *protection* that can be applied in every style without new code:
 *
 * | Style | Code |
 * |---|---|
 * | default / app-wide | the `web` and `api` groups, `withMiddleware(…)` in `bootstrap/app.ts` |
 * | one route | `Route.post(…).middleware('csrf')` / `.withoutMiddleware('csrf')` |
 * | a group | `Route.middleware('csrf').group(() => { … })` / `Route.withoutMiddleware('csrf').group(…)` |
 * | a controller | `static readonly middleware = [csrf({ except: ['callback'] })]` |
 * | a handler function | `export default withCsrf(async (ctx) => …)` |
 * | imperative | `await csrf.verify(ctx)` |
 *
 * Every style runs the *same* middleware class, so there is one implementation per protection,
 * and every style except the imperative call is visible to `node strut route:list --security`.
 * There are no decorators: the engineering standard bans them, Node's type stripping can't run
 * them, and they would hide behaviour from `route:list`.
 *
 * @module
 */
import { BootError } from '../../foundation/boot-error.ts'
import { currentApplication } from '../../foundation/current.ts'
import type { ActionHandler } from '../../routing/types.ts'
import type { HttpContext } from './context.ts'
import { ResponseError } from './errors.ts'
import { buildMiddleware, type MiddlewareClass, type Next, referenceFor } from './middleware.ts'

/**
 * One entry of a controller's `static middleware` list, Laravel's
 * `$this->middleware('auth')->only('store')`.
 *
 * - `only`: the controller adds the protection to these actions only.
 * - `except`: the controller adds it everywhere else, **and opts these actions out** of it, even
 *   when a group (`web`, `api`) added it. That is how `csrf({ except: ['callback'] })` turns CSRF
 *   off for one webhook action. `route:list --security` flags every such opt-out.
 *
 * @example
 * static readonly middleware = [auth({ except: ['index', 'show'] }), throttle({ params: ['10', '1'], only: ['store'] })]
 */
export interface ControllerMiddleware {
  readonly kind: 'controller-middleware'
  readonly alias: string
  /** The full reference: `'throttle:10,1'`. */
  readonly reference: string
  readonly only: readonly string[] | undefined
  readonly except: readonly string[]
}

/**
 * Options for the controller style.
 *
 * @example
 * csrf({ except: ['callback'] })
 * throttle({ params: ['10', '1'], only: ['store'] })
 */
export interface ProtectionOptions {
  /** Middleware parameters: `{ params: ['10', '1'] }` is `throttle:10,1`. */
  readonly params?: readonly string[]
  /** Apply to these controller actions only. */
  readonly only?: readonly string[]
  /** Apply to every action except these, and opt these out. */
  readonly except?: readonly string[]
}

/**
 * The property a protected handler carries, so the router and `route:list` can see inside it.
 *
 * @example
 * withCsrf(handler)[PROTECTIONS] // ['csrf']
 */
export const PROTECTIONS: unique symbol = Symbol('strutvane.protections')

/**
 * A route closure wrapped by `withCsrf()`, `withAuth()`…: still a plain action handler, plus the
 * list of middleware references it carries.
 *
 * @example
 * const handler: ProtectedHandler = withCsrf(async (ctx) => ctx.json({ ok: true }))
 */
export type ProtectedHandler = ActionHandler & { readonly [PROTECTIONS]: readonly string[] }

/**
 * A protection: callable for the controller style, with the other styles as methods.
 *
 * @example
 * export const verified: Protection = defineProtection('verified', EnsureEmailIsVerified)
 */
export interface Protection {
  /** The controller style: `static middleware = [csrf({ except: ['callback'] })]`. */
  (options?: ProtectionOptions): ControllerMiddleware
  /** The middleware alias, as used in `.middleware('csrf')`. */
  readonly alias: string
  /**
   * The alias with parameters, for `.middleware()`: `throttle.reference('10', '1')` is `'throttle:10,1'`.
   *
   * @example
   * Route.post('/login', handler).middleware(throttle.reference('login'))
   */
  reference(...params: string[]): string
  /**
   * The handler style: wrap a plain function. Routed, the router runs the middleware at its
   * priority and the wrapper sees it already ran; called directly, the wrapper runs it itself.
   *
   * @example
   * export default csrf.wrap(async (ctx) => ctx.json({ imported: true }))
   */
  wrap(handler: ActionHandler, ...params: string[]): ProtectedHandler
  /**
   * The imperative style: run the check now. Resolves when the request passes, throws when it
   * doesn't (the middleware's own error, or a `ResponseError` carrying the response it answered
   * with).
   *
   * @example
   * await csrf.verify(ctx)
   */
  verify(ctx: HttpContext, ...params: string[]): Promise<void>
}

/**
 * Turn a middleware class into a {@link Protection}. The alias must be the one the class is
 * registered under (`withMiddleware((m) => m.alias({ … }))`, or a core alias).
 *
 * @example
 * export const verified = defineProtection('verified', EnsureEmailIsVerified)
 * export const withVerified = verified.wrap
 */
export function defineProtection(alias: string, middleware: MiddlewareClass): Protection {
  if (typeof middleware !== 'function' || typeof middleware.prototype?.handle !== 'function')
    throw new BootError(
      'not_middleware',
      `defineProtection('${alias}') was given something without a handle(ctx, next) method.`,
      'Pass a middleware class: class X { async handle(ctx, next) { … } }.',
    )
  const controllerEntry = (options: ProtectionOptions = {}): ControllerMiddleware => ({
    kind: 'controller-middleware',
    alias,
    reference: referenceFor(alias, options.params ?? []),
    only: options.only,
    except: options.except ?? [],
  })
  return Object.assign(controllerEntry, {
    alias,
    reference: (...params: string[]): string => referenceFor(alias, params),
    wrap: (handler: ActionHandler, ...params: string[]): ProtectedHandler => {
      const wrapped: ActionHandler = async (ctx) => {
        // Routed requests already ran it, in priority order; don't run it a second time.
        if (ctx.hasApplied(alias)) return handler(ctx)
        return runMiddleware(ctx, middleware, alias, params, async () => handler(ctx))
      }
      return Object.assign(wrapped, {
        [PROTECTIONS]: [...protectionsOf(handler), referenceFor(alias, params)],
      })
    },
    verify: async (ctx: HttpContext, ...params: string[]): Promise<void> => {
      let reached = false
      const response = await runMiddleware(ctx, middleware, alias, params, async () => {
        reached = true
        return new Response(null, { status: 204 })
      })
      // The middleware answered by itself (it didn't call next): hand its response back.
      if (!reached) throw new ResponseError(response)
    },
  })
}

/**
 * Run one middleware class for a context, marking it as applied.
 *
 * @example
 * await runMiddleware(ctx, VerifyCsrfToken, 'csrf', [], () => handler(ctx))
 */
export async function runMiddleware(
  ctx: HttpContext,
  middleware: MiddlewareClass,
  alias: string,
  params: readonly string[],
  next: Next,
): Promise<Response> {
  const instance = buildMiddleware(
    currentApplication(`The "${alias}" protection`).container,
    middleware,
  )
  ctx.markApplied(alias)
  return instance.handle(ctx, next, ...params)
}

/**
 * The middleware references a wrapped handler carries (empty for a plain function).
 *
 * @example
 * protectionsOf(withCsrf(handler)) // ['csrf']
 */
export function protectionsOf(handler: ActionHandler): readonly string[] {
  if (!(PROTECTIONS in handler)) return []
  const list: unknown = handler[PROTECTIONS]
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * A controller class's `static middleware` list, checked. Anything other than entries made by a
 * protection (`csrf()`, `auth()`…) is refused at boot, so a typo can't silently drop a check.
 *
 * @example
 * readControllerMiddleware(PostController) // [{ alias: 'auth', reference: 'auth', only: undefined, except: ['index'] }]
 */
export function readControllerMiddleware(
  controller: abstract new (...args: never[]) => unknown,
): readonly ControllerMiddleware[] {
  if (!('middleware' in controller)) return []
  const declared: unknown = controller.middleware
  if (Array.isArray(declared) && declared.every(isControllerMiddleware)) return declared
  throw new BootError(
    'invalid_controller_middleware',
    `${controller.name}.middleware must be a list of protections such as [csrf(), auth({ except: ['index'] })].`,
    'Build each entry with a protection function (csrf, auth, can, throttle, signed, idempotent, or one made with defineProtection).',
  )
}

function isControllerMiddleware(value: unknown): value is ControllerMiddleware {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'controller-middleware'
  )
}

/**
 * The action method names of a controller class (own and inherited, constructor excluded), for
 * checking `only`/`except` lists at boot.
 *
 * @example
 * controllerMethods(PostController) // ['index', 'show', 'store', …]
 */
export function controllerMethods(
  controller: abstract new (...args: never[]) => unknown,
): readonly string[] {
  const names = new Set<string>()
  let prototype: unknown = controller.prototype
  while (typeof prototype === 'object' && prototype !== null && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      if (name !== 'constructor' && typeof descriptor?.value === 'function') names.add(name)
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return [...names]
}
