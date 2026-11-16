/**
 * URL generation: `route('posts.show', { post })` (Laravel's `route()` helper) and signed links
 * (`url.signedRoute()`, `url.temporarySignedRoute()`, CONSISTENCY #52, #65), fully typed against
 * the app's `RouteRegistry`.
 *
 * The {@link UrlGenerator} does the work for one app. The helpers find the current app through
 * `foundation/current.ts`, so controllers can call them without passing the app around, and two
 * apps in one test process never see each other's routes.
 *
 * Signed links use the framework's one signer (`security/signer.ts`, CONSISTENCY #64) with the
 * purpose `route:<name>`, so a link signed for one route never verifies for another, even when
 * the paths collide.
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'
import { currentApplication } from '../foundation/current.ts'
import type { IsFilled, RouteRegistry } from '../foundation/registry.ts'
import type { UrlSigner } from '../security/signer.ts'
import { type CompiledRoute, unknownRouteName } from './router.ts'
import type { RouteParam } from './types.ts'

/**
 * Options for building a URL.
 *
 * @example
 * route('posts.index', {}, { query: { page: 2 }, absolute: true })
 */
export interface UrlOptions {
  /** Prefix with `APP_URL` (`https://blog.test/api/posts`). Default: a path only. */
  readonly absolute?: boolean
  /** Extra query string values. */
  readonly query?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Options for {@link UrlGenerator.signedRoute}.
 *
 * @example
 * url.signedRoute('unsubscribe', { user }, { expiresIn: 3600, oneTime: true })
 */
export interface SignedRouteOptions extends UrlOptions {
  /** Seconds until the link stops working. Omit for a permanent link. */
  readonly expiresIn?: number
  /** The link works once (needs an expiry and a used-signature store). */
  readonly oneTime?: boolean
}

/**
 * The parameter values for building a URL: a value per placeholder, extras become the query.
 *
 * @example
 * const params: RouteParams = { post: 'hello-world', page: 2 }
 */
export type RouteParams = Readonly<Record<string, RouteParam>>

/**
 * What the generator needs from the app: its URL, the signer and the clock.
 *
 * @example
 * new UrlGenerator(routes, { appUrl: 'http://localhost', signer: () => signer, now: () => Date.now() })
 */
export interface UrlGeneratorOptions {
  readonly appUrl: string
  readonly signer: () => UrlSigner
  readonly now: () => number
}

/**
 * The purpose a named route's links are signed for, so a link for one route never verifies for
 * another.
 *
 * @example
 * signingPurpose('files.show') // 'route:files.show'
 */
export function signingPurpose(name: string): string {
  return `route:${name}`
}

/**
 * Builds URLs for one app's named routes.
 *
 * @example
 * const urls = new UrlGenerator(routes, { appUrl: 'http://localhost:3000', signer, now })
 * urls.route('posts.show', { post: 'hello-world' }) // '/api/posts/hello-world'
 */
export class UrlGenerator {
  readonly #byName: ReadonlyMap<string, CompiledRoute>
  readonly #baseUrl: string
  readonly #options: UrlGeneratorOptions

  constructor(routes: readonly CompiledRoute[], options: UrlGeneratorOptions) {
    this.#byName = new Map(
      routes.flatMap((route) => (route.name === undefined ? [] : [[route.name, route] as const])),
    )
    this.#baseUrl = options.appUrl.replace(/\/+$/, '')
    this.#options = options
  }

  /**
   * `true` if a route has this name.
   *
   * @example
   * urls.has('posts.show') // true
   */
  has(name: string): boolean {
    return this.#byName.has(name)
  }

  /**
   * The parameter names of a named route, in path order (empty for an unknown name).
   *
   * @example
   * urls.parameters('posts.comments.show') // ['post', 'comment']
   */
  parameters(name: string): readonly string[] {
    return this.#byName.get(name)?.parameters.map((parameter) => parameter.name) ?? []
  }

  /**
   * Build the URL of a named route. Parameters the path doesn't use become the query string,
   * as in Laravel.
   *
   * @example
   * urls.route('posts.show', { post }) // uses post.routeKey('slug') when the path says {post:slug}
   */
  route(name: string, params: RouteParams = {}, options: UrlOptions = {}): string {
    const target = this.#byName.get(name)
    if (target === undefined) throw unknownRouteName(name, [...this.#byName.keys()])
    const used = new Set<string>()
    let path = target.uri
    for (const parameter of target.parameters) {
      const value = Object.hasOwn(params, parameter.name) ? params[parameter.name] : undefined
      if (value === undefined) {
        const needed = target.parameters.map((entry) => entry.name).join(', ')
        throw new BootError(
          'missing_route_parameter',
          `route('${name}') needs a value for {${parameter.name}}.`,
          `Pass every parameter of ${target.uri}: { ${needed} }.`,
        )
      }
      used.add(parameter.name)
      const placeholder =
        parameter.field === undefined
          ? `{${parameter.name}}`
          : `{${parameter.name}:${parameter.field}}`
      path = path.replace(
        placeholder,
        encodeURIComponent(String(routeValue(value, parameter.field))),
      )
    }
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params))
      if (!used.has(key)) query.set(key, String(routeValue(value, undefined)))
    for (const [key, value] of Object.entries(options.query ?? {})) query.set(key, String(value))
    const search = query.size === 0 ? '' : `?${query.toString()}`
    return `${options.absolute === true ? this.#baseUrl : ''}${path}${search}`
  }

  /**
   * The URL of a named route, signed for that route (`purpose: route:<name>`). Pass
   * `expiresIn` (seconds) for a temporary link and `oneTime` for a link that works once.
   *
   * @example
   * urls.signedRoute('unsubscribe', { user: 7 }, { expiresIn: 86_400 })
   */
  signedRoute(name: string, params: RouteParams = {}, options: SignedRouteOptions = {}): string {
    const { expiresIn, oneTime, ...urlOptions } = options
    if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn <= 0))
      throw new BootError(
        'invalid_link_expiry',
        'signedRoute() was given an expiresIn that is not a positive number of seconds.',
        'Pass seconds, e.g. { expiresIn: 3600 } for one hour.',
      )
    const expiresAt =
      expiresIn === undefined ? undefined : this.#options.now() + Math.round(expiresIn * 1000)
    return this.#sign(name, params, urlOptions, expiresAt, oneTime === true)
  }

  /**
   * The URL of a named route, signed and valid until `expiresAt`.
   *
   * @example
   * urls.temporarySignedRoute('downloads.show', new Date(Date.now() + 30 * 60_000), { file: 7 })
   */
  temporarySignedRoute(
    name: string,
    expiresAt: Date | number,
    params: RouteParams = {},
    options: UrlOptions & { readonly oneTime?: boolean } = {},
  ): string {
    const { oneTime, ...urlOptions } = options
    return this.#sign(name, params, urlOptions, expiresAt, oneTime === true)
  }

  #sign(
    name: string,
    params: RouteParams,
    options: UrlOptions,
    expiresAt: Date | number | undefined,
    oneTime: boolean,
  ): string {
    const target = this.route(name, params, options)
    return this.#options.signer().sign(target, {
      purpose: signingPurpose(name),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(oneTime ? { oneTime: true } : {}),
    })
  }
}

function routeValue(value: RouteParam, field: string | undefined): string | number {
  return typeof value === 'object' ? value.routeKey(field) : value
}

/**
 * The container token for the app's URL generator, bound at boot.
 *
 * @example
 * app.make(UrlGeneratorToken).route('posts.index')
 */
export const UrlGeneratorToken: Token<UrlGenerator> = token<UrlGenerator>('strutvane.urls')

/**
 * A route name: one of the app's named routes once it fills in `RouteRegistry`, any string before.
 *
 * @example
 * const name: RouteName = 'posts.show'
 */
export type RouteName = IsFilled<RouteRegistry> extends true ? keyof RouteRegistry & string : string

/**
 * The params argument for a given name: required when the route has parameters, optional when
 * it has none (or when the registry isn't filled in).
 *
 * @example
 * type A = RouteArguments<'posts.show'> // [params: { post: RouteParam }, options?: UrlOptions]
 */
export type RouteArguments<
  TName extends string,
  TOptions = UrlOptions,
> = TName extends keyof RouteRegistry
  ? [keyof RouteRegistry[TName]] extends [never]
    ? [params?: RouteParams, options?: TOptions]
    : [params: RouteRegistry[TName] & RouteParams, options?: TOptions]
  : [params?: RouteParams, options?: TOptions]

function generator(helper: string): UrlGenerator {
  return currentApplication(helper).container.make(UrlGeneratorToken)
}

/**
 * Build the URL of a named route of the current app (the callable half of the `route` export).
 *
 * @example
 * routeUrl('posts.show', { post }) // '/api/posts/hello-world'
 */
export function routeUrl<TName extends RouteName>(
  name: TName,
  ...args: RouteArguments<TName>
): string {
  const [params, options] = args
  return generator('route()').route(name, params, options)
}

/**
 * The `url` helper: signed links for the current app, typed like `route()`.
 *
 * @example
 * url.signedRoute('unsubscribe', { user }, { expiresIn: 86_400 })
 * url.temporarySignedRoute('downloads.show', new Date(Date.now() + 60_000), { file })
 */
export interface UrlHelper {
  /** The URL of a named route (same as `route()`). */
  route<TName extends RouteName>(name: TName, ...args: RouteArguments<TName>): string
  /** A signed URL (permanent, or with `expiresIn` seconds / `oneTime`). */
  signedRoute<TName extends RouteName>(
    name: TName,
    ...args: RouteArguments<TName, SignedRouteOptions>
  ): string
  /** A signed URL that expires at `expiresAt`. */
  temporarySignedRoute<TName extends RouteName>(
    name: TName,
    expiresAt: Date | number,
    ...args: RouteArguments<TName, UrlOptions & { readonly oneTime?: boolean }>
  ): string
}

/**
 * The `url` helper object (Laravel's `URL::` facade, without global state).
 *
 * @example
 * const link = url.signedRoute('unsubscribe', { user: 7 })
 */
export const url: UrlHelper = {
  route: (name, ...args) => generator('url.route()').route(name, args[0], args[1]),
  signedRoute: (name, ...args) =>
    generator('url.signedRoute()').signedRoute(name, args[0], args[1]),
  temporarySignedRoute: (name, expiresAt, ...args) =>
    generator('url.temporarySignedRoute()').temporarySignedRoute(name, expiresAt, args[0], args[1]),
}
