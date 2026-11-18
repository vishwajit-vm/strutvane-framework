/**
 * The types an app needs to declare its typed registries are exported from the package entry
 * (0.2.0-next.0 left `ConfigOf` and `RoutesOf` out). The full augmentation is compiled in
 * test/routing/registry-typecheck.test.ts; this proves what each type computes.
 */
import { describe, expectTypeOf, test } from 'vitest'
import {
  type ConfigFiles,
  type ConfigOf,
  type ConfigRegistry,
  defineConfig,
  defineRoutes,
  Route,
  type RouteRegistry,
  type RoutesOf,
  type UserRegistry,
} from '../../src/index.ts'

const settings = {
  app: defineConfig((env) => ({
    name: env.string('APP_NAME', 'Typed'),
    debug: env.boolean('APP_DEBUG', false),
  })),
}
const web = defineRoutes([Route.get('/', (ctx) => ctx.json({})).name('home')])
const api = defineRoutes([Route.get('/posts/{post}', (ctx) => ctx.json({})).name('posts.show')])

describe('public registry types', () => {
  test('ConfigOf turns config files into the config tree', () => {
    expectTypeOf(settings).toExtend<ConfigFiles>()
    expectTypeOf<ConfigOf<typeof settings>['app']['debug']>().toEqualTypeOf<boolean>()
    expectTypeOf<ConfigOf<typeof settings>['app']['name']>().toEqualTypeOf<string>()
    // @ts-expect-error: not a key of the tree
    expectTypeOf<ConfigOf<typeof settings>['app']['nmae']>()
  })

  test('RoutesOf collects every named route of the routes files', () => {
    expectTypeOf<keyof RoutesOf<[typeof web, typeof api]>>().toEqualTypeOf<'home' | 'posts.show'>()
    expectTypeOf<RoutesOf<[typeof api]>['posts.show']>().toHaveProperty('post')
  })

  test('the registries are empty until the app augments them', () => {
    expectTypeOf<keyof RouteRegistry>().toBeNever()
    expectTypeOf<keyof ConfigRegistry>().toBeNever()
    expectTypeOf<keyof UserRegistry>().toBeNever()
  })
})
