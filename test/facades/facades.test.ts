/**
 * Facades resolve from the **current application's container** on every call (CONSISTENCY #47):
 * each one reaches its service, two apps in one process never see each other, a test swaps one
 * by binding, outside an app or with nothing bound the error is friendly, and the 0.3 facades
 * throw `facade_not_available`.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CacheManager } from '../../src/cache/contract.ts'
import { CacheManagerToken } from '../../src/cache/contract.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { EventBusToken, LoggerToken } from '../../src/core/tokens.ts'
import type { Database } from '../../src/database/types.ts'
import {
  Bus,
  Cache,
  Crypt,
  DB,
  Event,
  Hash,
  Http,
  Log,
  Mail,
  Notification,
  Queue,
  Route,
  Storage,
  Url,
} from '../../src/facades/index.ts'
import type { Application } from '../../src/foundation/application.ts'
import { type BootError, isBootError } from '../../src/foundation/boot-error.ts'
import { runInApplication } from '../../src/foundation/current.ts'
import { MemoryCacheStore } from '../../src/http/app/memory-cache.ts'
import { createStorageManager } from '../../src/storage/manager.ts'
import { createMemoryDisk } from '../../src/storage/memory-disk.ts'
import { DatabaseToken, StorageManagerToken } from '../../src/tokens.ts'
import { MemoryLogger, NOW } from '../app/helpers.ts'
import { shopApp } from '../exceptions/helpers.ts'

function memoryCache(): CacheManager {
  const store = new MemoryCacheStore({ clock: createTestClock(NOW) })
  const other = new MemoryCacheStore({ clock: createTestClock(NOW) })
  return {
    defaultStore: 'memory',
    storeNames: ['memory', 'other'],
    store: (name = 'memory') => (name === 'other' ? other : store),
  }
}

function fakeDatabase(log: string[]): Database {
  const db: Database = {
    dialect: 'sqlite',
    query: async (sql, params) => {
      log.push(`query ${sql} ${JSON.stringify(params ?? [])}`)
      return [{ id: 1 }] as never
    },
    execute: async (sql) => {
      log.push(`execute ${sql}`)
      return 3
    },
    transaction: async (work) => work(db),
    close: async () => {},
  }
  return db
}

function caught(work: () => unknown): BootError {
  try {
    work()
  } catch (error) {
    if (isBootError(error)) return error
    throw error
  }
  throw new Error('expected a BootError')
}

async function app(): Promise<Application> {
  const shop = await shopApp({
    '/posts/{post}': (ctx) =>
      ctx.json({
        name: Route.currentRouteName(),
        uri: Route.current()?.uri,
        isShop: Route.is('shop.*'),
        isAdmin: Route.is('admin.*', 'other'),
        has: Route.has('shop.get_posts_post_'),
      }),
  })
  shop.app.container.value(CacheManagerToken, memoryCache())
  return shop.app
}

describe('each facade resolves from the current app', () => {
  it('Log, Cache, Crypt, Url, Route, Event and Http', async () => {
    const shop = await app()
    const logger = shop.make(LoggerToken) as MemoryLogger
    await shop.run(async () => {
      Log.info('hello', { a: 1 })
      Log.trace('t')
      Log.debug('d')
      Log.warn('w')
      Log.error('e')
      Log.fatal('f')
      expect(Log.child({ module: 'x' })).toBe(logger)
      expect(Log.isLevelEnabled('info')).toBe(true)
      await Log.flush()
      expect(Log.logger()).toBe(logger)

      expect(await Cache.remember('stats', 60, () => ({ posts: 3 }))).toEqual({ posts: 3 })
      expect(await Cache.remember('stats', 60, () => ({ posts: 99 }))).toEqual({ posts: 3 })
      expect(await Cache.rememberForever('forever', async () => 7)).toBe(7)
      await Cache.put('k', 'v', 10)
      expect(await Cache.get('k')).toBe('v')
      expect(await Cache.has('k')).toBe(true)
      expect(await Cache.add('k', 'other')).toBe(false)
      expect(await Cache.increment('n')).toBe(1)
      expect(await Cache.increment('n', 5, 60)).toBe(6)
      expect(await Cache.decrement('n', 2)).toBe(4)
      expect(await Cache.decrement('n')).toBe(3)
      expect(await Cache.pull('k')).toBe('v')
      expect(await Cache.has('k')).toBe(false)
      expect(await Cache.forget('n')).toBe(true)
      await Cache.store('other').put('x', 1)
      expect(await Cache.get('x')).toBeUndefined()
      await Cache.flush()
      expect(await Cache.get('stats')).toBeUndefined()

      const sealed = Crypt.encrypt({ note: 'hi' }, { purpose: 'notes' })
      expect(Crypt.decrypt(sealed, { purpose: 'notes' })).toEqual({ note: 'hi' })
      expect(Crypt.decryptString(Crypt.encryptString('plain'))).toBe('plain')

      expect(Url.has('shop.get_posts_post_')).toBe(true)
      expect(Url.route('shop.get_posts_post_', { post: 7 })).toBe('/posts/7')
      expect(Url.signedRoute('shop.get_posts_post_', { post: 7 })).toMatch(/^\/posts\/7\?/)
      expect(Url.temporarySignedRoute('shop.get_posts_post_', NOW + 60_000, { post: 7 })).toMatch(
        /expires=/,
      )
      expect(Route.has('shop.get_posts_post_')).toBe(true)
      expect(Route.has('nope')).toBe(false)
      expect(Route.current()).toBeUndefined()
      expect(Route.currentRouteName()).toBeUndefined()
      expect(Route.is('*')).toBe(false)

      const heard: unknown[] = []
      const off = Event.on('invoice.paid', (event) => void heard.push(event.payload))
      Event.once('invoice.paid', (event) => void heard.push(`once ${String(event.type)}`))
      expect(Event.listenerCount('invoice.paid')).toBe(2)
      await Event.emit('invoice.paid', { id: 1 })
      await Event.dispatch('invoice.paid', { id: 2 })
      off()
      expect(heard).toEqual([{ id: 1 }, 'once invoice.paid', { id: 2 }])
      expect(Event.bus()).toBe(shop.make(EventBusToken))
    })
    expect(logger.messages('info')).toContain('hello')
    expect(logger.messages('fatal')).toEqual(['f'])
  })

  it('Route knows the current request route', async () => {
    const shop = await app()
    const response = await shop.handle(new Request('http://localhost/posts/7'))
    expect(await response.json()).toEqual({
      name: 'shop.get_posts_post_',
      uri: '/posts/{post}',
      isShop: true,
      isAdmin: false,
      has: true,
    })
  })

  it('DB and Storage once their services are bound', async () => {
    const shop = await app()
    const log: string[] = []
    shop.container.value(DatabaseToken, fakeDatabase(log))
    shop.container.value(
      StorageManagerToken,
      createStorageManager({
        default: 'memory',
        disks: [
          createMemoryDisk({
            name: 'memory',
            url: '/storage',
            signingSecret: randomBytes(32).toString('base64url'),
          }),
        ],
      }),
    )
    await shop.run(async () => {
      expect(DB.dialect).toBe('sqlite')
      expect(await DB.query('select 1', [1])).toEqual([{ id: 1 }])
      expect(await DB.execute('delete from x')).toBe(3)
      expect(await DB.transaction(async (tx) => tx.execute('update x'))).toBe(3)
      expect(DB.connection().dialect).toBe('sqlite')

      await Storage.put('notes/a.txt', 'hello')
      expect(await Storage.exists('notes/a.txt')).toBe(true)
      expect(await new Response(await Storage.get('notes/a.txt')).text()).toBe('hello')
      expect(await Storage.temporaryUrl('notes/a.txt')).toContain('notes/a.txt')
      expect(Storage.names()).toEqual(['memory'])
      expect(Storage.disk().name).toBe('memory')
      await Storage.forTenant('11111111-1111-4111-8111-111111111111').put('x.txt', 'tenant')
      expect(
        await Storage.disk().exists('tenants/11111111-1111-4111-8111-111111111111/x.txt'),
      ).toBe(true)
      await Storage.delete('notes/a.txt')
      expect(await Storage.exists('notes/a.txt')).toBe(false)
    })
    expect(log).toEqual(['query select 1 [1]', 'execute delete from x', 'execute update x'])
  })
})

describe('isolation and swapping', () => {
  it('two apps in one process never see each other', async () => {
    const first = await app()
    const second = await app()
    await first.run(() => Cache.put('owner', 'first'))
    await second.run(() => Cache.put('owner', 'second'))
    expect(await first.run(() => Cache.get('owner'))).toBe('first')
    expect(await second.run(() => Cache.get('owner'))).toBe('second')
    first.run(() => Log.info('only in first'))
    expect((first.make(LoggerToken) as MemoryLogger).messages('info')).toContain('only in first')
    expect((second.make(LoggerToken) as MemoryLogger).messages('info')).not.toContain(
      'only in first',
    )
    const faked = first.run(() =>
      Http.fake({ '*': { status: 201, body: { ok: true } } }).preventStrayRequests(),
    )
    const response = await first.run(() => Http.post('https://api.example.com/items', { a: 1 }))
    expect(response.status).toBe(201)
    first.run(() => {
      Http.assertSent((request) => request.url.includes('api.example.com'))
      Http.assertSentCount(1)
      expect(Http.recorded()).toHaveLength(1)
      expect(Http.client()).toBe(faked)
    })
    // The second app's client was never faked.
    second.run(() => Http.assertNothingSent())
    expect(second.run(() => Http.client())).not.toBe(faked)
  })

  it('swaps a facade by binding a different value in the app container', async () => {
    const shop = await app()
    const swapped = new MemoryLogger()
    shop.container.value(LoggerToken, swapped)
    shop.run(() => Log.warn('to the swapped logger'))
    expect(swapped.messages('warn')).toEqual(['to the swapped logger'])
    const cache = memoryCache()
    shop.container.value(CacheManagerToken, cache)
    await shop.run(() => Cache.put('k', 1))
    expect(await cache.store().get('k')).toBe(1)
  })

  it('every Http verb and builder goes to the bound client', async () => {
    const shop = await app()
    await shop.run(async () => {
      Http.fake((request) => ({ status: 200, body: { method: request.method } }))
      const base = 'https://api.example.com/x'
      for (const call of [
        () => Http.get(base, { q: 1 }),
        () => Http.head(base),
        () => Http.put(base, {}),
        () => Http.patch(base, {}),
        () => Http.delete(base),
        () => Http.withHeaders({ 'x-a': '1' }).get(base),
        () => Http.withToken('t').get(base),
        () => Http.acceptJson().get(base),
        () => Http.asForm().post(base, { a: 1 }),
        () => Http.timeout(1000).get(base),
        () => Http.maxBytes(1024).get(base),
        () => Http.maxRedirects(1).get(base),
        () => Http.allow(['10.0.0.0/8']).get(base),
      ])
        expect((await call()).status).toBe(200)
      Http.assertSentCount(13)
      Http.assertNotSent((request) => request.url.includes('evil'))
    })
  })
})

describe('friendly errors', () => {
  it('outside an app, naming the facade call', () => {
    const error = caught(() => Log.info('x'))
    expect(error.code).toBe('no_current_application')
    expect(error.message).toContain('Log.info()')
    expect(caught(() => Cache.store()).message).toContain('Cache.store()')
    expect(caught(() => DB.dialect).message).toContain('DB.dialect()')
  })

  it('when nothing is bound, naming the facade and what to install', () => {
    const container = { has: () => false, make: () => undefined }
    const scope = { container: container as never, basePath: '/srv/app' }
    const db = caught(() => runInApplication(scope, () => DB.connection()))
    expect(db.code).toBe('facade_not_bound')
    expect(db.message).toContain('DB.connection() needs a database connection')
    expect(db.message).toContain('"strutvane.database"')
    expect(db.hint).toContain('config/database.ts')
    const calls: readonly (() => unknown)[] = [
      () => Storage.disk(),
      () => Cache.get('x'),
      () => Url.route('x'),
      () => Route.has('x'),
      () => Crypt.encrypt('x'),
      () => Http.client(),
      () => Event.bus(),
      () => Log.logger(),
    ]
    for (const call of calls)
      expect(caught(() => runInApplication(scope, call)).code).toBe('facade_not_bound')
  })

  it('the 0.3 facades throw facade_not_available from every member', () => {
    const facades = { Mail, Queue, Bus, Notification, Hash }
    for (const [name, facade] of Object.entries(facades)) {
      expect(Object.isFrozen(facade)).toBe(true)
      for (const [member, call] of Object.entries(facade)) {
        const error = caught(() => call())
        expect(error.code).toBe('facade_not_available')
        expect(error.message).toBe(
          `${name}.${member}() is not available yet: the ${name} facade arrives in Strutvane 0.3.`,
        )
      }
    }
    expect(caught(() => Hash.make('secret')).hint).toContain('@strutvane/auth')
    expect(caught(() => Mail.send()).hint).toContain('0.3')
  })

  it('every facade is frozen', () => {
    for (const facade of [Log, Cache, DB, Route, Storage, Http, Event, Crypt, Url])
      expect(Object.isFrozen(facade)).toBe(true)
  })
})
