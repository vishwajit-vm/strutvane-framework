/**
 * The application cache and the session store: `cache:clear`, `cache:forget` and `session:flush`,
 * the file cache store (expiry by the app clock, atomic add/increment across processes, corrupt
 * files are a miss), its lock (stale takeover, timeout as a 503) and the store config checks.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CacheManagerToken } from '../../src/cache/contract.ts'
import { withFileLock } from '../../src/cache/file-lock.ts'
import { FILE_CACHE_FOLDER, FileCacheStore } from '../../src/cache/file-store.ts'
import { createCacheManager } from '../../src/cache/store.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { SessionStoreToken } from '../../src/session/contract.ts'
import { FileSessionStore, SESSION_FOLDER } from '../../src/session/file-store.ts'
import { appFolder, buildApp, cleanupFolders, NOW, ROOT, strut, testConfig } from './helpers.ts'

afterEach(cleanupFolders)

const run = promisify(execFile)

/** config/cache.ts with the file store as the default. */
const fileCache = {
  ...testConfig,
  cache: defineConfig(() => ({ default: 'file', stores: { file: { driver: 'file' } } })),
}

describe('cache:clear and cache:forget', () => {
  it('flushes the default file store and forgets one key', async () => {
    const base = appFolder()
    const make = () => buildApp(base, { config: fileCache }).app
    const seed = make()
    await seed.boot()
    const store = seed.make(CacheManagerToken).store()
    await store.put('stats', { views: 3 })
    await store.put('other', 1)
    const forgot = await strut(['cache:forget', 'stats', '--json'], { cwd: base, app: make })
    expect(forgot.json().data).toEqual({ store: 'file', key: 'stats', removed: true })
    const missing = await strut(['cache:forget', 'stats'], { cwd: base, app: make })
    expect(missing.stdout).toContain('"stats" was not in the "file" store.')
    expect(await store.get('other')).toBe(1)
    const cleared = await strut(['cache:clear', '--json'], { cwd: base, app: make })
    expect(cleared.json().data).toEqual({ store: 'file', cleared: true })
    expect(await store.get('other')).toBeUndefined()
  })

  it('says a memory store lives in each process instead of pretending to clear it', async () => {
    const base = appFolder()
    const result = await strut(['cache:clear', '--store=memory'], { cwd: base })
    expect(result.code).toBe(0)
    expect(result.stdout + result.stderr).toContain('lives inside each running process')
  })

  it('an unknown store is a configuration error with a suggestion', async () => {
    const base = appFolder()
    const result = await strut(['cache:forget', 'k', '--store=fiel', '--json'], { cwd: base })
    expect(result.code).toBe(3)
    expect(result.json().error?.code).toBe('unknown_cache_store')
    expect(result.json().data).toMatchObject({ hint: 'Did you mean "file"?' })
  })

  it('cache:clear resets rate limits too, so production needs --force --i-understand', async () => {
    const base = appFolder()
    const refused = await strut(['cache:clear', '--json'], {
      cwd: base,
      env: { APP_ENV: 'production' },
    })
    expect(refused.json().error?.code).toBe('production_guard')
    const confirmed = await strut(['cache:clear', '--force', '--i-understand'], {
      cwd: base,
      env: { APP_ENV: 'production' },
    })
    expect(confirmed.code).toBe(0)
  })
})

describe('the file cache store', () => {
  const store = (directory: string, now = NOW) => {
    const clock = createTestClock(now)
    return { clock, cache: new FileCacheStore({ directory, clock }) }
  }

  it('stores, expires by the app clock, adds only when absent and keeps fixed windows', async () => {
    const dir = join(appFolder(), FILE_CACHE_FOLDER)
    const { clock, cache } = store(dir)
    expect(cache.directory).toBe(dir)
    await cache.put('forever', ['a', 1])
    await cache.put('soon', 'x', 10)
    expect(await cache.get('forever')).toEqual(['a', 1])
    expect(await cache.ttl('forever')).toBeUndefined()
    expect(await cache.ttl('soon')).toBe(10)
    expect(await cache.add('soon', 'y', 10)).toBe(false)
    expect(await cache.increment('hits', 1, 60)).toBe(1)
    clock.advance(30_000)
    expect(await cache.increment('hits', 2, 60)).toBe(3)
    expect(await cache.ttl('hits')).toBe(30)
    clock.advance(11_000)
    expect(await cache.has('soon')).toBe(false)
    expect(await cache.ttl('missing')).toBeUndefined()
    expect(await cache.add('soon', 'y', 10)).toBe(true)
    clock.advance(20_000)
    // The window ended: the counter starts again with a fresh expiry.
    expect(await cache.increment('hits', 1, 60)).toBe(1)
    await cache.put('text', 'not a number')
    expect(await cache.increment('text', 5)).toBe(5)
  })

  it('treats corrupt, hand-edited and foreign files as a miss, and any key is a safe name', async () => {
    const dir = join(appFolder(), FILE_CACHE_FOLDER)
    const { cache } = store(dir)
    await cache.put('../../.env', 'value')
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/)
    const file = join(dir, files[0] ?? '')
    for (const body of [
      '{ broken',
      '[]',
      '{"key":"another key","value":1,"expiresAt":null}',
      '{"key":"../../.env","expiresAt":null}',
      '{"key":"../../.env","value":1,"expiresAt":"never"}',
    ]) {
      writeFileSync(file, body)
      expect(await cache.get('../../.env')).toBeUndefined()
    }
    writeFileSync(join(dir, 'keep.txt'), 'not ours')
    await cache.put('a', 1)
    await cache.flush()
    expect(readdirSync(dir)).toEqual(['keep.txt'])
    expect(await cache.forget('a')).toBe(false)
    await new FileCacheStore({
      directory: join(dir, 'never-made'),
      clock: createTestClock(),
    }).flush()
  })

  it('counts correctly when several processes increment the same key at once', async () => {
    const dir = join(appFolder(), FILE_CACHE_FOLDER)
    // This checks that no increment is lost, not the lock's timings (tested below). The lock has
    // no fairness: a waiter can lose every race while the other three run all their increments.
    // On a loaded Windows machine, where every lock-file create and delete is slow, that once took
    // longer than the 5 s default and the child exited with cache_unavailable. So the limits here
    // are generous (a stale takeover would lose an update, which is exactly what this checks).
    const script = `import { pathToFileURL } from 'node:url'
const { FileCacheStore } = await import(pathToFileURL(${JSON.stringify(join(ROOT, 'src', 'cache', 'file-store.ts'))}).href)
const cache = new FileCacheStore({ directory: ${JSON.stringify(dir)}, clock: { now: () => Date.now() }, lock: { timeoutMs: 120_000, staleMs: 120_000 } })
for (let i = 0; i < 25; i++) await cache.increment('throttle:login', 1, 600)`
    await Promise.all(
      Array.from({ length: 4 }, () => run(process.execPath, ['--input-type=module', '-e', script])),
    )
    expect(await store(dir, Date.now()).cache.get('throttle:login')).toBe(100)
  })
})

describe('the file lock', () => {
  it('takes over a lock left by a crashed process', async () => {
    const dir = appFolder()
    const lock = join(dir, 'k.lock')
    writeFileSync(lock, '')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    expect(await withFileLock(lock, () => 'done', { staleMs: 1_000 })).toBe('done')
    expect(existsSync(lock)).toBe(false)
  })

  it('gives up with the 503 cache_unavailable problem, and always releases after work fails', async () => {
    const dir = appFolder()
    const lock = join(dir, 'held.lock')
    writeFileSync(lock, '')
    await expect(
      withFileLock(lock, () => 'never', { staleMs: 60_000, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'cache_unavailable', status: 503 })
    expect(existsSync(lock)).toBe(true)
    const other = join(dir, 'nested', 'work.lock')
    await expect(
      withFileLock(other, () => {
        throw new Error('work failed')
      }),
    ).rejects.toThrow('work failed')
    expect(existsSync(other)).toBe(false)
  })
})

describe('cache config', () => {
  const clock = createTestClock(NOW)
  const manager = (config: unknown) => createCacheManager({ basePath: appFolder(), clock, config })

  it('defaults to memory, knows both drivers and repoints stores', () => {
    expect(manager(undefined).defaultStore).toBe('memory')
    expect(manager({ default: 'file' }).storeNames).toEqual(['file', 'memory'])
    const custom = manager({
      default: 'shared',
      stores: { shared: { driver: 'file', path: 'tmp/c' } },
    })
    expect(custom.store()).toBeInstanceOf(FileCacheStore)
    expect(custom.store()).toBe(custom.store('shared'))
  })

  it('stops boot with a friendly error for every bad shape', () => {
    const cases: [unknown, string][] = [
      ['file', 'invalid_cache_config'],
      [{ default: 7 }, 'invalid_cache_config'],
      [{ stores: [] }, 'invalid_cache_config'],
      [{ stores: { redis: { driver: 'redis' } } }, 'unknown_cache_driver'],
      [{ stores: { file: { driver: 'file', path: ' ' } } }, 'invalid_cache_config'],
      [{ default: 'nowhere' }, 'unknown_cache_store'],
    ]
    for (const [config, code] of cases)
      expect(() => manager(config), JSON.stringify(config)).toThrow(
        expect.objectContaining({ code }),
      )
    expect(() => manager({}).store('none')).toThrow(
      expect.objectContaining({ code: 'unknown_cache_store' }),
    )
  })
})

describe('session:flush', () => {
  it('deletes every session file, keeping hidden files and folders', async () => {
    const base = appFolder()
    const folder = join(base, SESSION_FOLDER)
    mkdirSync(join(folder, 'nested'), { recursive: true })
    for (const name of ['a', 'b', 'c', '.gitignore']) writeFileSync(join(folder, name), name)
    const result = await strut(['session:flush', '--json'], { cwd: base })
    expect(result.code).toBe(0)
    expect(result.json().data).toEqual({ removed: 3 })
    expect(readdirSync(folder).sort()).toEqual(['.gitignore', 'nested'])
    expect(await new FileSessionStore(appFolder()).flush()).toBe(0)
  })

  it("uses the app's own store when a package bound one, and is guarded in production", async () => {
    const base = appFolder()
    let flushed = 0
    const app = () => {
      const built = buildApp(base).app
      built.container.value(SessionStoreToken, {
        flush: async () => {
          flushed++
          return 12
        },
      })
      return built
    }
    const result = await strut(['session:flush'], { cwd: base, app })
    expect(result.stdout).toContain('12 sessions deleted')
    expect(flushed).toBe(1)
    const refused = await strut(['session:flush', '--json'], {
      cwd: base,
      app,
      env: { APP_ENV: 'staging' },
    })
    expect(refused.json().error?.code).toBe('production_guard')
    expect(flushed).toBe(1)
  })
})
