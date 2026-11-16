/**
 * Routing without HTTP: the builders (value and callback styles, and the collector that lets
 * them mix), resources (nested, shallow), singletons, fallbacks, compilation (prefixes, names,
 * middleware order, duplicates, malformed parameters), matching, and URL generation.
 */
import { describe, expect, it } from 'vitest'
import type { HttpContext } from '../../src/http/app/context.ts'
import { collectRoutes, defineRoutes, Route, routeEntries } from '../../src/routing/route.ts'
import { route } from '../../src/routing/route-helper.ts'
import {
  allowedMethods,
  compileRoutes,
  fallbackFor,
  joinPath,
  matchRoute,
  parseParameters,
} from '../../src/routing/router.ts'
import { UrlGenerator } from '../../src/routing/url.ts'
import { Keyring } from '../../src/security/keyring.ts'
import { UrlSigner } from '../../src/security/signer.ts'
import { APP_KEY } from '../app/helpers.ts'

/** A controller with all seven resource actions. */
class PhotoController {
  index(ctx: HttpContext): Response {
    return ctx.json('index')
  }
  create(ctx: HttpContext): Response {
    return ctx.json('create')
  }
  store(ctx: HttpContext): Response {
    return ctx.json('store')
  }
  show(ctx: HttpContext): Response {
    return ctx.json('show')
  }
  edit(ctx: HttpContext): Response {
    return ctx.json('edit')
  }
  update(ctx: HttpContext): Response {
    return ctx.json('update')
  }
  destroy(ctx: HttpContext): Response {
    return ctx.json('destroy')
  }
}

const ok = (): Response => new Response('ok')
const table = (files: Parameters<typeof compileRoutes>[0]) => compileRoutes(files).routes
const rows = (files: Parameters<typeof compileRoutes>[0]) =>
  table(files).map((compiled) => [compiled.methods.join('|'), compiled.uri, compiled.name])

describe('Route.resource, apiResource and singletons', () => {
  it("generate Laravel's seven routes, names and order", () => {
    expect(rows({ web: [Route.resource('photos', PhotoController)] })).toEqual([
      ['GET', '/photos', 'photos.index'],
      ['GET', '/photos/create', 'photos.create'],
      ['POST', '/photos', 'photos.store'],
      ['GET', '/photos/{photo}', 'photos.show'],
      ['GET', '/photos/{photo}/edit', 'photos.edit'],
      ['PUT|PATCH', '/photos/{photo}', 'photos.update'],
      ['DELETE', '/photos/{photo}', 'photos.destroy'],
    ])
  })

  it('apiResource drops the form pages and lives under /api with the api group', () => {
    const compiled = table({ api: [Route.apiResource('photos', PhotoController)] })
    expect(compiled.map((entry) => entry.name)).toEqual([
      'photos.index',
      'photos.store',
      'photos.show',
      'photos.update',
      'photos.destroy',
    ])
    expect(compiled[0]?.uri).toBe('/api/photos')
    expect(compiled[0]?.middleware).toEqual(['api'])
  })

  it('supports only, except, a custom parameter, slug binding and per-action middleware', () => {
    const compiled = table({
      web: [
        Route.resource('people', PhotoController, { only: ['index', 'show'], parameter: 'person' }),
        Route.resource('photos', PhotoController, {
          except: ['create', 'edit', 'destroy'],
          bindBy: 'slug',
        })
          .middlewareFor(['store', 'update'], 'auth')
          .middleware('verified')
          .withoutMiddleware('throttle'),
      ],
    })
    expect(compiled.map((entry) => entry.uri)).toEqual([
      '/people',
      '/people/{person}',
      '/photos',
      '/photos',
      '/photos/{photo:slug}',
      '/photos/{photo:slug}',
    ])
    expect(compiled.find((entry) => entry.name === 'photos.store')?.middleware).toEqual([
      'web',
      'verified',
      'auth',
    ])
    expect(compiled.find((entry) => entry.name === 'photos.show')?.parameters).toEqual([
      { name: 'photo', field: 'slug' },
    ])
    expect(compiled.find((entry) => entry.name === 'photos.show')?.excluded).toEqual([
      { alias: 'throttle', source: 'route' },
    ])
  })

  it('nests resources, and shallow nesting drops the parent from member routes', () => {
    expect(
      rows({
        web: [
          Route.resource('posts.comments', PhotoController, { only: ['index', 'store', 'show'] }),
        ],
      }),
    ).toEqual([
      ['GET', '/posts/{post}/comments', 'posts.comments.index'],
      ['POST', '/posts/{post}/comments', 'posts.comments.store'],
      ['GET', '/posts/{post}/comments/{comment}', 'posts.comments.show'],
    ])
    expect(
      rows({ web: [Route.apiResource('posts.comments', PhotoController, { shallow: true })] }).map(
        (row) => row[1],
      ),
    ).toEqual([
      '/posts/{post}/comments',
      '/posts/{post}/comments',
      '/comments/{comment}',
      '/comments/{comment}',
      '/comments/{comment}',
    ])
  })

  it('singletons have no id; creatable() adds create, store and destroy', () => {
    expect(rows({ web: [Route.singleton('profile', PhotoController)] })).toEqual([
      ['GET', '/profile', 'profile.show'],
      ['GET', '/profile/edit', 'profile.edit'],
      ['PUT|PATCH', '/profile', 'profile.update'],
    ])
    expect(
      rows({
        web: [
          Route.singleton('profile', PhotoController)
            .creatable()
            .middlewareFor(['update'], 'auth')
            .middleware('verified')
            .withoutMiddleware('throttle'),
        ],
      }).map((row) => row[2]),
    ).toEqual([
      'profile.create',
      'profile.store',
      'profile.show',
      'profile.edit',
      'profile.update',
      'profile.destroy',
    ])
    expect(
      rows({ api: [Route.apiSingleton('settings', PhotoController).creatable()] }).map(
        (row) => row[2],
      ),
    ).toEqual(['settings.store', 'settings.show', 'settings.update', 'settings.destroy'])
  })

  it('refuses names that are not table-style', () => {
    expect(() => Route.resource('Photos', PhotoController)).toThrow(/not a valid resource name/)
    expect(() => Route.resource('a.b.c', PhotoController)).toThrow(/not a valid resource name/)
    expect(() => Route.singleton('my.profile', PhotoController)).toThrow(
      /not a valid singleton name/,
    )
  })
})

describe('groups, callbacks and the collector', () => {
  it('nest prefixes, name prefixes and middleware in order (array style)', () => {
    const compiled = table({
      web: [
        Route.group({ prefix: 'admin', name: 'admin.', middleware: ['auth'] }, [
          Route.group({ prefix: '/teams/{team}/', name: 'teams.', middleware: ['throttle:10,1'] }, [
            Route.get('/members', ok).name('members').middleware('admin'),
          ]),
        ]),
      ],
    })
    expect(compiled[0]).toMatchObject({
      uri: '/admin/teams/{team}/members',
      name: 'admin.teams.members',
      middleware: ['web', 'auth', 'throttle:10,1', 'admin'],
    })
  })

  it('register routes inside callbacks, Laravel-style, with names applied once', () => {
    const entries = collectRoutes((router) => {
      router.get('/', ok).name('home')
      router
        .prefix('admin')
        .name('admin.')
        .middleware('auth')
        .group(() => {
          router.get('/stats', ok).name('stats')
          router
            .middleware('can:view')
            .withoutMiddleware('throttle')
            .group(() => {
              router.post('/purge', ok).name('purge')
            })
        })
      router
        .apiResource('photos', PhotoController, { only: ['index'] })
        .middlewareFor(['index'], 'auth')
    })
    expect(rows({ web: entries })).toEqual([
      ['GET', '/', 'home'],
      ['GET', '/admin/stats', 'admin.stats'],
      ['POST', '/admin/purge', 'admin.purge'],
      ['GET', '/photos', 'photos.index'],
    ])
    const purge = table({ web: entries }).find((entry) => entry.name === 'admin.purge')
    expect(purge?.middleware).toEqual(['web', 'auth', 'can:view'])
    expect(purge?.excluded).toEqual([{ alias: 'throttle', source: 'group' }])
  })

  it('adopts entries placed in arrays inside a callback, so nothing registers twice', () => {
    const entries = collectRoutes((router) => {
      router.group({ prefix: 'v1' }, [router.get('/a', ok).name('a'), router.get('/b', ok)])
      router.middleware('auth').group([router.post('/c', ok)])
      return [router.get('/returned', ok).name('returned')]
    })
    expect(rows({ web: entries })).toEqual([
      ['GET', '/v1/a', 'a'],
      ['GET', '/v1/b', undefined],
      ['POST', '/c', undefined],
      ['GET', '/returned', 'returned'],
    ])
  })

  it('a callback may return its routes; defineRoutes takes either form', () => {
    const fromCallback = defineRoutes((router) => [router.get('/x', ok).name('x')])
    expect(fromCallback.entries).toHaveLength(1)
    const voidCallback = defineRoutes((router) => {
      router.get('/y', ok)
    })
    expect(voidCallback.entries).toHaveLength(1)
    expect(routeEntries((router) => void router.get('/z', ok))).toHaveLength(1)
  })

  it('refuses asynchronous callbacks and non-route return values', () => {
    expect(() => collectRoutes(async () => undefined)).toThrow(/returned a Promise/)
    expect(() => collectRoutes(() => [{ not: 'a route' }] as never)).toThrow(
      /something other than a list of routes/,
    )
    expect(() => defineRoutes([{ kind: 'route' }] as never)).toThrow(/not a route/)
    expect(() => routeEntries(42 as never)).toThrow(/neither a routes list nor a routes callback/)
  })

  it('are immutable outside callbacks: naming returns a new route', () => {
    const base = Route.get('/a', ok)
    const named = base.name('a')
    expect(base.routeName).toBeUndefined()
    expect(named.routeName).toBe('a')
    expect(Route.match(['GET', 'POST'], '/m', ok).methods).toEqual(['GET', 'POST'])
    expect(Route.any('/any', ok).methods).toContain('DELETE')
    expect(() => Route.match(['TRACE' as never], '/t', ok)).toThrow(/not an HTTP method/)
  })

  it('refuse duplicate names, duplicate endpoints and two fallbacks in one file', () => {
    expect(() =>
      table({ web: [Route.get('/a', ok).name('x'), Route.get('/b', ok).name('x')] }),
    ).toThrow(/Two routes are named "x": \/a and \/b/)
    expect(() => table({ web: [Route.get('/p/{id}', ok), Route.get('/p/{post}', ok)] })).toThrow(
      /GET \/p\/\{post\} is registered twice/,
    )
    expect(() => table({ web: [Route.fallback(ok), Route.fallback(ok)] })).toThrow(
      /fallback\(\) 2 times/,
    )
  })

  it('refuse malformed parameters', () => {
    expect(() => parseParameters('/posts/{post')).toThrow(/unmatched brace/)
    expect(() => parseParameters('/posts/{po st}')).toThrow(/not a valid route parameter/)
    expect(() => parseParameters('/posts/{a:b:c}')).toThrow(/not a valid route parameter/)
    expect(() => parseParameters('/a/{x}/b/{x}')).toThrow(/uses \{x\} twice/)
  })

  it('normalise slashes', () => {
    expect(joinPath('/api/', '//admin', 'posts/')).toBe('/api/admin/posts')
    expect(joinPath('', '')).toBe('/')
  })
})

describe('matching, 405s and fallbacks', () => {
  const compiled = compileRoutes({
    web: [
      Route.get('/posts/create', ok).name('create'),
      Route.get('/posts/{post}', ok).name('show'),
      Route.post('/contact', ok),
      Route.fallback(ok),
    ],
    api: [Route.get('/items/{item}', ok), Route.fallback(ok)],
  })

  it('matches in registration order, decodes parameters, and answers HEAD with GET routes', () => {
    expect(matchRoute(compiled.routes, 'GET', '/posts/create')?.route.name).toBe('create')
    expect(matchRoute(compiled.routes, 'HEAD', '/posts/hello%20world')?.params).toEqual({
      post: 'hello world',
    })
    expect(matchRoute(compiled.routes, 'GET', '/posts/%E0%A4%A')?.params).toEqual({
      post: '%E0%A4%A',
    })
    expect(matchRoute(compiled.routes, 'GET', '/posts/a/')?.route.name).toBe('show')
    expect(matchRoute(compiled.routes, 'DELETE', '/posts/a')).toBeUndefined()
  })

  it('lists allowed methods (HEAD with GET) for 405s', () => {
    expect(allowedMethods(compiled.routes, '/posts/a')).toEqual(['GET', 'HEAD'])
    expect(allowedMethods(compiled.routes, '/contact')).toEqual(['POST'])
    expect(allowedMethods(compiled.routes, '/nowhere')).toEqual([])
  })

  it('scopes fallbacks: the web fallback never answers API or framework paths', () => {
    expect(fallbackFor(compiled.fallbacks, '/some/page')?.prefix).toBe('/')
    expect(fallbackFor(compiled.fallbacks, '/api/unknown')?.prefix).toBe('/api')
    expect(fallbackFor(compiled.fallbacks, '/_strutvane/x')).toBeUndefined()
    const webOnly = compileRoutes({ web: [Route.fallback(ok)], api: [] })
    expect(fallbackFor(webOnly.fallbacks, '/api/x')).toBeUndefined()
    expect(fallbackFor(webOnly.fallbacks, '/apiary')?.prefix).toBe('/')
  })
})

describe('URL generation', () => {
  const compiled = compileRoutes({
    api: [
      Route.apiResource('posts', PhotoController, { bindBy: 'slug' }),
      Route.get('/search', ok).name('search'),
      Route.get('/plain/{id}', ok).name('plain'),
    ],
  }).routes
  const keyring = Keyring.from(APP_KEY)
  let clock = Date.UTC(2026, 0, 1)
  const urls = new UrlGenerator(compiled, {
    appUrl: 'https://blog.test/',
    signer: () => new UrlSigner(keyring),
    now: () => clock,
  })

  it('fills parameters from strings, numbers and models (by the bound field)', () => {
    const post = { routeKey: (field?: string) => (field === 'slug' ? 'hello world' : 7) }
    expect(urls.route('posts.show', { post: 'hello-world' })).toBe('/api/posts/hello-world')
    expect(urls.route('posts.show', { post })).toBe('/api/posts/hello%20world')
    expect(urls.route('posts.update', { post: 5 }, { absolute: true })).toBe(
      'https://blog.test/api/posts/5',
    )
    expect(urls.route('plain', { id: post })).toBe('/api/plain/7')
    expect(urls.has('posts.show')).toBe(true)
    expect(urls.parameters('posts.show')).toEqual(['post'])
    expect(urls.parameters('nope')).toEqual([])
  })

  it('puts extra parameters in the query string', () => {
    expect(urls.route('search', { q: 'a&b' }, { query: { page: 2 } })).toBe(
      '/api/search?q=a%26b&page=2',
    )
  })

  it('explains a missing parameter and suggests the right name', () => {
    expect(() => urls.route('posts.show', {})).toThrow(/needs a value for \{post\}/)
    expect(() => urls.route('posts.shwo')).toThrow(
      expect.objectContaining({
        message: 'No route is named "posts.shwo".',
        hint: 'Did you mean "posts.show"?',
      }),
    )
    expect(() => urls.route('zzzzzzzz')).toThrow(
      expect.objectContaining({ code: 'unknown_route_name' }),
    )
  })

  it('signs routes for their name, with an optional expiry', async () => {
    const signer = new UrlSigner(keyring)
    const permanent = urls.signedRoute('search', { q: 'x' })
    expect(await signer.verify(permanent, { purpose: 'route:search', now: clock })).toBe('valid')
    expect(await signer.verify(permanent, { purpose: 'route:plain', now: clock })).toBe(
      'invalid_signature',
    )
    const temporary = urls.temporarySignedRoute(
      'search',
      clock + 1000,
      { q: 'x' },
      { absolute: true },
    )
    expect(temporary.startsWith('https://blog.test/api/search?')).toBe(true)
    const expiring = urls.signedRoute('search', {}, { expiresIn: 1 })
    clock += 2000
    expect(await signer.verify(expiring, { purpose: 'route:search', now: clock })).toBe(
      'signature_expired',
    )
  })

  it('keeps the v1 builders on the route() helper', () => {
    expect(typeof route).toBe('function')
    expect(route.get('/hello', { public: true, handler: () => ({}) })).toMatchObject({
      method: 'get',
      path: '/hello',
    })
    expect(route.delete('/x', { public: true, handler: () => ({}) }).method).toBe('delete')
  })
})
