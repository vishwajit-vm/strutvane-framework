/**
 * The extension points add-on packages need from the v2 Application (redis, search, health,
 * log-viewer, social-login, import-export all hit these gaps on 0.2.0-next.1):
 * - providers read the merged environment and the config in `register()` (`app.env()`);
 * - packages register message catalogs at boot (`app.addMessages()`);
 * - packages add cache drivers (`CacheDriverRegistryToken`);
 * - the public exports add-ons import (policies, the gate, store tokens, `testClient`);
 * - an unset optional `APP_PREVIOUS_KEYS` / `APP_KEY` in config/app.ts no longer refuses boot.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CacheStore } from '../../src/cache/contract.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { StrutvaneError } from '../../src/core/errors/errors.ts'
import { defineMessages } from '../../src/core/messages/catalog.ts'
import {
  ClockToken,
  ErrorRegistryToken,
  LoggerToken,
  MessagesToken,
} from '../../src/core/tokens.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import * as framework from '../../src/index.ts'
import {
  Application,
  CacheDriverRegistryToken,
  CacheManagerToken,
  defineConfig,
  KeyringToken,
  MemoryCacheStore,
  ServiceProvider,
} from '../../src/index.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import * as testing from '../../src/testing/index.ts'
import { MemoryLogger, NOW, testEnv } from '../app/helpers.ts'

const temporary: string[] = []
afterEach(() => {
  for (const folder of temporary.splice(0))
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'strut-ext-'))
  temporary.push(folder)
  return folder
}

const appConfig = defineConfig((env) => ({
  name: env.string('APP_NAME', 'Ext'),
  env: env.string('APP_ENV', 'production'),
  debug: env.boolean('APP_DEBUG', false),
  url: env.string('APP_URL', 'http://localhost'),
  key: env.optional('APP_KEY'),
  previous_keys: env.optional('APP_PREVIOUS_KEYS'),
}))

function build(
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly providers?: Parameters<ReturnType<typeof Application.configure>['withProviders']>[0]
    readonly config?: Parameters<ReturnType<typeof Application.configure>['withConfig']>[0]
  } = {},
): Application {
  const app = Application.configure({
    basePath: scratch(),
    env: { ...testEnv, APP_DEBUG: 'false', ...options.env },
  })
    .withConfig({ app: appConfig, ...options.config })
    .withProviders(options.providers ?? [])
    .withRouting({
      web: defineRoutes([
        Route.get('/down', () => {
          throw new StrutvaneError('demo_unavailable', { status: 503 })
        }),
      ]),
    })
    .create()
  app.container.value(LoggerToken, new MemoryLogger())
  app.container.value(ClockToken, createTestClock(NOW))
  return app
}

async function bootError(app: Application): Promise<{ code: string; message: string }> {
  const error = await app.boot().then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (isBootError(error)) return error
  throw new Error(`Expected a boot error, got ${String(error)}`)
}

describe('optional keys in config/app.ts', () => {
  it('boots when APP_PREVIOUS_KEYS is read with env.optional() and unset (was the text "undefined")', async () => {
    const app = build()
    await app.boot()
    expect(app.make(KeyringToken).previous).toHaveLength(0)
  })

  it('still reads a set APP_PREVIOUS_KEYS, and an optional APP_KEY that is set', async () => {
    const old = `base64:${Buffer.alloc(32, 7).toString('base64')}`
    const app = build({ env: { APP_PREVIOUS_KEYS: old } })
    await app.boot()
    expect(app.make(KeyringToken).previous).toHaveLength(1)
    expect(app.make(KeyringToken).current).toBeDefined()
  })

  it('a bad previous key still refuses boot (the fix only covers "no value")', async () => {
    const failure = await bootError(build({ env: { APP_PREVIOUS_KEYS: 'not-a-key' } }))
    expect(failure.code).toBe('invalid_app_key')
  })
})

describe('app.env() for providers', () => {
  it('reads the merged environment and the config in register(), without the config tree', async () => {
    const seen: Record<string, unknown> = {}
    class RedisLikeProvider extends ServiceProvider {
      override register(app: Application): void {
        seen['password'] = app.env('REDIS_PASSWORD')
        seen['missing'] = app.env('NOT_SET_ANYWHERE')
        seen['name'] = app.config('app.name')
      }
    }
    const app = build({ env: { REDIS_PASSWORD: 's3cret' }, providers: [RedisLikeProvider] })
    await app.boot()
    expect(seen).toEqual({ password: 's3cret', missing: undefined, name: 'Blog Test' })
    expect(JSON.stringify(app.settings)).not.toContain('s3cret')
  })

  it('works for core provider objects too, and never answers inherited names', async () => {
    let value: string | undefined = 'unset'
    const app = build({
      providers: [
        {
          name: 'core-style',
          register: (core) => {
            value = (core as Application).env('toString')
          },
        },
      ],
    })
    await app.boot()
    expect(value).toBeUndefined()
  })

  it('throws a friendly boot error before boot', () => {
    const app = build()
    expect(() => app.env('APP_KEY')).toThrow(/before the app booted/)
  })
})

describe('app.addMessages() for package catalogs', () => {
  const DEMO_EN = defineMessages('en', {
    'demo.greeting': 'Hello {name}',
    'errors.demo_unavailable.title': 'The demo service is down',
    'validation.required': 'PACKAGE MUST NOT WIN',
  })
  const DEMO_PT = defineMessages('pt', { 'demo.greeting': 'Olá {name}' })

  class DemoProvider extends ServiceProvider {
    override register(app: Application): void {
      app.addMessages(DEMO_EN)
      app.make(ErrorRegistryToken).register({
        code: 'demo_unavailable',
        status: 503,
        title: 'Demo unavailable',
        owner: 'demo',
      })
    }
    override boot(app: Application): void {
      // Added after MessagesToken was resolved: still visible (the layer is read live).
      app.addMessages(DEMO_PT)
    }
  }

  it('formats package keys in every registered locale, falling back to English', async () => {
    const app = build({ providers: [DemoProvider] })
    await app.boot()
    const messages = app.make(MessagesToken)
    expect(messages.format('demo.greeting', { name: 'Ada' })).toBe('Hello Ada')
    expect(messages.format('demo.greeting', { name: 'Ada' }, { locale: 'pt-BR' })).toBe('Olá Ada')
    expect(messages.format('demo.greeting', { name: 'Ada' }, { locale: 'de' })).toBe('Hello Ada')
    expect(messages.locales()).toContain('pt')
    expect(messages.missingKeys('pt')).toContain('errors.demo_unavailable.title')
    expect(messages.missingKeys('pt')).not.toContain('demo.greeting')
  })

  it('never overrides a built-in message', async () => {
    const app = build({ providers: [DemoProvider] })
    await app.boot()
    expect(app.make(MessagesToken).resolve('validation.required')).not.toBe('PACKAGE MUST NOT WIN')
  })

  it("titles the package's problems over HTTP", async () => {
    const app = build({ providers: [DemoProvider] })
    const response = await app.handle(
      new Request('http://localhost/down', { headers: { accept: 'application/json' } }),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      code: 'demo_unavailable',
      title: 'The demo service is down',
    })
  })

  it('refuses something that is not a catalog', async () => {
    class Broken extends ServiceProvider {
      override register(app: Application): void {
        app.addMessages({ locale: 'en', messages: { a: 1 } } as never)
      }
    }
    expect((await bootError(build({ providers: [Broken] }))).code).toBe('invalid_message_catalog')
    class NoLocale extends ServiceProvider {
      override register(app: Application): void {
        app.addMessages({ locale: '', messages: {} } as never)
      }
    }
    expect((await bootError(build({ providers: [NoLocale] }))).code).toBe('invalid_message_catalog')
  })
})

describe('cache drivers from packages', () => {
  const cacheConfig = defineConfig(() => ({
    default: 'shared',
    stores: { shared: { driver: 'shared-memory', prefix: 'app:' } },
  }))

  it('a store in config/cache.ts uses a driver a provider registered, with its own settings', async () => {
    const built: { store: string; config: Readonly<Record<string, unknown>> }[] = []
    class SharedCacheProvider extends ServiceProvider {
      override register(app: Application): void {
        app.make(CacheDriverRegistryToken).extend('shared-memory', (config, context) => {
          built.push({ store: context.store, config })
          return new MemoryCacheStore({ clock: context.clock })
        })
      }
    }
    const app = build({ providers: [SharedCacheProvider], config: { cache: cacheConfig } })
    await app.boot()
    const manager = app.make(CacheManagerToken)
    const store: CacheStore = manager.store()
    await store.put('k', 1)
    expect(await store.get('k')).toBe(1)
    expect(manager.store('shared')).toBe(store)
    expect(built).toEqual([
      { store: 'shared', config: { driver: 'shared-memory', prefix: 'app:' } },
    ])
    expect(manager.storeNames).toEqual(['file', 'memory', 'shared'])
  })

  it('an unregistered driver still stops boot, naming the drivers that exist', async () => {
    const app = build({ config: { cache: cacheConfig } })
    await app.boot()
    let error: unknown
    try {
      app.make(CacheManagerToken)
    } catch (caught) {
      error = caught
    }
    expect(isBootError(error) && error.code).toBe('unknown_cache_driver')
    expect(isBootError(error) && error.hint).toContain('memory, file')
  })

  it('refuses bad names, built-in names, duplicates and late registrations', async () => {
    const app = build()
    await app.boot()
    const registry = app.make(CacheDriverRegistryToken)
    const factory = (): CacheStore => new MemoryCacheStore({ clock: createTestClock(NOW) })
    const code = (work: () => unknown): string | undefined => {
      try {
        work()
      } catch (error) {
        return isBootError(error) ? error.code : 'not a boot error'
      }
      return undefined
    }
    expect(code(() => registry.extend('Redis!', factory))).toBe('invalid_cache_driver_name')
    expect(code(() => registry.extend('file', factory))).toBe('duplicate_cache_driver')
    expect(code(() => registry.extend('ok', 'nope' as never))).toBe('invalid_cache_driver')
    expect(code(() => registry.extend('ok', factory))).toBeUndefined()
    expect(code(() => registry.extend('ok', factory))).toBe('duplicate_cache_driver')
    app.make(CacheManagerToken) // building the manager seals the registry
    expect(code(() => registry.extend('late', factory))).toBe('cache_driver_after_boot')
  })
})

describe('public exports add-ons import', () => {
  it('the root entry has the gate, the policy registry and the store tokens', () => {
    for (const name of [
      'allows',
      'authorize',
      'hasAdminRole',
      'PolicyDenial',
      'PolicyRegistry',
      'PolicyRegistryToken',
      'POLICIES_FOLDER',
      'RateLimitStoreToken',
      'UsedSignatureStoreToken',
      'MemoryUsedSignatureStore',
      'MemoryCacheStore',
      'CacheDriverRegistry',
      'CacheDriverRegistryToken',
      'servePublicFile',
      'publicMounts',
    ])
      expect(framework, name).toHaveProperty(name)
  })

  it('/testing has the Application test client', () => {
    expect(typeof testing.testClient).toBe('function')
    expect(testing.AppTestClient).toBeDefined()
    expect(testing.AppTestResponse).toBeDefined()
  })

  it('a bound RateLimitStoreToken / UsedSignatureStoreToken replaces the defaults', async () => {
    const limits = new MemoryCacheStore({ clock: createTestClock(NOW) })
    const used = new framework.MemoryUsedSignatureStore()
    class SharedStores extends ServiceProvider {
      override register(app: Application): void {
        app.container.value(framework.RateLimitStoreToken, limits)
        app.container.value(framework.UsedSignatureStoreToken, used)
      }
    }
    const app = build({ providers: [SharedStores] })
    await app.boot()
    expect(app.make(framework.RateLimitStoreToken)).toBe(limits)
    expect(app.make(framework.UsedSignatureStoreToken)).toBe(used)
  })

  it('the registry decides through policies and denies without one', async () => {
    class Post {
      readonly authorId: string
      constructor(authorId: string) {
        this.authorId = authorId
      }
    }
    class Draft {}
    const app = build()
    await app.boot()
    const registry = app.make(framework.PolicyRegistryToken)
    registry.register(Post, {
      view: (user, post: Post) => user?.id === post.authorId,
    })
    const ada = { id: '1', type: 'user' as const, roles: [], attrs: {} }
    expect(await registry.allows(Post, 'view', ada, new Post('1'))).toBe(true)
    expect(await registry.allows(Post, 'view', ada, new Post('2'))).toBe(false)
    expect(await registry.allows(Post, 'delete', ada, new Post('1'))).toBe(false)
    expect(await registry.allows(Draft, 'view', ada, new Draft())).toBe(false)
    await expect(registry.authorize(Post, 'view', ada, new Post('1'))).resolves.toBeUndefined()
    await expect(registry.authorize(Post, 'view', ada, new Post('2'))).rejects.toMatchObject({
      code: 'forbidden',
    })
    const denied = await registry.authorize(Draft, 'view', ada).catch((error: unknown) => error)
    expect(denied).toMatchObject({ code: 'forbidden', status: 403 })
    expect(String((denied as { cause?: unknown }).cause)).toContain('Draft has no policy')
    expect(framework.hasAdminRole({ ...ada, roles: ['admin'] })).toBe(true)
  })
})
