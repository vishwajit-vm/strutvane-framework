/**
 * The foundation: env and config, the provider lifecycle on the core application (classes and
 * core provider objects), boot failures, helpers and the current app, `loadApplication`, the
 * bootstrap caches (config, routes, events) and listener and policy discovery.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PolicyRegistry, policyFile } from '../../src/auth/policies.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { token } from '../../src/core/container.ts'
import { ClockToken, EventBusToken, LoggerToken } from '../../src/core/tokens.ts'
import { Application } from '../../src/foundation/application.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import {
  cachePath,
  clearCache,
  readCache,
  writeCache,
} from '../../src/foundation/bootstrap-cache.ts'
import {
  decodeConfigTree,
  encodeConfigTree,
  routeManifest,
} from '../../src/foundation/cached-boot.ts'
import {
  ConfigError,
  ConfigRepository,
  defineConfig,
  loadConfig,
} from '../../src/foundation/config.ts'
import { loadEnvSource } from '../../src/foundation/env.ts'
import { config, app as currentApp, now } from '../../src/foundation/helpers.ts'
import { isListenerList } from '../../src/foundation/listeners.ts'
import { loadApplication } from '../../src/foundation/load.ts'
import { NavigationRegistry } from '../../src/foundation/navigation.ts'
import { ServiceProvider } from '../../src/foundation/provider.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { Keyring } from '../../src/security/keyring.ts'
import { testClient } from '../../src/testing/app-client.ts'
import { blogConfig } from '../app/fixtures/blog/bootstrap/app.ts'
import { APP_KEY, BLOG_BASE, MemoryLogger, NOW, testEnv } from '../app/helpers.ts'
import { linkDirectory, linkFile, linkFolder, removeLinks } from '../helpers/linked-root.ts'

const temporary: string[] = []
afterEach(() => {
  removeLinks() // the links first, so removing a project never follows one
  for (const folder of temporary.splice(0))
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'strut-app-'))
  temporary.push(folder)
  return folder
}

function quietApp(
  basePath: string,
  env: Record<string, string> = {},
): { app: Application; logger: MemoryLogger } {
  const app = Application.configure({ basePath, env: { ...testEnv, ...env } })
    .withConfig(blogConfig)
    .withRouting({
      web: defineRoutes([Route.get('/hello', (ctx) => ctx.json({ hello: true })).name('hello')]),
    })
    .create()
  const logger = new MemoryLogger()
  app.container.value(LoggerToken, logger)
  app.container.value(ClockToken, createTestClock(NOW))
  return { app, logger }
}

async function bootFailure(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; hint: string }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (isBootError(error)) return error
  throw new Error(`Expected a boot error, got ${String(error)}`)
}

describe('env and config', () => {
  it('reads typed values and collects every problem at once', () => {
    const files = {
      app: defineConfig((env) => ({
        debug: env.boolean('APP_DEBUG'),
        port: env.integer('PORT'),
        mode: env.oneOf('MODE', ['a', 'b']),
        url: env.url('URL'),
        name: env.string('NAME'),
      })),
    }
    let error: unknown
    try {
      loadConfig(files, { APP_DEBUG: 'yes', PORT: '80x', URL: 'ftp://not-http', MODE: 'c' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).problems.map((problem) => problem.key)).toEqual([
      'APP_DEBUG',
      'PORT',
      'MODE',
      'URL',
      'NAME',
    ])
    expect((error as ConfigError).message).toContain(
      'APP_DEBUG must be true or false (got "yes") (read in config/app.ts)',
    )
    expect((error as ConfigError).code).toBe('invalid_environment')
  })

  it('accepts Laravel-style values, empties as unset, and fallbacks; never echoes a long value', () => {
    const files = {
      app: defineConfig((env) => ({
        a: env.boolean('A'),
        b: env.boolean('B', true),
        c: env.string('C', 'fallback'),
        d: env.optional('D'),
        n: env.integer('N', 3),
        m: env.oneOf('M', ['x', 'y'], 'y'),
        u: env.url('U', 'http://localhost'),
      })),
    }
    expect(loadConfig(files, { A: '1', C: '' }).get('app')).toEqual({
      a: true,
      b: true,
      c: 'fallback',
      d: undefined,
      n: 3,
      m: 'y',
      u: 'http://localhost',
    })
    expect(() =>
      loadConfig({ app: defineConfig((env) => env.integer('LONG')) }, { LONG: 'x'.repeat(100) }),
    ).toThrow(/got "x{20}…"/)
    expect(() => loadConfig({ app: defineConfig((env) => env.oneOf('M', ['x'])) }, {})).toThrow(
      /M is required \(one of x\)/,
    )
  })

  it('refuses unknown keys, freezes the tree, and offers typed fallbacks for optional framework keys', () => {
    const repository = loadConfig(blogConfig, testEnv)
    expect(repository.get('app.name')).toBe('Blog Test')
    expect(() => repository.get('app.nmae')).toThrow(/no config value at "app.nmae"/)
    expect(Object.isFrozen(repository.get('app'))).toBe(true)
    expect(repository.has('app.editor')).toBe(true)
    expect(repository.has('session.cookie')).toBe(false)
    expect(repository.string('session.cookie', 'fallback')).toBe('fallback')
    expect(repository.boolean('app.debug', false)).toBe(true)
    expect(repository.boolean('app.name', false)).toBe(false)
  })

  it('reads .env from the base path, with the real environment winning', () => {
    const folder = scratch()
    writeFileSync(join(folder, '.env'), 'APP_NAME="From file"\nAPP_KEY=file-key\n')
    expect(loadEnvSource(folder, { APP_KEY: 'override' })).toEqual({
      APP_NAME: 'From file',
      APP_KEY: 'override',
    })
    expect(loadEnvSource(scratch(), { A: '1' })).toEqual({ A: '1' })
  })
})

describe('the application lifecycle', () => {
  it('registers every provider (classes and core objects) before booting any, and shuts down in reverse', async () => {
    const order: string[] = []
    const Flag = token<string>('Flag')
    class First extends ServiceProvider {
      override register(app: Application): void {
        order.push('first.register')
        app.container.value(Flag, 'bound by first')
      }
      override boot(): void {
        order.push('first.boot')
      }
      override shutdown(): void {
        order.push('first.shutdown')
      }
    }
    const second = {
      name: 'second',
      register: () => void order.push('second.register'),
      boot: (app: { make: Application['make'] }) =>
        void order.push(`second.boot sees ${app.make(Flag)}`),
      shutdown: () => void order.push('second.shutdown'),
    }
    const app = Application.configure({ basePath: scratch(), env: testEnv })
      .withConfig(blogConfig)
      .withProviders([First, second])
      .create()
    app.container.value(LoggerToken, new MemoryLogger())
    await app.boot()
    await app.boot() // idempotent
    expect(order).toEqual([
      'first.register',
      'second.register',
      'first.boot',
      'second.boot sees bound by first',
    ])
    expect(app.state).toBe('booted')
    const report = await app.shutdown()
    expect(report.errors).toEqual([])
    expect(order.slice(-2)).toEqual(['second.shutdown', 'first.shutdown'])
  })

  it('lets a package provider add routes, commands and navigation; late routes are refused', async () => {
    class BillingProvider extends ServiceProvider {
      override register(app: Application): void {
        app.addRoutes(
          defineRoutes([
            Route.get('/plans', (ctx) => ctx.json({ plans: ['basic'] })).name('billing.plans'),
          ]),
          { prefix: '/api/billing', group: 'api' },
        )
        app.addRoutes(
          (router) =>
            void router.get('/ping', (ctx) => ctx.json({ pong: true })).name('billing.ping'),
          { prefix: '/billing' },
        )
        app.addCommand({ name: 'billing:sync', description: 'Sync plans', run: () => 0 } as never)
      }
      override boot(app: Application): void {
        app.navigation.add({
          name: 'billing',
          label: 'Billing',
          path: app.url.route('billing.plans'),
          icon: 'card',
          group: 'Account',
          order: 50,
          permission: null,
        })
      }
    }
    const app = Application.configure({ basePath: scratch(), env: testEnv })
      .withConfig(blogConfig)
      .withProviders([BillingProvider])
      .withCommands([{ name: 'inspire', description: 'Quote', run: () => 0 } as never])
      .create()
    app.container.value(LoggerToken, new MemoryLogger())
    const response = await app.handle(new Request('http://localhost/api/billing/plans'))
    expect(await response.json()).toEqual({ plans: ['basic'] })
    expect(await (await app.handle(new Request('http://localhost/billing/ping'))).json()).toEqual({
      pong: true,
    })
    expect(app.commands.map((command) => command.name)).toEqual(['inspire', 'billing:sync'])
    expect(app.navigation.items).toEqual([
      expect.objectContaining({ name: 'billing', path: '/api/billing/plans' }),
    ])
    expect(() => app.addRoutes(defineRoutes([]))).toThrow(
      expect.objectContaining({ code: 'routes_after_boot' }),
    )
  })

  it('refuses an asynchronous register() and reports a provider failure', async () => {
    // A JavaScript provider (or a cast) can still return a Promise from register().
    const asyncRegister = (): Promise<void> => Promise.resolve()
    class AsyncRegister extends ServiceProvider {}
    Object.defineProperty(AsyncRegister.prototype, 'register', { value: asyncRegister })
    const app = Application.configure({ basePath: scratch(), env: testEnv })
      .withConfig(blogConfig)
      .withProviders([AsyncRegister])
      .create()
    app.container.value(LoggerToken, new MemoryLogger())
    expect((await bootFailure(app.boot())).code).toBe('async_register')
    expect(() =>
      Application.configure({ basePath: '.' })
        .withProviders([42 as never])
        .create(),
    ).toThrow(/not a service provider/)
  })

  it('fails boot with every bad environment variable listed', async () => {
    const app = Application.configure({ basePath: scratch(), env: { APP_DEBUG: 'maybe' } })
      .withConfig(blogConfig)
      .create()
    await expect(app.boot()).rejects.toThrow(
      /APP_DEBUG must be true or false[\s\S]*APP_KEY is required/,
    )
  })

  it('refuses debug in production unless forced, and weak keys (boot guards)', async () => {
    expect(
      (
        await bootFailure(
          quietApp(scratch(), { APP_ENV: 'production', APP_DEBUG: 'true' }).app.boot(),
        )
      ).code,
    ).toBe('debug_in_production')
    expect((await bootFailure(quietApp(scratch(), { APP_KEY: 'short' }).app.boot())).code).toBe(
      'invalid_app_key',
    )
    const forced = quietApp(scratch(), { APP_ENV: 'production', APP_DEBUG: 'true' })
    forced.app.forceDebug()
    await forced.app.boot()
    expect(forced.app.showsDebugDetails).toBe(false)
    expect(forced.logger.messages('warn').join('\n')).toContain('--force-debug')
    expect(() => forced.app.forceDebug()).toThrow(
      expect.objectContaining({ code: 'force_debug_after_boot' }),
    )
  })

  it('refuses to be used before boot, with the fix in the message', () => {
    const app = Application.configure({ basePath: scratch() }).create()
    expect(() => app.routes).toThrow(
      expect.objectContaining({
        code: 'not_booted',
        hint: 'Call `await app.boot()` first (requests and commands do it for you).',
      }),
    )
    expect(() => app.config('app.name')).toThrow(expect.objectContaining({ code: 'not_booted' }))
    expect(() => app.environment).toThrow(expect.objectContaining({ code: 'not_booted' }))
  })

  it('exposes the booted app: config, environment, routes, security and the core config()', async () => {
    const { app } = quietApp(scratch())
    await app.boot()
    expect(app.config('app.name')).toBe('Blog Test')
    expect(app.settings).toMatchObject({ app: { name: 'Blog Test' } })
    expect(app.environment).toBe('testing')
    expect(app.showsDebugDetails).toBe(true)
    expect(app.routes.map((route) => route.uri)).toEqual([
      '/hello',
      '/_strutvane/csp-report',
      '/up',
    ])
    expect(app.fallbacks).toEqual([])
    expect(app.security.hosts.patterns).toContain('localhost')
    expect(app.loadFreshConfig().get('app.name')).toBe('Blog Test')
    expect(() => app.routeMiddleware({ ...app.routes[0], uri: '/x' } as never)).toThrow(
      expect.objectContaining({ code: 'unknown_route' }),
    )
  })
})

describe('helpers and the current app', () => {
  it('config(), now() and app() read the current app; outside one they explain how to get it', async () => {
    const { app } = quietApp(scratch())
    await app.boot()
    expect(app.run(() => config('app.name'))).toBe('Blog Test')
    expect(app.run(() => now().getTime())).toBe(NOW)
    expect(app.run(() => currentApp().basePath)).toBe(app.basePath)
    expect(() => config('app.name')).toThrow(/outside a request or console command/)
  })

  it('keeps two apps in one process apart', async () => {
    const first = quietApp(scratch(), { APP_NAME: 'First' })
    const second = quietApp(scratch(), { APP_NAME: 'Second' })
    await Promise.all([first.app.boot(), second.app.boot()])
    expect([
      first.app.run(() => config('app.name')),
      second.app.run(() => config('app.name')),
    ]).toEqual(['First', 'Second'])
  })
})

describe('loadApplication', () => {
  it('imports bootstrap/app.ts and returns its default export', async () => {
    const app = await loadApplication(BLOG_BASE)
    expect(app).toBeInstanceOf(Application)
  })

  it('explains a missing or wrong bootstrap file', async () => {
    const empty = scratch()
    await expect(loadApplication(empty)).rejects.toMatchObject({ code: 'missing_bootstrap' })
    mkdirSync(join(empty, 'bootstrap'))
    writeFileSync(join(empty, 'bootstrap', 'app.mjs'), 'export default 42\n')
    await expect(loadApplication(empty)).rejects.toMatchObject({ code: 'invalid_bootstrap' })
  })
})

describe('the bootstrap caches', () => {
  it('uses an encrypted config cache, and ignores a tampered, stale or foreign one with a warning', async () => {
    const base = scratch()
    const keyring = Keyring.from(APP_KEY)
    const source = quietApp(base)
    writeCache(
      base,
      'config',
      keyring,
      encodeConfigTree(source.app.loadFreshConfig().all),
      new Date(NOW),
    )
    const text = (await import('node:fs')).readFileSync(cachePath(base, 'config'), 'utf8')
    expect(text).not.toContain('Blog Test')
    expect(text).not.toContain(APP_KEY)
    const cached = quietApp(base, { APP_NAME: 'Changed in env' })
    await cached.app.boot()
    expect(cached.app.cacheStatus.config).toBe('used')
    // As in Laravel: with a config cache, .env changes need config:cache again.
    expect(cached.app.config('app.name')).toBe('Blog Test')
    expect(cached.app.config('app.editor')).toBeUndefined()

    writeFileSync(
      cachePath(base, 'config'),
      text.replace(
        /"payload": "(.)/,
        (_whole, first: string) => `"payload": "${first === 'A' ? 'B' : 'A'}`,
      ),
    )
    const tampered = quietApp(base)
    await tampered.app.boot()
    expect(tampered.app.cacheStatus.config).toBe('ignored')
    expect(tampered.logger.messages('warn').join('\n')).toContain('changed after it was written')

    writeCache(
      base,
      'config',
      keyring,
      encodeConfigTree(source.app.loadFreshConfig().all),
      new Date(NOW),
    )
    const otherKey = quietApp(base, { APP_KEY: `base64:${Buffer.alloc(32, 7).toString('base64')}` })
    await otherKey.app.boot()
    expect(otherKey.app.cacheStatus.config).toBe('ignored')
    expect(otherKey.logger.messages('warn').join('\n')).toContain('different APP_KEY')

    mkdirSync(join(base, 'app'), { recursive: true })
    writeFileSync(join(base, 'app', 'changed.ts'), 'export const x = 1\n')
    const stale = quietApp(base)
    await stale.app.boot()
    expect(stale.app.cacheStatus.config).toBe('ignored')
    expect(stale.logger.messages('warn').join('\n')).toContain('another version of the code')

    writeFileSync(cachePath(base, 'config'), 'not json')
    expect(readCache(base, 'config', keyring, new MemoryLogger()).use).toBe('ignored')
    expect(clearCache(base, 'config')).toBe(true)
    expect(clearCache(base, 'config')).toBe(false)
  })

  it('skips the route checks when the route cache matches the compiled table, and ignores it when routes change', async () => {
    const base = scratch()
    const keyring = Keyring.from(APP_KEY)
    const first = quietApp(base)
    await first.app.boot()
    writeCache(
      base,
      'routes',
      keyring,
      routeManifest(first.app.routes, (route) => first.app.routeMiddleware(route)),
      new Date(NOW),
    )
    const second = quietApp(base)
    await second.app.boot()
    expect(second.app.cacheStatus.routes).toBe('used')
    const changed = Application.configure({ basePath: base, env: testEnv })
      .withConfig(blogConfig)
      .withRouting({ web: defineRoutes([Route.get('/other', (ctx) => ctx.json({}))]) })
      .create()
    const logger = new MemoryLogger()
    changed.container.value(LoggerToken, logger)
    await changed.boot()
    expect(changed.cacheStatus.routes).toBe('ignored')
    expect(logger.messages('warn').join('\n')).toContain('the routes changed')
  })

  it('round-trips undefined config values through JSON', () => {
    expect(
      decodeConfigTree(
        JSON.parse(JSON.stringify(encodeConfigTree({ a: { b: undefined, c: [1, undefined] } }))),
      ),
    ).toEqual({ a: { b: undefined, c: [1, undefined] } })
    expect(new ConfigRepository({ a: { b: undefined } }).has('a.b')).toBe(true)
  })
})

describe('listener discovery', () => {
  it('discovers app/listeners, delivers through the core event bus, and uses the events cache', async () => {
    const base = scratch()
    mkdirSync(join(base, 'app', 'listeners'), { recursive: true })
    writeFileSync(
      join(base, 'app', 'listeners', 'welcome.listener.mjs'),
      'export class SendWelcome { static event = "user.registered"; handle(payload) { globalThis.__welcomed = payload.id } }\nexport const notAListener = 1\n',
    )
    const { app } = quietApp(base)
    await app.boot()
    expect(app.cacheStatus.events).toBe('none')
    expect(app.events.list()).toEqual([
      { event: 'user.registered', listeners: ['SendWelcome (app/listeners/welcome.listener.mjs)'] },
    ])
    await app.make(EventBusToken).emit('user.registered', { id: 42 }, {})
    expect((globalThis as { __welcomed?: unknown }).__welcomed).toBe(42)

    writeCache(base, 'events', Keyring.from(APP_KEY), app.events.discovered, new Date(NOW))
    const cached = quietApp(base)
    await cached.app.boot()
    expect(cached.app.cacheStatus.events).toBe('used')
  })

  it('accepts explicit listeners and refuses cached entries pointing outside app/listeners', async () => {
    const { app } = quietApp(scratch())
    let heard: unknown
    class Explicit {
      static readonly event = 'order.paid'
      handle(payload: unknown): void {
        heard = payload
      }
    }
    app.events.listen(Explicit)
    await app.boot()
    await app.make(EventBusToken).emit('order.paid', { total: 5 }, {})
    expect(heard).toEqual({ total: 5 })
    expect(() => app.events.listen({ name: 'Nope' } as never)).toThrow(/not a listener class/)
    expect(
      isListenerList([{ event: 'x', file: 'app/listeners/a.listener.ts', exportName: 'A' }]),
    ).toBe(true)
    expect(
      isListenerList([{ event: 'x', file: 'app/listeners/../../secrets.ts', exportName: 'A' }]),
    ).toBe(false)
    expect(isListenerList([{ event: 'x', file: '/etc/passwd', exportName: 'A' }])).toBe(false)
  })
})

describe('policy discovery (CONSISTENCY #73)', () => {
  it('finds app/policies/<model>.policy.* by name; an explicit policy wins', async () => {
    const base = scratch()
    mkdirSync(join(base, 'app', 'policies'), { recursive: true })
    writeFileSync(
      join(base, 'app', 'policies', 'blog-post.policy.mjs'),
      'export default class BlogPostPolicy { viewAny() { return true } }\n',
    )
    writeFileSync(
      join(base, 'app', 'policies', 'comment.policy.mjs'),
      'export class CommentPolicy { view() { return true } }\n',
    )
    writeFileSync(join(base, 'app', 'policies', 'empty.policy.mjs'), 'export const nothing = 1\n')
    const { app } = quietApp(base)
    await app.boot()
    const registry = new PolicyRegistry(base, app.container)
    expect(await (await registry.discover({ name: 'BlogPost' }))?.viewAny?.(null)).toBe(true)
    expect(await registry.discover({ name: 'Comment' })).toBeDefined()
    expect(await registry.discover({ name: 'Missing' })).toBeUndefined()
    expect(registry.for({ name: 'Missing' })).toBeUndefined()
    await expect(registry.discover({ name: 'Empty' })).rejects.toMatchObject({
      code: 'invalid_policy_file',
    })
    const explicit = { viewAny: () => false }
    registry.register({ name: 'BlogPost' }, explicit)
    expect(registry.for({ name: 'BlogPost' })).toBe(explicit)
  })

  it('can never load a file outside app/policies (path traversal)', () => {
    const base = scratch()
    mkdirSync(join(base, 'app', 'policies'), { recursive: true })
    writeFileSync(join(base, 'secrets.policy.mjs'), 'export default class {}\n')
    writeFileSync(join(base, 'app', 'policies', 'ok.policy.mjs'), 'export default class {}\n')
    for (const name of [
      '../../secrets',
      '..%2fsecrets',
      'Secrets/../../x',
      '../Ok',
      'ok',
      'O k',
      'C:\\Windows',
      '',
      'A'.repeat(200),
    ])
      expect(policyFile(base, name), name).toBeUndefined()
    // The real path (what was checked is what gets imported): on macOS `/var/…` is `/private/var/…`.
    expect(policyFile(base, 'Ok')).toBe(
      realpathSync(join(base, 'app', 'policies', 'ok.policy.mjs')),
    )
    expect(policyFile(scratch(), 'Ok')).toBeUndefined()
    try {
      symlinkSync(
        join(base, 'secrets.policy.mjs'),
        join(base, 'app', 'policies', 'leak.policy.mjs'),
      )
    } catch {
      return // Symlinks need privileges on Windows; the containment check is covered above.
    }
    expect(policyFile(base, 'Leak')).toBeUndefined()
  })

  // macOS reaches every temp app through a link (`/var` → `/private/var`); a link (a junction on
  // Windows) recreates that on every OS.
  it('works the same through a linked app root; links that point outside are still refused', async ({
    skip,
  }) => {
    const real = scratch()
    const policies = join(real, 'app', 'policies')
    mkdirSync(policies, { recursive: true })
    writeFileSync(
      join(policies, 'blog-post.policy.mjs'),
      'export default class BlogPostPolicy { viewAny() { return true } }\n',
    )
    writeFileSync(join(policies, 'empty.policy.mjs'), 'export const nothing = 1\n')
    const linked = linkFolder(real)
    if ('skipped' in linked) return skip(linked.skipped)
    const base = linked.path
    expect(policyFile(base, 'BlogPost')).toBe(realpathSync(join(policies, 'blog-post.policy.mjs')))
    const { app } = quietApp(base)
    await app.boot()
    const registry = new PolicyRegistry(base, app.container)
    expect(await (await registry.discover({ name: 'BlogPost' }))?.viewAny?.(null)).toBe(true)
    // The boot error names the file inside the app, never as `../../private/var/…`.
    await expect(registry.discover({ name: 'Empty' })).rejects.toMatchObject({
      code: 'invalid_policy_file',
      message: expect.stringMatching(/^app[\\/]policies[\\/]empty\.policy\.mjs exports no policy/),
    })
    const outside = scratch()
    writeFileSync(join(outside, 'secrets.policy.mjs'), 'export default class {}\n')
    // A directory link (a junction on Windows, no privilege needed) named like a policy.
    const noDirectoryLink = linkDirectory(outside, join(policies, 'dir.policy.mjs'))
    if (noDirectoryLink !== undefined) return skip(noDirectoryLink)
    expect(policyFile(base, 'Dir')).toBeUndefined()
    // A file symlink pointing outside (Windows needs Developer Mode or elevation for these).
    const noFileLink = linkFile(
      join(outside, 'secrets.policy.mjs'),
      join(policies, 'leak.policy.mjs'),
    )
    if (noFileLink !== undefined) return skip(noFileLink)
    expect(policyFile(base, 'Leak')).toBeUndefined()
  })
})

describe('navigation', () => {
  it('orders by group, order and label, and refuses duplicates and bad orders', () => {
    const registry = new NavigationRegistry()
    registry.add({
      name: 'b',
      label: 'B',
      path: '/b',
      icon: 'x',
      group: 'Z',
      order: 1,
      permission: null,
    })
    registry.add({
      name: 'a',
      label: 'A',
      path: '/a',
      icon: 'x',
      group: 'A',
      order: 2,
      permission: 'a.view',
      badge: 3,
    })
    registry.add({
      name: 'c',
      label: 'C',
      path: '/c',
      icon: 'x',
      group: 'A',
      order: 1,
      permission: null,
    })
    expect(registry.items.map((item) => item.name)).toEqual(['c', 'a', 'b'])
    expect(() =>
      registry.add({
        name: 'a',
        label: 'A',
        path: '/a',
        icon: 'x',
        group: 'A',
        order: 1,
        permission: null,
      }),
    ).toThrow(/Two navigation entries/)
    expect(() =>
      registry.add({
        name: 'd',
        label: 'D',
        path: '/d',
        icon: 'x',
        group: 'A',
        order: Number.NaN,
        permission: null,
      }),
    ).toThrow(/numeric order/)
  })

  it('the test client works against a plain app', async () => {
    const { app } = quietApp(scratch())
    ;(await testClient(app).getJson('/hello')).assertStatus(200).assertJsonPath('hello', true)
  })
})
