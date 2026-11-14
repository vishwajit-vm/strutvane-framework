/**
 * The UI on the API's origin in `sv dev`: the shared "may the UI answer this" rule, the
 * fall-through marker, the Node adapter handing requests to a Connect handler, resolving the
 * project's own Vite, and `startServer({ vite: true })` end to end with a stand-in Vite package
 * installed in the project (the framework has no Vite of its own, by design).
 */
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { projectViteBin } from '../../src/commands.ts'
import { HTTP_HOOKS } from '../../src/contracts/index.ts'
import { HooksToken } from '../../src/core/index.ts'
import {
  FRAMEWORK_PATHS,
  isExcludedPath,
  isUiRequest,
  UI_FALLTHROUGH_HEADER,
  uiExcludedPaths,
} from '../../src/http/ui-paths.ts'
import {
  esmEntry,
  findViteConfig,
  projectPackageManifest,
  resolveProjectVite,
  VITE_CONFIG_FILES,
} from '../../src/runtime/dev-ui.ts'
import { migrateProject } from '../../src/runtime/migrations.ts'
import { loadProject } from '../../src/runtime/project.ts'
import { type RunningServer, serve } from '../../src/runtime/serve.ts'
import { startServer } from '../../src/runtime/server.ts'
import { createTestApp } from '../../src/testing/index.ts'
import { Customer, Invoice } from '../helpers/models.ts'
import { makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const html = { accept: 'text/html' }

/**
 * A stand-in `vite` package: records the config it was started with, answers every request
 * with an HTML page naming the path (except `/missing*` → `next()`, `/boom` → `next(error)`),
 * and answers websocket upgrades on the server it got as `hmr.server`, like Vite's HMR.
 */
const FAKE_VITE = `
const state = (globalThis.__svFakeVite ??= { configs: [], closed: 0 })
export async function loadConfigFromFile(env, file, root) {
  state.loaded = { env, file, root }
  return { path: file, config: { root: 'web' }, dependencies: [] }
}
export async function createServer(config) {
  state.configs.push(config)
  config.server.hmr.server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nx-fake-vite: ' + req.url + '\\r\\n\\r\\n')
  })
  return {
    middlewares(req, res, next) {
      if (req.url.startsWith('/missing')) return next()
      if (req.url === '/boom') return next(new Error('vite failed'))
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>vite ' + req.method + ' ' + req.url + '</title>')
    },
    async close() { state.closed += 1 },
  }
}
`

interface FakeViteState {
  configs: Record<string, unknown>[]
  closed: number
  loaded?: { env: unknown; file: string; root: string }
}
const fakeState = (): FakeViteState =>
  (globalThis as unknown as { __svFakeVite: FakeViteState }).__svFakeVite

const viteFiles = (entry = 'index.js', source = FAKE_VITE): Record<string, string> => ({
  'vite.config.ts': 'export default {}\n',
  'node_modules/vite/package.json': JSON.stringify({
    name: 'vite',
    version: '0.0.0-fake',
    type: 'module',
    exports: { '.': { import: `./${entry}` }, './package.json': './package.json' },
    bin: { vite: 'bin/vite.js' },
  }),
  [`node_modules/vite/${entry}`]: source,
})

async function project(extra: Record<string, string>): Promise<string> {
  const p = await makeProject(projectFiles(extra))
  cleanups.push(p.cleanup)
  return p.root
}

describe('ui-paths: what the UI may answer', () => {
  it('excludes the API base path, framework paths and extras, tolerating trailing slashes', () => {
    const exclude = uiExcludedPaths('/api/v1/', ['/custom/'])
    expect(exclude).toEqual(['/api/v1', ...FRAMEWORK_PATHS, '/custom'])
    for (const path of [
      '/api/v1',
      '/api/v1/invoices',
      '/_strutvane/logs',
      '/storage/local/x',
      '/openapi.json',
      '/health',
      '/ready',
      '/.well-known/strutvane.json',
      '/custom/x',
    ])
      expect(isExcludedPath(path, exclude), path).toBe(true)
    for (const path of ['/', '/invoices', '/api', '/api/v10', '/healthy', '/src/main.tsx'])
      expect(isExcludedPath(path, exclude), path).toBe(false)
  })

  it('only GET and HEAD outside the excluded paths', () => {
    const exclude = uiExcludedPaths('/api/v1')
    const req = (method: string, path: string) => new Request(`http://x${path}`, { method })
    expect(isUiRequest(req('GET', '/invoices'), exclude)).toBe(true)
    expect(isUiRequest(req('HEAD', '/'), exclude)).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
      expect(isUiRequest(req(method, '/invoices'), exclude), method).toBe(false)
    expect(isUiRequest(req('GET', '/api/v1/nope'), exclude)).toBe(false)
  })
})

describe('createHttpApp({ uiFallthrough })', () => {
  it('marks only unmatched UI requests, keeps API 404s as problems and skips http.onResponse for them', async () => {
    const t = await createTestApp({
      resources: [Customer, Invoice],
      http: { uiFallthrough: true },
    })
    cleanups.push(() => t.close())
    const reported: string[] = []
    t.app.make(HooksToken).on(
      HTTP_HOOKS.response,
      (p) => {
        reported.push(new URL((p as { request: Request }).request.url).pathname)
        return undefined
      },
      { name: 'test.responses' },
    )
    const get = (path: string, init: RequestInit = {}) => t.http.request(path, init)

    const ui = await get('/invoices/1/edit', { headers: html })
    expect(ui.status).toBe(404)
    expect(ui.headers.get(UI_FALLTHROUGH_HEADER)).toBe('1')
    expect(ui.headers.get('content-type')).toContain('problem+json')

    for (const path of ['/api/v1/nope', '/health/x', '/_strutvane/x', '/.well-known/x']) {
      const r = await get(path, { headers: html })
      expect(r.status, path).toBe(404)
      expect(r.headers.has(UI_FALLTHROUGH_HEADER), path).toBe(false)
    }
    const post = await get('/invoices', { method: 'POST' })
    expect(post.headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)
    // Matched routes are never marked.
    expect((await get('/health')).headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)

    expect(reported).not.toContain('/invoices/1/edit')
    expect(reported).toContain('/api/v1/nope')
    expect(reported).toContain('/health')
  })

  it('is off by default', async () => {
    const t = await createTestApp({ resources: [Customer, Invoice] })
    cleanups.push(() => t.close())
    const r = await t.http.request('/invoices', { headers: html })
    expect(r.headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)
  })
})

describe('serve({ prepare, fallback })', () => {
  let server: RunningServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const marked = (status = 404) =>
    new Response('{"status":404}', {
      status,
      headers: { 'content-type': 'application/problem+json', [UI_FALLTHROUGH_HEADER]: '1' },
    })

  it('hands marked requests to the fallback; next() sends the app response without the marker', async () => {
    let prepared = false
    server = await serve(() => marked(), {
      port: 0,
      prepare: (s) => {
        expect(s.listening).toBe(false)
        prepared = true
      },
      fallback: (req, res, next) => {
        if (req.url === '/pass') return next()
        if (req.url === '/fail') return next(new Error('handler failed'))
        if (req.url === '/throw') throw new Error('handler threw')
        res.setHeader('content-type', 'text/plain')
        res.end(`fallback ${req.url}`)
      },
      onError: () => undefined,
    })
    expect(prepared).toBe(true)
    const own = await fetch(`${server.url}/page`)
    expect(await own.text()).toBe('fallback /page')
    const passed = await fetch(`${server.url}/pass`)
    expect(passed.status).toBe(404)
    expect(passed.headers.get('content-type')).toContain('problem+json')
    expect(passed.headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)
    expect((await fetch(`${server.url}/fail`)).status).toBe(500)
    expect((await fetch(`${server.url}/throw`)).status).toBe(500)
  })

  it('never hands over unmarked responses, and strips the marker without a fallback', async () => {
    const seen: string[] = []
    server = await serve(
      (request) =>
        new URL(request.url).pathname === '/marked'
          ? marked()
          : new Response('app', { status: 200 }),
      {
        port: 0,
        fallback: (req, _res, next) => {
          seen.push(req.url ?? '')
          next()
        },
      },
    )
    expect(await (await fetch(`${server.url}/plain`)).text()).toBe('app')
    expect(seen).toEqual([])
    await server.close()
    server = await serve(() => marked(), { port: 0 })
    const r = await fetch(`${server.url}/x`)
    expect(r.status).toBe(404)
    expect(r.headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)
  })

  it('a failing prepare() never listens', async () => {
    await expect(
      serve(() => new Response('x'), {
        port: 0,
        prepare: () => {
          throw new Error('no vite')
        },
      }),
    ).rejects.toThrow('no vite')
  })
})

describe("resolving the project's Vite", () => {
  it('finds config files in Vite order and reads ESM entries from exports or main', async () => {
    expect(VITE_CONFIG_FILES).toContain('vite.config.ts')
    const root = await project({ 'vite.config.mjs': '', 'vite.config.ts': '' })
    expect(findViteConfig(root)).toMatch(/vite\.config\.mjs$/)
    expect(esmEntry({ exports: './dist/node/index.js' })).toBe('./dist/node/index.js')
    expect(esmEntry({ exports: { '.': './a.js', './package.json': './package.json' } })).toBe(
      './a.js',
    )
    expect(esmEntry({ exports: { '.': { types: './t.d.ts', import: './i.js' } } })).toBe('./i.js')
    expect(esmEntry({ exports: { '.': { node: { import: './n.js' } } } })).toBe('./n.js')
    expect(esmEntry({ exports: { import: './top.js', require: './top.cjs' } })).toBe('./top.js')
    expect(esmEntry({ exports: { '.': { require: './only.cjs' } } })).toBeUndefined()
    expect(esmEntry({ module: './m.js', main: './c.js' })).toBe('./m.js')
    expect(esmEntry({ main: './c.js' })).toBe('./c.js')
    expect(esmEntry({})).toBeUndefined()
  })

  it('reports an API-only project, a missing install, and refuses a broken one', async () => {
    expect(await resolveProjectVite(await project({}))).toEqual({ status: 'no-config' })
    const noInstall = await project({ 'vite.config.ts': 'export default {}\n' })
    expect((await resolveProjectVite(noInstall)).status).toBe('not-installed')
    expect(await projectViteBin(noInstall)).toBeUndefined()
    const broken = await project(viteFiles('index.js', 'export const notVite = true\n'))
    await expect(resolveProjectVite(broken)).rejects.toThrow(/no createServer/)
    const noEntry = await project({
      'vite.config.ts': '',
      'node_modules/vite/package.json': JSON.stringify({ name: 'vite', exports: {} }),
    })
    await expect(resolveProjectVite(noEntry)).rejects.toThrow(/entry point/)
  })

  it("resolves the project's own package and its CLI script", async () => {
    const root = await project(viteFiles('dist/entry.js'))
    const vite = await resolveProjectVite(root)
    expect(vite.status).toBe('ready')
    if (vite.status === 'ready') expect(vite.entry).toMatch(/node_modules[\\/]vite[\\/]dist/)
    expect(await projectViteBin(root)).toMatch(/node_modules[\\/]vite[\\/]bin[\\/]vite\.js$/)
  })
})

describe('startServer({ vite: true }): API and UI on one port', () => {
  it("serves UI requests through the project's Vite, the API itself, and HMR upgrades", async () => {
    const root = await project(viteFiles())
    await migrateProject(await loadProject(root, { dotenv: false }))
    const before = fakeState()?.closed ?? 0
    const started = await startServer({ root, port: 0, env: 'local', vite: true })
    const stop = () => started.stop()
    try {
      const state = fakeState()
      const config = state.configs.at(-1) as {
        root: string
        appType: string
        configFile: string
        server: { middlewareMode: boolean }
      }
      expect(config.appType).toBe('spa')
      expect(config.server.middlewareMode).toBe(true)
      expect(config.configFile).toMatch(/vite\.config\.ts$/)
      // `root: 'web'` resolved against the project, not the working directory.
      expect(config.root.replace(/\\/g, '/')).toBe(`${root.replace(/\\/g, '/')}/web`)

      const base = started.server.url
      const page = await fetch(`${base}/invoices/1`, { headers: html })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('vite GET /invoices/1')
      expect(await (await fetch(`${base}/src/main.tsx`)).text()).toContain('/src/main.tsx')

      // The API keeps its own answers, including problem+json 404s for unknown API paths.
      const api = await fetch(`${base}/api/v1/hello`)
      expect(await api.json()).toEqual({ message: 'hi' })
      const missingApi = await fetch(`${base}/api/v1/nope`, { headers: html })
      expect(missingApi.status).toBe(404)
      expect(missingApi.headers.get('content-type')).toContain('problem+json')
      expect((await fetch(`${base}/health`)).status).toBe(200)
      const post = await fetch(`${base}/invoices`, { method: 'POST' })
      expect(post.headers.get('content-type')).toContain('problem+json')

      // Vite passing a request on yields the app's 404, and the marker never leaks.
      const passed = await fetch(`${base}/missing.js`)
      expect(passed.status).toBe(404)
      expect(passed.headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)

      // HMR websocket upgrades on the same port reach Vite.
      const upgrade = await new Promise<string>((resolve, reject) => {
        const socket = connect(started.server.port, '127.0.0.1', () => {
          socket.write(
            'GET /?token=x HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n' +
              'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n',
          )
        })
        let data = ''
        socket.on('data', (chunk) => {
          data += chunk.toString()
        })
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      expect(upgrade).toContain('101 Switching Protocols')
      expect(upgrade).toContain('x-fake-vite: /?token=x')
    } finally {
      await stop()
    }
    expect(fakeState().closed).toBe(before + 1)
  })

  it('serves the API only (as before) without a Vite config, and never the built UI', async () => {
    const root = await project({ 'dist/web/index.html': '<!doctype html><title>stale</title>' })
    await migrateProject(await loadProject(root, { dotenv: false }))
    const started = await startServer({ root, port: 0, env: 'local', vite: true, web: false })
    try {
      const r = await fetch(`${started.server.url}/`, { headers: html })
      expect(r.status).toBe(404)
      expect(await r.text()).not.toContain('stale')
      expect((await fetch(`${started.server.url}/api/v1/hello`)).status).toBe(200)
    } finally {
      await started.stop()
    }
  })

  it('serves the API only when Vite is configured but not installed', async () => {
    const root = await project({ 'vite.config.ts': 'export default {}\n' })
    await migrateProject(await loadProject(root, { dotenv: false }))
    const started = await startServer({ root, port: 0, env: 'local', vite: true })
    try {
      const r = await fetch(`${started.server.url}/x`, { headers: html })
      expect(r.status).toBe(404)
      expect(r.headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)
    } finally {
      await started.stop()
    }
  })
})

describe('projectPackageManifest', () => {
  it("finds a package in the project's or a parent workspace's node_modules, never elsewhere", async () => {
    const root = await project({
      'node_modules/@scope/pkg/package.json': '{"name":"@scope/pkg"}',
      'apps/site/package.json': '{"name":"site"}',
    })
    const nested = `${root}/apps/site`
    expect(projectPackageManifest(nested, '@scope/pkg')).toMatch(
      /node_modules[\\/]@scope[\\/]pkg[\\/]package\.json$/,
    )
    // vitest runs under `pnpm exec`, whose NODE_PATH holds this repo's own (real) vite: ignored.
    expect(projectPackageManifest(nested, 'vite')).toBeUndefined()
  })
})
