/**
 * The bootstrap caches through their commands: `config:cache`/`config:clear`, `route:cache`/
 * `route:clear`, `event:cache`/`event:clear`/`event:list`, `optimize`/`optimize:clear`. Caches
 * are encrypted (no secret readable in the file), and a cache from another key, from other code,
 * from a changed route table or edited by hand is ignored with a warning.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertCacheable } from '../../src/console/commands/app/bootstrap-caches.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { retryTransient, writeFileAtomic } from '../../src/support/atomic-write.ts'
import {
  appFolder,
  buildApp,
  cleanupFolders,
  newKey,
  strut,
  testConfig,
  webRoutes,
  writeFiles,
} from './helpers.ts'

afterEach(cleanupFolders)

const LISTENER = `export class LogPostPublished {
  static event = 'post.published'
  handle() {}
}
`

const cachePath = (base: string, kind: string): string =>
  join(base, 'bootstrap', 'cache', `${kind}.json`)
const warnings = (logger: { messages(level: 'warn'): string[] }): string =>
  logger.messages('warn').join('\n')

describe('config:cache and config:clear', () => {
  it('caches config encrypted, uses it on the next boot, and ignores .env changes until cleared', async () => {
    const base = appFolder()
    const secretEnv = { DB_PASSWORD: 'db-password-secret', APP_NAME: 'Cached Name' }
    const cached = await strut(['config:cache', '--json'], {
      cwd: base,
      app: () => buildApp(base, { env: secretEnv }).app,
    })
    expect(cached.code).toBe(0)
    expect(cached.json().data).toEqual({ cached: 'config' })
    const file = readFileSync(cachePath(base, 'config'), 'utf8')
    for (const secret of ['db-password-secret', 'Cached Name', 'base64:'])
      expect(file).not.toContain(secret)
    const next = buildApp(base, { env: { APP_NAME: 'Changed in .env' } })
    await next.app.boot()
    expect(next.app.cacheStatus.config).toBe('used')
    expect(next.app.config('app.name')).toBe('Cached Name')
    // Optional (unset) values stay keys, so config() reads them the same from the cache.
    expect(next.app.config('app.editor')).toBeUndefined()
    const cleared = await strut(['config:clear'], { cwd: base })
    expect(cleared.stdout).toContain('Configuration cache cleared')
    expect((await strut(['config:clear'], { cwd: base })).stdout).toContain('was not cached')
    const fresh = buildApp(base, { env: { APP_NAME: 'Changed in .env' } })
    await fresh.app.boot()
    expect(fresh.app.config('app.name')).toBe('Changed in .env')
  })

  it('ignores, with a warning, a cache from another APP_KEY, from other code, or edited by hand', async () => {
    const base = appFolder()
    await strut(['config:cache'], { cwd: base })
    const otherKey = buildApp(base, { env: { APP_KEY: newKey() } })
    await otherKey.app.boot()
    expect(otherKey.app.cacheStatus.config).toBe('ignored')
    expect(warnings(otherKey.logger)).toContain('built with a different APP_KEY')

    writeFiles(base, { 'routes/web.ts': '// a deploy changed this\n' })
    const newCode = buildApp(base)
    await newCode.app.boot()
    expect(newCode.app.cacheStatus.config).toBe('ignored')
    expect(warnings(newCode.logger)).toContain('built from another version of the code')

    await strut(['config:cache'], { cwd: base })
    const cache = JSON.parse(readFileSync(cachePath(base, 'config'), 'utf8')) as { payload: string }
    const bytes = Buffer.from(cache.payload, 'base64')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    writeFileSync(
      cachePath(base, 'config'),
      JSON.stringify({ ...cache, payload: bytes.toString('base64') }),
    )
    const tampered = buildApp(base)
    await tampered.app.boot()
    expect(tampered.app.cacheStatus.config).toBe('ignored')
    expect(warnings(tampered.logger)).toContain('changed after it was written')
  })

  it('refuses config that JSON cannot hold exactly, and writes nothing', async () => {
    const base = appFolder()
    const config = { ...testConfig, hooks: defineConfig(() => ({ onBoot: () => 'code' })) }
    const result = await strut(['config:cache', '--json'], {
      cwd: base,
      app: () => buildApp(base, { config }).app,
    })
    expect(result.code).toBe(3)
    expect(result.json().error?.code).toBe('config_not_cacheable')
    expect(result.json().error?.message).toContain(
      'config("hooks.onBoot") is a function, which can\'t be cached.',
    )
    expect(existsSync(cachePath(base, 'config'))).toBe(false)
    expect(() => assertCacheable({ n: Number.NaN }, '')).toThrow(/is a NaN/)
    expect(() => assertCacheable({ at: new Date() }, '')).toThrow(/class instance/)
    expect(() => assertCacheable({ list: [1, Symbol('x')] }, '')).toThrow(/"list.1"/)
    expect(() => assertCacheable({ ok: [1, 'a', true, null, { x: undefined }] }, '')).not.toThrow()
  })

  it('a boot failure while caching is reported with its hint, and leaves no cache', async () => {
    const base = appFolder()
    const result = await strut(['config:cache'], {
      cwd: base,
      app: () => buildApp(base, { env: { APP_KEY: 'too-short' } }).app,
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('APP_KEY is too short')
    expect(result.stderr).toContain('→ Run `node strut key:generate`')
    expect(existsSync(cachePath(base, 'config'))).toBe(false)
  })
})

describe('route:cache and route:clear', () => {
  it('lets boot skip the route checks, and ignores a cache whose table changed', async () => {
    const base = appFolder()
    const result = await strut(['route:cache'], { cwd: base })
    expect(result.stdout).toMatch(/✔ \d+ routes cached/)
    const second = buildApp(base)
    await second.app.boot()
    expect(second.app.cacheStatus.routes).toBe('used')
    // Same code, different table (another routes file): the cache no longer describes it.
    const extra = buildApp(base, {
      web: defineRoutes([...webRoutes.entries, Route.get('/extra', (ctx) => ctx.json({}))]),
    })
    await extra.app.boot()
    expect(extra.app.cacheStatus.routes).toBe('ignored')
    expect(warnings(extra.logger)).toContain('the routes changed since it was built')
    expect((await strut(['route:clear'], { cwd: base })).stdout).toContain('Route cache cleared')
    expect(existsSync(cachePath(base, 'routes'))).toBe(false)
  })
})

describe('event:cache, event:clear and event:list', () => {
  it('discovers listeners, lists them, caches them and boots from the cache', async () => {
    const base = appFolder({ 'app/listeners/log-post-published.listener.mjs': LISTENER })
    const listed = await strut(['event:list', '--json'], { cwd: base })
    expect(listed.json().data).toEqual({
      events: [
        {
          event: 'post.published',
          listeners: ['LogPostPublished (app/listeners/log-post-published.listener.mjs)'],
        },
      ],
    })
    const text = await strut(['event:list'], { cwd: base })
    expect(text.stdout).toContain('post.published')
    expect((await strut(['event:list', '--event', 'nothing'], { cwd: base })).stdout).toContain(
      'No listeners',
    )
    const cached = await strut(['event:cache'], { cwd: base })
    expect(cached.stdout).toContain('1 listener cached')
    const booted = buildApp(base)
    await booted.app.boot()
    expect(booted.app.cacheStatus.events).toBe('used')
    expect((await strut(['event:clear'], { cwd: base })).stdout).toContain('Event cache cleared')
  })
})

describe('optimize and optimize:clear', () => {
  it('caches everything in one boot, and optimize:clear removes everything', async () => {
    const base = appFolder({ 'app/listeners/log-post-published.listener.mjs': LISTENER })
    const optimized = await strut(['optimize', '--json'], { cwd: base })
    expect(optimized.code).toBe(0)
    expect(optimized.json().data).toMatchObject({
      cached: ['config', 'routes', 'events'],
      listeners: 1,
    })
    const booted = buildApp(base)
    await booted.app.boot()
    expect(booted.app.cacheStatus).toEqual({ config: 'used', routes: 'used', events: 'used' })
    const clear = await strut(['optimize:clear', '--json'], { cwd: base })
    expect(clear.json().data).toEqual({ cleared: ['config', 'routes', 'events'] })
    expect(readdirSync(join(base, 'bootstrap', 'cache'))).toEqual([])
    const again = await strut(['optimize:clear'], { cwd: base })
    expect(again.stdout).toContain('Configuration cache was not cached')
  })

  it('refuses to boot with APP_DEBUG=true in production unless --force-debug', async () => {
    const base = appFolder()
    const app = () => buildApp(base, { env: { APP_ENV: 'production', APP_DEBUG: 'true' } }).app
    const refused = await strut(['optimize', '--json'], { cwd: base, app })
    expect(refused.json().error?.code).toBe('debug_in_production')
    expect(refused.json().error?.message).toContain('--force-debug')
    const forced = await strut(['optimize', '--force-debug'], { cwd: base, app })
    expect(forced.code).toBe(0)
  })

  it('explains where to run it when there is no app', async () => {
    const result = await strut(['optimize:clear', '--json'], { cwd: join(appFolder(), '..') })
    expect(result.code).toBe(2)
    expect(result.json().error?.code).toBe('app_not_found')
    expect(result.json().error?.message).toContain('bootstrap/app.ts')
  })
})

describe('atomic writes on Windows', () => {
  it('retries transient EPERM/EBUSY/EACCES, then succeeds', () => {
    let calls = 0
    retryTransient(() => {
      calls++
      if (calls < 3)
        throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EPERM' : 'EBUSY' })
    })
    expect(calls).toBe(3)
  })

  it('gives up after the last attempt, and never retries a real error', () => {
    let calls = 0
    expect(() =>
      retryTransient(() => {
        calls++
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }),
    ).toThrow('denied')
    expect(calls).toBe(8)
    let missing = 0
    expect(() =>
      retryTransient(() => {
        missing++
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      }),
    ).toThrow('gone')
    expect(missing).toBe(1)
  })

  it('leaves no temporary files behind', () => {
    const folder = join(appFolder(), 'out')
    for (let index = 0; index < 20; index++)
      writeFileAtomic(join(folder, 'state.json'), String(index))
    expect(readdirSync(folder)).toEqual(['state.json'])
    expect(readFileSync(join(folder, 'state.json'), 'utf8')).toBe('19')
  })
})
