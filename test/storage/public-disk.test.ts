/**
 * Storage in the v2 Application: `config/filesystems.ts` is read at boot (disks, default disk),
 * the `Storage` facade works, and a **public** disk is served at `/storage/…`.
 *
 * Found by the docs agent and the skeleton (2026-11-18): 0.2.0-next.1 bound no storage manager at
 * all in an `Application`, so `Storage.put()` failed and the skeleton's `public` disk was never
 * served. The attack half checks what a file server must never do: traversal out of the disk,
 * directory listings, the disk's metadata folder, private files on a public disk, and active
 * content served inline.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StorageDisk } from '../../src/contracts/storage.ts'
import { createTestClock } from '../../src/core/clock.ts'
import { ClockToken, LoggerToken } from '../../src/core/tokens.ts'
import { Storage } from '../../src/facades/storage.ts'
import { Application } from '../../src/foundation/application.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import { type ConfigFiles, defineConfig } from '../../src/foundation/config.ts'
import { type AnyProvider, ServiceProvider as Provider } from '../../src/foundation/provider.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { createStorageManager } from '../../src/storage/manager.ts'
import { createMemoryDisk } from '../../src/storage/memory-disk.ts'
import { publicMounts } from '../../src/storage/public-files.ts'
import { StorageManagerToken } from '../../src/tokens.ts'
import { MemoryLogger, NOW, testEnv } from '../app/helpers.ts'

const temporary: string[] = []
afterEach(() => {
  for (const folder of temporary.splice(0))
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

const appConfig = defineConfig((env) => ({
  env: env.string('APP_ENV', 'production'),
  debug: env.boolean('APP_DEBUG', false),
  url: env.string('APP_URL', 'http://localhost'),
  key: env.string('APP_KEY'),
}))

/** The skeleton's config/filesystems.ts. */
const filesystems = defineConfig((env) => ({
  default: env.string('FILESYSTEM_DISK', 'local'),
  disks: {
    local: { driver: 'local', root: 'storage/app', visibility: 'private' },
    public: {
      driver: 'local',
      root: 'storage/app/public',
      visibility: 'public',
      url: `${env.url('APP_URL', 'http://localhost:3000')}/storage`,
    },
  },
}))

function build(
  config: ConfigFiles = { app: appConfig, filesystems },
  providers: readonly AnyProvider[] = [],
): Application {
  const root = mkdtempSync(join(tmpdir(), 'strut-storage-'))
  temporary.push(root)
  const app = Application.configure({ basePath: root, env: { ...testEnv, APP_DEBUG: 'false' } })
    .withConfig(config)
    .withProviders(providers)
    .withRouting({
      web: defineRoutes([Route.post('/storage/upload', (ctx) => ctx.json({ routed: true }))]),
    })
    .create()
  app.container.value(LoggerToken, new MemoryLogger())
  app.container.value(ClockToken, createTestClock(NOW))
  return app
}

const get = (app: Application, path: string, init: RequestInit = {}): Promise<Response> =>
  app.handle(new Request(`http://localhost${path}`, init))

async function bootCode(app: Application): Promise<string> {
  const error = await app.boot().then(
    () => undefined,
    (caught: unknown) => caught,
  )
  return isBootError(error) ? error.code : `not a boot error: ${String(error)}`
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('config/filesystems.ts in an Application', () => {
  it('binds the disks and the default disk; the Storage facade works', async () => {
    const app = build()
    await app.boot()
    const manager = app.make(StorageManagerToken)
    expect(manager.defaultDisk).toBe('local')
    expect([...manager.names()].sort()).toEqual(['local', 'public'])
    await app.run(() => Storage.put('reports/q1.txt', 'private numbers'))
    expect(await manager.disk('local').exists('reports/q1.txt')).toBe(true)
    // The local disk is private: never served.
    expect((await get(app, '/storage/reports/q1.txt')).status).toBe(404)
  })

  it('without config/filesystems.ts there is one private local disk, and nothing is served', async () => {
    const app = build({ app: appConfig })
    await app.boot()
    expect(app.make(StorageManagerToken).names()).toEqual(['local'])
    expect((await get(app, '/storage/anything.txt')).status).toBe(404)
  })

  it("a provider's own storage manager wins (cloud disks from @strutvane/files)", async () => {
    const cloud = createStorageManager({ default: 'memory', disks: [createMemoryDisk()] })
    class FilesProvider extends Provider {
      override register(app: Application): void {
        app.container.value(StorageManagerToken, cloud)
      }
    }
    const app = build(undefined, [FilesProvider])
    await app.boot()
    expect(app.make(StorageManagerToken)).toBe(cloud)
  })

  it('a bad disk stops the boot with a hint', async () => {
    const broken = defineConfig(() => ({ disks: { s3: { driver: 's3' } } }))
    expect(await bootCode(build({ app: appConfig, filesystems: broken }))).toBe(
      'invalid_filesystems_config',
    )
    const wrongDefault = defineConfig(() => ({
      default: 'nope',
      disks: { local: { driver: 'local' } },
    }))
    expect(await bootCode(build({ app: appConfig, filesystems: wrongDefault }))).toBe(
      'invalid_filesystems_config',
    )
    const notAnObject = defineConfig(() => 'disks')
    expect(await bootCode(build({ app: appConfig, filesystems: notAnObject }))).toBe(
      'invalid_filesystems_config',
    )
  })

  it('two public disks on one path are refused (one would hide the other)', async () => {
    const clash = defineConfig(() => ({
      disks: {
        public: { driver: 'local', visibility: 'public', url: 'http://localhost/storage' },
        media: { driver: 'local', visibility: 'public', url: 'http://localhost/storage/media' },
      },
    }))
    expect(await bootCode(build({ app: appConfig, filesystems: clash }))).toBe(
      'public_disk_path_clash',
    )
  })
})

describe('the public disk at /storage', () => {
  async function withFiles(): Promise<{ app: Application; disk: StorageDisk }> {
    const app = build()
    await app.boot()
    const disk = app.make(StorageManagerToken).disk('public')
    await disk.put('avatars/7.png', PNG, { contentType: 'image/png' })
    await disk.put('avatars/secret.png', PNG, { contentType: 'image/png', visibility: 'private' })
    await disk.put('logo.svg', '<svg onload="alert(1)"/>', { contentType: 'image/svg+xml' })
    await disk.put('page.html', '<script>alert(1)</script>', {
      contentType: 'text/html; charset=utf-8',
    })
    return { app, disk }
  }

  it('serves a public file at the URL the disk hands out, with safe headers', async () => {
    const { app, disk } = await withFiles()
    const url = new URL(await disk.url('avatars/7.png'))
    expect(url.pathname).toBe('/storage/avatars/7.png')
    const response = await get(app, url.pathname)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(PNG.length))
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('content-disposition')).toBe('inline; filename="7.png"')
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const etag = response.headers.get('etag')
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)

    const head = await get(app, url.pathname, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    const cached = await get(app, url.pathname, { headers: { 'if-none-match': `W/${etag}` } })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
  })

  it('sends active content as a download, however its type is spelled', async () => {
    const { app } = await withFiles()
    for (const path of ['/storage/logo.svg', '/storage/page.html']) {
      const response = await get(app, path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type'), path).toBe('application/octet-stream')
      expect(response.headers.get('content-disposition'), path).toMatch(/^attachment;/)
    }
  })

  it('never serves a private file, a folder, the metadata folder or a missing file', async () => {
    const { app } = await withFiles()
    for (const path of [
      '/storage/avatars/secret.png',
      '/storage/avatars',
      '/storage/avatars/',
      '/storage/',
      '/storage/.strutvane-meta/avatars/7.png.json',
      '/storage/avatars/7.png/x',
      '/storage/missing.png',
    ]) {
      const response = await get(app, path)
      expect(response.status, path).toBe(404)
      expect(await response.text(), path).not.toContain('PNG')
    }
  })

  it('refuses traversal in every spelling', async () => {
    const { app } = await withFiles()
    for (const path of [
      '/storage/..%2f..%2f.env',
      '/storage/%2e%2e/%2e%2e/.env',
      '/storage/avatars/..%2f..%2flocal%2freports',
      '/storage/avatars%5c..%5c..%5c.env',
      '/storage/%00.png',
      '/storage/avatars/%E0%A4%A.png',
      '/storage/AVATARS/7.png',
      '/storage/con.png',
    ]) {
      const response = await get(app, path)
      expect(response.status, path).toBe(404)
      // A problem document, never file bytes.
      expect(response.headers.get('content-type'), path).toContain('json')
      expect(response.headers.get('content-disposition'), path).toBeNull()
    }
  })

  it('other methods are left to the router', async () => {
    const { app } = await withFiles()
    const routed = await get(app, '/storage/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: '{}',
    })
    // The router answers (here the CSRF check refuses a cookie-less form post), not the file server.
    expect([200, 403, 419]).toContain(routed.status)
    expect(routed.headers.get('content-security-policy')).not.toBe("default-src 'none'; sandbox")
  })
})

describe('publicMounts', () => {
  const disk = (name: string): StorageDisk => createMemoryDisk({ name })

  it('uses the url path, else /storage for "public" and /storage/<name> for others', () => {
    const prefixes = (settings: Parameters<typeof publicMounts>[0], names: string[]) =>
      publicMounts(settings, names.map(disk)).map((mount) => [mount.disk.name, mount.prefix])
    expect(prefixes({ public: { visibility: 'public' } }, ['public', 'unlisted'])).toEqual([
      ['public', '/storage'],
    ])
    expect(prefixes({ media: { visibility: 'public' } }, ['media'])).toEqual([
      ['media', '/storage/media'],
    ])
    expect(
      prefixes({ media: { visibility: 'public', url: 'http://localhost:3000/media/' } }, ['media']),
    ).toEqual([['media', '/media']])
    expect(() => prefixes({ bad: { visibility: 'public', url: 'http://[' } }, ['bad'])).toThrow(
      /not a URL/,
    )
  })

  it('skips private disks and CDN roots; refuses nested paths', () => {
    expect(
      publicMounts(
        {
          a: { visibility: 'public', url: 'http://localhost/files/' },
          cdn: { visibility: 'public', url: 'https://cdn.example.com/' },
          local: {},
        },
        [disk('a'), disk('cdn'), disk('local')],
      ).map((mount) => [mount.disk.name, mount.prefix]),
    ).toEqual([['a', '/files']])
    let code: string | undefined
    try {
      publicMounts({ public: { visibility: 'public' }, media: { visibility: 'public' } }, [
        disk('public'),
        disk('media'),
      ])
    } catch (error) {
      code = isBootError(error) ? error.code : 'other'
    }
    expect(code).toBe('public_disk_path_clash')
  })
})
