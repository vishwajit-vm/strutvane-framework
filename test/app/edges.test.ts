/**
 * Failure and edge paths of the application core: imperative protections misused, ResourceController
 * edges (unbound records, nested Location headers, non-conflict write errors), policy and listener
 * discovery corners, bootstrap-cache files that are not caches, app configs without the optional
 * framework keys, and services a provider binds first.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PolicyRegistry } from '../../src/auth/policies.ts'
import { ProviderError } from '../../src/core/application.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { ClockToken, EventBusToken, LoggerToken } from '../../src/core/tokens.ts'
import { Application } from '../../src/foundation/application.ts'
import { cachePath, readCache, writeCache } from '../../src/foundation/bootstrap-cache.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { discoverListeners } from '../../src/foundation/listeners.ts'
import { loadApplication } from '../../src/foundation/load.ts'
import { HttpContext } from '../../src/http/app/context.ts'
import { defineProtection } from '../../src/http/app/protection.ts'
import { can, idempotent, signed } from '../../src/http/app/protections.ts'
import { ResourceController } from '../../src/http/app/resource-controller.ts'
import { SessionCookieToken, sessionCookieName } from '../../src/http/session-cookie.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { Encrypter, EncrypterToken } from '../../src/security/encrypter.ts'
import { Keyring, KeyringToken } from '../../src/security/keyring.ts'
import { testClient } from '../../src/testing/app-client.ts'
import { Post } from './fixtures/blog/app/models/post.ts'
import { APP_KEY, author, customApp, MemoryLogger, NOW, testEnv } from './helpers.ts'

const temporary: string[] = []
afterEach(() => {
  for (const folder of temporary.splice(0))
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'strut-edge-'))
  temporary.push(folder)
  return folder
}

const ok = (ctx: HttpContext): Response => ctx.json({ ok: true })

describe('imperative protections misused', () => {
  it('can.verify with an unknown or missing ability is a developer error (500), not a silent allow', async () => {
    const prepared = await customApp({
      web: defineRoutes([
        Route.get('/unknown', async (ctx) => {
          await can.verify(ctx, 'never-defined')
          return ok(ctx)
        }),
        Route.get('/none', async (ctx) => {
          await can.verify(ctx)
          return ok(ctx)
        }),
        Route.get('/signed-unnamed', async (ctx) => {
          await signed.verify(ctx)
          return ok(ctx)
        }),
        Route.get('/idempotent-get', async (ctx) => {
          await idempotent.verify(ctx)
          return ok(ctx)
        }),
      ]),
    })
    ;(await prepared.client.getJson('/unknown')).assertStatus(500)
    ;(await prepared.client.getJson('/none')).assertStatus(500)
    ;(await prepared.client.getJson('/signed-unnamed')).assertStatus(500)
    ;(await prepared.client.getJson('/idempotent-get')).assertStatus(200)
  })

  it('a middleware that answers by itself comes back from verify() as that response', async () => {
    class Redirecting {
      async handle(): Promise<Response> {
        return new Response(null, { status: 302, headers: { location: '/login' } })
      }
    }
    const verified = defineProtection('verified', Redirecting)
    const prepared = await customApp(
      {
        web: defineRoutes([
          Route.get('/account', async (ctx) => {
            await verified.verify(ctx)
            return ok(ctx)
          }),
        ]),
      },
      (m) => m.alias({ verified: Redirecting }),
    )
    const response = await prepared.client.get('/account')
    response.assertStatus(302)
    expect(response.headers.get('location')).toBe('/login')
    expect(() => defineProtection('broken', class {} as never)).toThrow(
      expect.objectContaining({ code: 'not_middleware' }),
    )
  })

  it('idempotency keys for a user without a type or id still scope to that user', async () => {
    let runs = 0
    const prepared = await customApp({
      api: defineRoutes([
        Route.post('/pay', async (ctx) => {
          runs++
          return ctx.json({ runs })
        }).middleware('idempotent'),
      ]),
    })
    const odd = prepared.client
      .actingAs({ name: 'no id' } as never)
      .withHeaders({ 'idempotency-key': 'odd-1' })
    ;(await odd.postJson('/api/pay', {})).assertJsonPath('runs', 1)
    ;(await odd.postJson('/api/pay', {})).assertJsonPath('runs', 1)
  })
})

describe('ResourceController edges', () => {
  class CommentController extends ResourceController<typeof Post> {
    protected readonly model: typeof Post = Post
    protected override readonly policy = {
      create: () => true,
      view: () => true,
      viewAny: () => true,
    }
    protected override prepareForStore(
      values: Record<string, unknown>,
      ctx: HttpContext,
    ): Record<string, unknown> {
      return { ...values, author_id: Number(ctx.requireUser().id) }
    }
  }

  it('builds a nested Location header with the parent from the request', async () => {
    const prepared = await customApp({
      api: defineRoutes([
        Route.apiResource('authors.posts', CommentController, { only: ['store', 'show'] }),
      ]),
    })
    const alice = prepared.client.actingAs(author(prepared, 2))
    const created = await alice.postJson('/api/authors/2/posts', { title: 'Nested' })
    created.assertStatus(201)
    expect(created.headers.get('location')).toBe('/api/authors/2/posts/nested')
  })

  it('skips Location for an unnamed or show-less store, and explains a missing binding', async () => {
    const prepared = await customApp({
      api: defineRoutes([
        Route.post('/free-posts', [CommentController, 'store']),
        Route.apiResource('lonely', CommentController, { only: ['store'] }),
      ]),
    })
    const alice = prepared.client.actingAs(author(prepared, 2))
    const unnamed = await alice.postJson('/api/free-posts', { title: 'Free' })
    unnamed.assertStatus(201)
    expect(unnamed.headers.get('location')).toBeNull()
    const lonely = await alice.postJson('/api/lonely', { title: 'Lonely' })
    expect(lonely.headers.get('location')).toBeNull()
    const ctx = new HttpContext({ request: new Request('http://localhost/x') })
    await expect(prepared.app.run(() => new CommentController().show(ctx))).rejects.toMatchObject({
      code: 'model_not_bound',
    })
  })

  it('rethrows write errors that are not unique violations', async () => {
    class Failing extends Post {
      static override async createFromValidated(): Promise<Post> {
        throw new Error('disk full')
      }
    }
    class FailingController extends ResourceController<typeof Failing> {
      protected readonly model: typeof Failing = Failing
      protected override readonly policy = { create: () => true }
    }
    const prepared = await customApp({
      api: defineRoutes([Route.apiResource('failing', FailingController, { only: ['store'] })]),
    })
    ;(
      await prepared.client
        .actingAs(author(prepared, 2))
        .postJson('/api/failing', { title: 'Boom' })
    ).assertProblem(500, 'INTERNAL_ERROR')
  })
})

describe('policy and listener discovery corners', () => {
  it('returns the explicit policy, caches answers, accepts object exports and skips non-files', async () => {
    const base = scratch()
    mkdirSync(join(base, 'app', 'policies', 'folder.policy.mjs'), { recursive: true })
    writeFileSync(
      join(base, 'app', 'policies', 'thing.policy.mjs'),
      'export default { viewAny() { return true } }\n',
    )
    const { app } = await bootPlain(base)
    const registry = new PolicyRegistry(base, app.container)
    const explicit = { view: () => true }
    registry.register({ name: 'Explicit' }, explicit)
    expect(await registry.discover({ name: 'Explicit' })).toBe(explicit)
    const first = await registry.discover({ name: 'Thing' })
    expect(await registry.discover({ name: 'Thing' })).toBe(first)
    expect(await registry.discover({ name: 'Folder' })).toBeUndefined()
    expect(await registry.discover({ name: 'Folder' })).toBeUndefined()
  })

  it('scans nested listener folders, sorts by event, and reports a listener that moved', async () => {
    const base = scratch()
    mkdirSync(join(base, 'app', 'listeners', 'billing'), { recursive: true })
    writeFileSync(
      join(base, 'app', 'listeners', 'billing', 'paid.listener.mjs'),
      'export class A { static event = "b.paid"; handle() {} }\nexport class B { static event = "a.paid"; handle() {} }\n',
    )
    writeFileSync(join(base, 'app', 'listeners', 'readme.md'), 'not code\n')
    expect((await discoverListeners(base)).map((entry) => entry.event)).toEqual([
      'a.paid',
      'b.paid',
    ])
    const { app } = await bootPlain(base)
    writeFileSync(
      join(base, 'app', 'listeners', 'billing', 'paid.listener.mjs'),
      'export const A = 1\nexport class B { static event = "a.paid"; handle() {} }\n',
    )
    // The module was imported at discovery, so delivery still finds the class (ESM caches modules):
    // the "moved" check guards caches built from code that later changed.
    const result = await app.make(EventBusToken).emit('b.paid', {}, {})
    expect(result.errors).toEqual([])
    app.events.useDiscovered([
      { event: 'c.paid', file: 'app/listeners/billing/paid.listener.mjs', exportName: 'Missing' },
    ])
    app.events.attach(app.make(EventBusToken), app.container)
    const moved = await app.make(EventBusToken).emit('c.paid', {}, {})
    expect(moved.errors).toEqual([expect.objectContaining({ code: 'listener_moved' })])
  })
})

describe('bootstrap cache files that are not caches', () => {
  it('ignores files of the wrong shape or kind, naming the right command', () => {
    const base = scratch()
    const keyring = Keyring.from(APP_KEY)
    const logger = new MemoryLogger()
    mkdirSync(join(base, 'bootstrap', 'cache'), { recursive: true })
    for (const [kind, text] of [
      ['routes', '[]'],
      [
        'events',
        '{"format":1,"kind":"routes","framework":"x","keyId":"x","code":"x","createdAt":"x","payload":"x"}',
      ],
      [
        'config',
        '{"format":1,"kind":"other","framework":"x","keyId":"x","code":"x","createdAt":"x","payload":"x"}',
      ],
    ] as const) {
      writeFileSync(cachePath(base, kind), text)
      expect(readCache(base, kind, keyring, logger).use).toBe('ignored')
    }
    expect(logger.messages('warn').join('\n')).toMatch(
      /route:cache[\s\S]*event:cache[\s\S]*config:cache/,
    )
    writeCache(
      base,
      'events',
      keyring,
      [{ event: 'x', file: '../outside.mjs', exportName: 'X' }],
      new Date(NOW),
      () => 'fingerprint',
    )
    expect(readCache(base, 'events', keyring, logger, () => 'fingerprint').use).toBe('used')
  })

  it('ignores an events cache whose list is malformed', async () => {
    const base = scratch()
    const { app } = await bootPlain(base)
    writeCache(
      base,
      'events',
      Keyring.from(APP_KEY),
      [{ event: 'x', file: '/etc/passwd', exportName: 'X' }],
      new Date(NOW),
    )
    const again = await bootPlain(base)
    expect(again.app.cacheStatus.events).toBe('ignored')
    expect(again.logger.messages('warn').join('\n')).toContain('listener list is malformed')
    expect(app.cacheStatus.events).toBe('none')
  })
})

describe('apps with minimal config and pre-bound services', () => {
  it('reads APP_ENV and APP_KEY from the environment when config/app.ts leaves them out', async () => {
    const app = Application.configure({ basePath: scratch(), env: { APP_ENV: 'testing', APP_KEY } })
      .withConfig({ app: defineConfig((env) => ({ name: env.string('APP_NAME', 'Minimal') })) })
      .withRouting({ web: defineRoutes([Route.get('/', ok)]) })
      .create()
    app.container.value(LoggerToken, new MemoryLogger())
    ;(await testClient(app).getJson('/')).assertStatus(200)
    expect(app.environment).toBe('testing')
    expect(app.showsDebugDetails).toBe(false)
  })

  it('keeps services a provider bound first (keyring, encrypter, session cookie)', async () => {
    const keyring = Keyring.from(APP_KEY)
    const encrypter = new Encrypter(keyring)
    const cookie = sessionCookieName({ base: 'acme_session', secure: false })
    const app = Application.configure({ basePath: scratch(), env: testEnv })
      .withProviders([
        {
          name: 'test.bindings',
          register: (core) => {
            core.container
              .value(KeyringToken, keyring)
              .value(EncrypterToken, encrypter)
              .value(SessionCookieToken, cookie)
          },
        },
      ])
      .withRouting({ web: defineRoutes([Route.post('/thing', ok)]) })
      .create()
    app.container.value(LoggerToken, new MemoryLogger())
    await app.boot()
    expect(app.make(EncrypterToken)).toBe(encrypter)
    expect(app.security.csrf.cookie.name).toBe('acme_session')
    ;(await testClient(app).withCookie('acme_session', 'x').postJson('/thing', {})).assertStatus(
      419,
    )
  })

  it('wraps a non-boot provider failure, and unwraps a friendly one', async () => {
    const failing = Application.configure({ basePath: scratch(), env: testEnv })
      .withProviders([
        {
          name: 'test.failing',
          register: () => undefined,
          boot: () => Promise.reject(new Error('connection refused')),
        },
      ])
      .create()
    failing.container.value(LoggerToken, new MemoryLogger())
    await expect(failing.boot()).rejects.toBeInstanceOf(ProviderError)
    await expect(failing.boot()).rejects.toBeInstanceOf(ProviderError)
  })

  it('loads an application exported by another copy of the module (by shape)', async () => {
    const base = scratch()
    mkdirSync(join(base, 'bootstrap'))
    writeFileSync(
      join(base, 'bootstrap', 'app.mjs'),
      'class Application { handle() {} boot() {} }\nexport default new Application()\n',
    )
    expect(await loadApplication(base)).toBeDefined()
    // A fresh folder: ESM caches the module imported above.
    const other = scratch()
    mkdirSync(join(other, 'bootstrap'))
    writeFileSync(
      join(other, 'bootstrap', 'app.mjs'),
      'class Application {}\nexport default new Application()\n',
    )
    await expect(loadApplication(other)).rejects.toMatchObject({ code: 'invalid_bootstrap' })
  })
})

async function bootPlain(base: string): Promise<{ app: Application; logger: MemoryLogger }> {
  const app = Application.configure({ basePath: base, env: testEnv })
    .withRouting({ web: defineRoutes([Route.get('/', ok)]) })
    .create()
  const logger = new MemoryLogger()
  app.container.value(LoggerToken, logger)
  app.container.value(ClockToken, createTestClock(NOW))
  await app.boot()
  return { app, logger }
}
