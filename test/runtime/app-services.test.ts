// What a generated app needs beyond CRUD, end to end over real HTTP: custom routes that use the
// app's data and storage (tenant scope, policy scope, permission checks, streaming uploads with a
// per-route body limit and guaranteed temp-file cleanup), signed links served at /storage/<disk>,
// and `sv start` serving the built UI next to the API without ever shadowing it.
import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createStaticFiles, safeSegments } from '../../src/http/static-files.ts'
import { migrateProject } from '../../src/runtime/migrations.ts'
import { loadProject } from '../../src/runtime/project.ts'
import { startServer } from '../../src/runtime/server.ts'
import { storageFromConfig } from '../../src/runtime/storage-config.ts'
import { IMPORTS, makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** Server still healthy after an attack request. */
const healthy = async (base: string) => expect((await fetch(`${base}/health`)).status).toBe(200)

const APP_KEY = 'a'.repeat(44)
const MB = 1024 * 1024

const routes = `import { route } from '${IMPORTS.http}'
import Invoice from '../../models/invoice.model.ts'
export default [
  route.get('/stats', { public: true, handler: async (c) => ({
    count: await c.repository(Invoice).count(undefined, c.scope),
    drafts: (await c.repository('Invoice').list({}, await c.scopeFor(Invoice, 'viewAny'))).data.length,
  }) }),
  route.post('/invoices/:id/pay', { public: true, handler: async (c) => {
    await c.authorize('invoice.update')
    const repo = c.repository(Invoice)
    const updated = await repo.update(c.params.id, { status: 'paid' }, await c.scopeFor(Invoice, 'update'))
    return updated ?? new Response(null, { status: 404 })
  } }),
  route.post('/upload', { public: true, bodyLimit: 3 * ${MB}, handler: async (c) => {
    const form = await c.multipart({ maxFileSize: 2 * ${MB}, fileFields: ['file'] })
    const file = form.file('file')
    if (!file) return new Response(null, { status: 400 })
    const stored = await file.store('notes', { storage: c.storage, id: () => crypto.randomUUID() })
    return { key: stored.key, url: await c.storage.disk().temporaryUrl(stored.key) }
  } }),
  route.post('/upload-fails', { public: true, bodyLimit: 3 * ${MB}, handler: async (c) => {
    await c.multipart({ tempDir: process.env.SV_TEST_TMP })
    throw new Error('handler bug after parsing')
  } }),
]
`

async function project(extra: Record<string, string> = {}) {
  const p = await makeProject(
    projectFiles({
      'config/app.ts': `export default { name: 'demo', env: 'local', port: 0, key: '${APP_KEY}' }\n`,
      'app/http/routes/extra.ts': routes,
      ...extra,
    }),
  )
  cleanups.push(p.cleanup)
  return p.root
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
])

function form(name: string, bytes: Buffer, type = 'image/png'): { body: Blob; type: string } {
  const boundary = 'svtestboundary'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body: new Blob([body]), type: `multipart/form-data; boundary=${boundary}` }
}

/** POST a form; the status, or 'reset' when the server closed the connection mid-upload. */
const postForm = (url: string, f: { body: Blob; type: string }) =>
  fetch(url, { method: 'POST', body: f.body, headers: { 'content-type': f.type } }).then(
    async (r) => ({ status: r.status as number | 'reset', json: await r.json().catch(() => null) }),
    () => ({ status: 'reset' as const, json: null }),
  )

describe('custom routes use the app (data, permissions, storage)', () => {
  test('repository + scope, scopeFor, authorize, multipart with per-route body limit, signed links', async () => {
    const root = await project()
    await migrateProject(await loadProject(root, { dotenv: false }))
    const started = await startServer({ root, port: 0, env: 'local' })
    try {
      const base = started.server.url
      const created = await fetch(`${base}/api/v1/invoices`, {
        method: 'POST',
        body: JSON.stringify({ number: 'INV-1', amount: '10.00' }),
        headers: { 'content-type': 'application/json' },
      })
      const invoice = (await created.json()) as { id: string }
      expect(await (await fetch(`${base}/api/v1/stats`)).json()).toEqual({ count: 1, drafts: 1 })
      const paid = await fetch(`${base}/api/v1/invoices/${invoice.id}/pay`, { method: 'POST' })
      expect(((await paid.json()) as { status: string }).status).toBe('paid')

      // A 2.2 MB body: above the app's 1 MiB default (refused on a normal route) but within the
      // upload route's own limit; the file itself is then over its 2 MB multipart limit.
      const big = form('big.png', Buffer.concat([PNG, Buffer.alloc(2.2 * MB)]))
      // Far over a limit, the server answers 413 and stops reading after a bounded discard, so a
      // client still uploading may see the connection close instead. It must never crash.
      expect([413, 'reset']).toContain((await postForm(`${base}/api/v1/echo`, big)).status)
      await healthy(base)
      const tooBigFile = await postForm(`${base}/api/v1/upload`, big)
      expect(tooBigFile.status).toBe(413)
      expect((tooBigFile.json as { code: string }).code).toBe('FILE_TOO_LARGE')
      await healthy(base)
      const huge = form('huge.png', Buffer.concat([PNG, Buffer.alloc(3.5 * MB)]))
      expect([413, 'reset']).toContain((await postForm(`${base}/api/v1/upload`, huge)).status)
      await healthy(base)

      // A real upload: stored under a generated key, served through a signed link only.
      const ok = form('../../etc/passwd.png', PNG, 'text/html')
      const up = await fetch(`${base}/api/v1/upload`, {
        method: 'POST',
        body: ok.body,
        headers: { 'content-type': ok.type },
      })
      expect(up.status).toBe(200)
      const { key, url } = (await up.json()) as { key: string; url: string }
      expect(key).toMatch(/^notes\/[0-9a-f-]{36}\.png$/)
      expect(existsSync(join(root, 'storage/app', ...key.split('/')))).toBe(true)
      const file = await fetch(`${base}${url}`)
      expect(file.status).toBe(200)
      expect(file.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true)
      // Tampered or unsigned links are 404, never the file.
      expect([403, 404]).toContain(
        (await fetch(`${base}${url.replace(/signature=[^&]+/, 'signature=AAAA')}`)).status,
      )
      expect([403, 404]).toContain((await fetch(`${base}/storage/local/${key}`)).status)
    } finally {
      await started.stop()
    }
  })

  test('temp files are deleted even when the handler fails after parsing', async () => {
    const tmp = join(tmpdir(), `sv-upload-cleanup-${process.pid}-${Date.now()}`)
    await mkdir(tmp, { recursive: true })
    process.env['SV_TEST_TMP'] = tmp
    const root = await project()
    await migrateProject(await loadProject(root, { dotenv: false }))
    const started = await startServer({ root, port: 0, env: 'local' })
    try {
      const f = form('a.png', PNG)
      const res = await fetch(`${started.server.url}/api/v1/upload-fails`, {
        method: 'POST',
        body: f.body,
        headers: { 'content-type': f.type },
      })
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toContain('handler bug')
      expect(readdirSync(tmp)).toEqual([])
    } finally {
      delete process.env['SV_TEST_TMP']
      await started.stop()
    }
  })

  test('route bodyLimit must be a positive byte count', async () => {
    const { route } = await import('../../src/http/route.ts')
    expect(() => route.post('/x', { bodyLimit: 0, handler: () => 1 })).toThrow(/bodyLimit/)
    expect(() => route.post('/x', { bodyLimit: 1.5, handler: () => 1 })).toThrow(/bodyLimit/)
  })
})

describe('config/filesystems.ts', () => {
  test('defaults to a private local disk under the project root, signed with the app key', () => {
    const s = storageFromConfig(undefined, { root: '/srv/app', appKey: APP_KEY })
    expect(s.default).toBe('local')
    expect(s.disks.map((d) => d.name)).toEqual(['local'])
    expect(s.signedFiles).toHaveLength(1)
    expect(storageFromConfig(undefined, { root: '/srv/app' }).signedFiles).toEqual([])
  })

  test('named disks, memory driver, and loud failures for unsafe or broken settings', () => {
    const s = storageFromConfig(
      {
        default: 'scratch',
        disks: { uploads: { driver: 'local', root: 'var/uploads' }, scratch: { driver: 'memory' } },
      },
      { root: '/srv/app', appKey: APP_KEY },
    )
    expect(s.default).toBe('scratch')
    expect(s.disks.map((d) => d.name)).toEqual(['uploads', 'scratch'])
    expect(() => storageFromConfig({ signingSecret: 'short' }, { root: '/' })).toThrow(/32 bytes/)
    expect(() =>
      storageFromConfig({ disks: { s3: { driver: 's3' as 'local' } } }, { root: '/' }),
    ).toThrow(/unknown driver "s3"/)
    expect(() =>
      storageFromConfig({ default: 'nope', disks: { local: { driver: 'local' } } }, { root: '/' }),
    ).toThrow(/default disk "nope"/)
  })
})

describe('serving the built UI', () => {
  test('sv start serves dist/web with SPA fallback, page CSP and caching; never shadows the API', async () => {
    const root = await project({
      'dist/web/index.html': '<!doctype html><title>app</title>',
      'dist/web/assets/app-1a2b.js': 'console.log(1)',
      'dist/web/.env': 'SECRET=1',
    })
    await migrateProject(await loadProject(root, { dotenv: false }))
    const started = await startServer({ root, port: 0, env: 'local' })
    try {
      const base = started.server.url
      const html = { accept: 'text/html' }
      const index = await fetch(`${base}/`, { headers: html })
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      expect(index.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(index.headers.get('cache-control')).toBe('no-cache')
      const deep = await fetch(`${base}/invoices/123/edit`, { headers: html })
      expect(await deep.text()).toContain('<title>app</title>')
      const asset = await fetch(`${base}/assets/app-1a2b.js`)
      expect(asset.headers.get('content-type')).toContain('text/javascript')
      expect(asset.headers.get('cache-control')).toContain('immutable')
      // The API, discovery and storage paths are never answered by the UI.
      const api = await fetch(`${base}/api/v1/nope`, { headers: html })
      expect(api.status).toBe(404)
      expect(api.headers.get('content-type')).toContain('problem+json')
      expect((await fetch(`${base}/health`)).headers.get('content-type')).toContain('json')
      // Missing files with an extension and non-navigations are 404s, not index.html.
      expect((await fetch(`${base}/assets/missing.js`, { headers: html })).status).toBe(404)
      expect((await fetch(`${base}/somewhere`)).status).toBe(404)
      // Dot-files and traversal attempts are never served.
      for (const path of [
        '/.env',
        '/%2e%2e/config/app.ts',
        '/..%2fconfig%2fapp.ts',
        '/a%5c..%5c.env',
      ]) {
        const r = await fetch(`${base}${path}`)
        expect(r.status, path).toBe(404)
        expect(await r.text()).not.toContain('SECRET')
      }
      expect((await fetch(`${base}/`, { method: 'HEAD', headers: html })).status).toBe(200)
    } finally {
      await started.stop()
    }
    // web: false serves the API only.
    const apiOnly = await startServer({ root, port: 0, env: 'local', web: false })
    try {
      expect(
        (await fetch(`${apiOnly.server.url}/`, { headers: { accept: 'text/html' } })).status,
      ).toBe(404)
    } finally {
      await apiOnly.stop()
    }
  })

  test('safeSegments refuses every escaping or hidden path', async () => {
    expect(safeSegments('/a/b.js')).toEqual(['a', 'b.js'])
    for (const bad of [
      '/../x',
      '/%2e%2e/x',
      '/a%2fb',
      '/a%5cb',
      '/.git/config',
      '/a%00b',
      '/c:x',
      '/%E0%A4%A',
    ]) {
      expect(safeSegments(bad), bad).toBeUndefined()
    }
    const handler = createStaticFiles({ root: '/does/not/exist' })
    expect(await handler(new Request('http://x/', { method: 'POST' }))).toBeUndefined()
    expect(
      await handler(new Request('http://x/', { headers: { accept: 'text/html' } })),
    ).toBeUndefined()
  })
})
