/**
 * Type-level tests for the application core. Every `@ts-expect-error` must really be an error and
 * every `expectTypeOf` must hold. Code inside `typeOnly` never runs: it only has to compile (or
 * not). The *filled-in* registries (an app's `declare module` block) are proven in a separate
 * compile, `registry-typecheck.test.ts`, because this repository's `isolatedDeclarations` can't
 * infer `typeof web` for an augmentation; here the registries are empty, so the helpers fall
 * back to plain strings.
 */
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import type { Policy } from '../../src/auth/gate.ts'
import type { Actor } from '../../src/contracts/actor.ts'
import { createContainer, token } from '../../src/core/container.ts'
import type { ConfigOf, ConfigPath, ConfigValue } from '../../src/foundation/config.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { config } from '../../src/foundation/helpers.ts'
import { build, type CheckInjectable } from '../../src/foundation/inject.ts'
import type { AuthUser } from '../../src/foundation/registry.ts'
import type { HttpContext } from '../../src/http/app/context.ts'
import { defineProtection } from '../../src/http/app/protection.ts'
import { auth, csrf } from '../../src/http/app/protections.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { route } from '../../src/routing/route-helper.ts'
import type {
  ParamsOf,
  RouteParam,
  RoutesOf,
  Singular,
  UntypedRoutes,
} from '../../src/routing/types.ts'
import { url } from '../../src/routing/url.ts'
import { FormRequest, type StandardSchema } from '../../src/validation/form-request.ts'
import { PingController } from '../app/fixtures/blog/app/http/controllers/ping.controller.ts'
import { PostController } from '../app/fixtures/blog/app/http/controllers/post.controller.ts'
import { SpaController } from '../app/fixtures/blog/app/http/controllers/spa.controller.ts'
import { StatsController } from '../app/fixtures/blog/app/http/controllers/stats.controller.ts'
import type { Post } from '../app/fixtures/blog/app/models/post.ts'

/** Wraps code that must type-check but never run (it would need a live app). */
function typeOnly(_check: () => void): void {}

const handler = (ctx: HttpContext): Response => ctx.json({})

const web = defineRoutes([
  Route.get('/', [SpaController, 'show']).name('home'),
  Route.get('/ping', PingController).name('ping'),
  Route.apiResource('posts', PostController, { bindBy: 'slug' }),
  Route.apiResource('posts.comments', PostController, { only: ['index', 'show'], shallow: true }),
  Route.singleton('profile', SpaController as never),
  Route.group({ prefix: 'teams/{team}', name: 'teams.' }, [
    Route.get('/members/{member}', handler).name('members.show'),
    Route.get('/hidden', handler),
  ]),
])
const viaCallback = defineRoutes((router) => [router.get('/cb/{id}', handler).name('cb.show')])
const voidCallback = defineRoutes((router) => {
  router.get('/void', handler).name('void.route')
})

describe('route names and parameters are typed from routes files', () => {
  it('folds every named route, with group prefixes, nesting and singletons', () => {
    type Names = keyof RoutesOf<[typeof web, typeof viaCallback]>
    expectTypeOf<Names>().toEqualTypeOf<
      | 'home'
      | 'ping'
      | 'posts.index'
      | 'posts.store'
      | 'posts.show'
      | 'posts.update'
      | 'posts.destroy'
      | 'posts.comments.index'
      | 'posts.comments.show'
      | 'profile.show'
      | 'profile.edit'
      | 'profile.update'
      | 'teams.members.show'
      | 'cb.show'
    >()
  })

  it("types each route's parameters (shallow members drop the parent)", () => {
    type Registry = RoutesOf<[typeof web]>
    expectTypeOf<Registry['posts.show']>().toEqualTypeOf<ParamsOf<'/posts/{post:slug}'>>()
    expectTypeOf<keyof Registry['posts.comments.index']>().toEqualTypeOf<'post'>()
    expectTypeOf<keyof Registry['posts.comments.show']>().toEqualTypeOf<'comment'>()
    expectTypeOf<keyof Registry['teams.members.show']>().toEqualTypeOf<'team' | 'member'>()
    expectTypeOf<keyof Registry['home']>().toEqualTypeOf<never>()
    expectTypeOf<Registry['posts.show']['post']>().toEqualTypeOf<RouteParam>()
  })

  it('a void callback contributes untyped (string) names: the documented trade-off', () => {
    expectTypeOf(voidCallback.__routes).toEqualTypeOf<UntypedRoutes>()
    type Mixed = RoutesOf<[typeof web, typeof voidCallback]>
    expectTypeOf<'anything.at.all'>().toExtend<keyof Mixed>()
  })

  it('names resource parameters with the same singular rule as the runtime', () => {
    expectTypeOf<Singular<'posts'>>().toEqualTypeOf<'post'>()
    expectTypeOf<Singular<'categories'>>().toEqualTypeOf<'category'>()
    expectTypeOf<Singular<'addresses'>>().toEqualTypeOf<'address'>()
    expectTypeOf<Singular<'news'>>().toEqualTypeOf<'new'>() // the honest limit: use `parameter`
  })

  it('accepts any name while the app has not filled in RouteRegistry', () => {
    typeOnly(() => {
      route('posts.show', { post: 'hello' })
      route('anything')
      url.signedRoute('unsubscribe', { user: 1 }, { expiresIn: 60, oneTime: true })
      url.temporarySignedRoute('downloads.show', new Date(), { file: 7 })
      // @ts-expect-error: a boolean can't fill a URL parameter
      route('posts.show', { post: true })
    })
  })
})

describe('controller method references are checked', () => {
  it('rejects a method the controller does not have, or a property that is not an action', () => {
    typeOnly(() => {
      Route.get('/posts', [PostController, 'index'])
      Route.post('/posts/{post}/publish', [PostController, 'publish'])
      Route.post('/ping', PingController)
      // @ts-expect-error: PostController has no `nope` action
      Route.get('/posts', [PostController, 'nope'])
      // @ts-expect-error: `resourceMetadata` takes no context and returns metadata, not a Response
      Route.get('/posts', [PostController, 'resourceMetadata'])
      // @ts-expect-error: StatsController has no __invoke, so it isn't invokable
      Route.get('/stats', StatsController)
    })
  })

  it('requires every resource action to exist on the controller', () => {
    typeOnly(() => {
      Route.apiResource('posts', PostController)
      Route.resource('posts', PostController, {
        only: ['index', 'show', 'store', 'update', 'destroy'],
      })
      // @ts-expect-error: a full resource needs create() and edit(), which PostController lacks
      Route.resource('posts', PostController)
      // @ts-expect-error: SpaController has no index/store/update/destroy
      Route.apiResource('posts', SpaController)
    })
  })
})

describe('container injection is checked against constructors', () => {
  it('accepts a matching inject list and rejects a wrong one', () => {
    const container = createContainer()
    typeOnly(() => {
      expectTypeOf(build(container, StatsController)).toEqualTypeOf<StatsController>()
    })
    class WrongInject {
      static readonly inject: readonly [typeof Count] = [Count] as const
      readonly value: string
      constructor(value: string) {
        this.value = value
      }
    }
    expectTypeOf<CheckInjectable<typeof WrongInject>>().toBeNever()
    typeOnly(() => {
      // @ts-expect-error: inject resolves a number, the constructor wants a string
      build(container, WrongInject)
    })
  })
})

const Count = token<number>('count')

describe('config, the user and requests are typed', () => {
  it('types config files, paths and values', () => {
    const files = {
      app: defineConfig((env) => ({
        debug: env.boolean('APP_DEBUG', false),
        env: env.oneOf('APP_ENV', ['local', 'production']),
        nested: { port: env.integer('PORT', 3000) },
      })),
    }
    type Tree = ConfigOf<typeof files>
    expectTypeOf<ConfigValue<Tree, 'app.debug'>>().toEqualTypeOf<boolean>()
    expectTypeOf<ConfigValue<Tree, 'app.env'>>().toEqualTypeOf<'local' | 'production'>()
    expectTypeOf<ConfigValue<Tree, 'app.nested.port'>>().toEqualTypeOf<number>()
    expectTypeOf<'app.nmae'>().not.toExtend<ConfigPath<Tree>>()
    typeOnly(() => {
      // Before the app fills in ConfigRegistry, any key is accepted and the value is unknown.
      expectTypeOf(config('anything')).toEqualTypeOf<unknown>()
    })
  })

  it('types the user as the contracts Actor until the app says otherwise', () => {
    expectTypeOf<AuthUser>().toEqualTypeOf<Actor>()
    typeOnly(() => {
      const ctx = {} as HttpContext
      expectTypeOf(ctx.user).toEqualTypeOf<Actor | null>()
      expectTypeOf(ctx.requireUser()).toEqualTypeOf<Actor>()
    })
  })

  it('checks policy method signatures against the model', () => {
    class Wrong implements Policy<Post> {
      // @ts-expect-error: the record must be a Post, not a number
      update(_user: AuthUser | null, _post: number): boolean {
        return false
      }
    }
    expectTypeOf<Wrong>().not.toBeAny()
  })

  it('types validated form request output', () => {
    class Store extends FormRequest<{ title: string }> {
      rules(): StandardSchema<{ title: string }> {
        return z.object({ title: z.string() })
      }
    }
    typeOnly(() => {
      expectTypeOf(new Store().validate({} as HttpContext)).resolves.toEqualTypeOf<{
        title: string
      }>()
    })
  })

  it('types the protections: csrf.token only on csrf, defineProtection needs a middleware class', () => {
    typeOnly(() => {
      expectTypeOf(csrf.token({} as HttpContext)).toEqualTypeOf<string>()
      // @ts-expect-error: only the csrf protection hands out tokens
      auth.token({} as HttpContext)
      // @ts-expect-error: a protection is built from a class with handle(ctx, next)
      defineProtection('nope', class {})
    })
  })
})
