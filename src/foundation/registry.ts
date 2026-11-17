/**
 * The three registries an app fills in with declaration merging: its route names, its config
 * shape and its user type. They are empty here on purpose, so the framework never imports app
 * code. The app adds one block (in `bootstrap/app.ts`):
 *
 * ```ts
 * declare module '@strutvane/framework' {
 *   interface RouteRegistry extends RoutesOf<[typeof web, typeof api]> {}
 *   interface ConfigRegistry extends ConfigOf<typeof config> {}
 *   interface UserRegistry { user: User }
 * }
 * ```
 *
 * **Why declaration merging instead of code generation:** route names and config keys already
 * exist as TypeScript values in the app's own files, so `typeof` gets their exact types for free,
 * with nothing to regenerate and nothing to go stale.
 *
 * **Before an app fills them in**, the typed helpers fall back to plain strings (`route(name)`
 * takes any name, `config(key)` any key and returns `unknown`), so a fresh app and a package
 * compile without the block. Augmenting through a re-export works (TypeScript merges into the
 * declaring module), so apps augment the package entry point they import from.
 *
 * @module
 */
import type { Actor } from '../contracts/actor.ts'

/**
 * Every named route, mapped to the parameters its URL needs. Filled in by the app.
 *
 * @example
 * // after augmentation: RouteRegistry['posts.show'] is { readonly post: RouteParam }
 * route('posts.show', { post })
 */
// biome-ignore lint/suspicious/noEmptyInterface: an empty interface is the merge target apps augment.
export interface RouteRegistry {}

/**
 * The app's config tree (`config/*.ts`), keyed by file name. Filled in by the app.
 *
 * @example
 * // after augmentation: config('app.debug') is typed as boolean
 */
// biome-ignore lint/suspicious/noEmptyInterface: an empty interface is the merge target apps augment.
export interface ConfigRegistry {}

/**
 * The type of the signed-in user. Filled in by the app as `{ user: User }`.
 *
 * @example
 * // after augmentation: ctx.user is User | null
 */
// biome-ignore lint/suspicious/noEmptyInterface: an empty interface is the merge target apps augment.
export interface UserRegistry {}

/**
 * The app's user type: what the auth package resolves for a request (`http.onRequest`'s
 * `actor`), or the contracts' {@link Actor} when the app hasn't said.
 *
 * @example
 * function greet(user: AuthUser): string { return `Hello #${String(user.id)}` }
 */
export type AuthUser = UserRegistry extends { readonly user: infer TUser extends object }
  ? TUser
  : Actor

/**
 * `true` when the app has filled in a registry (at least one key).
 *
 * @example
 * type Typed = IsFilled<RouteRegistry> // false until the app augments it
 */
export type IsFilled<TRegistry> = [keyof TRegistry] extends [never] ? false : true
