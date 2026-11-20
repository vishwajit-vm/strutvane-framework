/**
 * The app runtime of a generated (v2) app, reproducing the demo acceptance run's blockers:
 *
 * - FW-1 / FW-2: `node strut dev` and `node strut build` failed on every app with
 *   "No strutvane.config.ts" (they loaded the v1 project to read the port).
 * - FW-3: `node strut start` never served the built UI (`dist/web`): `GET /assets/…` was a 404.
 * - FW-1 (dev): the project's Vite was only mounted for v1 projects.
 * - DOCK-2: bound to `0.0.0.0` (inside a container) every request was `400 untrusted_host`,
 *   because the request URL named the wildcard bind address; and `APP_HOST` was ignored.
 *
 * Real sockets and real servers; the UI comes from files on disk or a stand-in Vite package in
 * the project (the framework has no Vite of its own, by design).
 */
import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type CommandContextLike, commands } from '../../src/commands.ts'
import { LoggerToken } from '../../src/core/tokens.ts'
import { Application } from '../../src/foundation/application.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { UI_FALLTHROUGH_HEADER } from '../../src/http/ui-paths.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { requestUrlHost } from '../../src/runtime/serve.ts'
import {
  configuredHost,
  isApplicationProject,
  type StartedApplication,
  startApplication,
  startProject,
} from '../../src/runtime/server.ts'
import { MemoryLogger } from '../app/helpers.ts'
import { APP_KEY, appFolder, cleanupFolders, sourceUrl, writeFiles } from '../commands/helpers.ts'

let started: StartedApplication | undefined
const blockers: Server[] = []
afterEach(async () => {
  await started?.stop()
  started = undefined
  for (const blocker of blockers.splice(0))
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  cleanupFolders()
})

const html = { accept: 'text/html' }

const config = {
  app: defineConfig((env) => ({
    name: 'Runtime Test',
    env: env.string('APP_ENV', 'production'),
    debug: false,
    url: env.string('APP_URL', 'http://localhost'),
    key: env.string('APP_KEY'),
  })),
}

/** An app on `root`: a page at `/about`, an API route, and the health route. */
function buildApp(root: string, env: Record<string, string> = {}): Application {
  const app = Application.configure({
    basePath: root,
    env: { APP_ENV: 'testing', APP_KEY, APP_URL: 'http://localhost', ...env },
  })
    .withConfig(config)
    .withRouting({
      web: defineRoutes([Route.get('/about', (ctx) => ctx.json({ page: 'about' }))]),
      api: defineRoutes([Route.get('/hello', (ctx) => ctx.json({ message: 'hi' }))]),
      health: '/up',
    })
    .create()
  app.container.value(LoggerToken, new MemoryLogger())
  return app
}

/** The built UI `node strut build` writes (Vite's layout: `index.html` + hashed `assets/`). */
const BUILT_UI = {
  'dist/web/index.html':
    '<!doctype html><title>Northwind</title><script type="module" src="/assets/index-1a2b3c.js"></script>',
  'dist/web/assets/index-1a2b3c.js': 'console.log("ui")\n',
  'dist/web/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
}

/** A stand-in `vite`: answers every request with a page naming the path; `/missing*` → `next()`. */
const FAKE_VITE = `
const state = (globalThis.__svAppFakeVite ??= { configs: [], closed: 0 })
export async function loadConfigFromFile() {
  return { path: 'vite.config.ts', config: { root: 'resources/ui' }, dependencies: [] }
}
export async function createServer(config) {
  state.configs.push(config)
  return {
    middlewares(req, res, next) {
      if (req.url.startsWith('/missing')) return next()
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>vite ' + req.method + ' ' + req.url + '</title>')
    },
    async close() { state.closed += 1 },
  }
}
`
const FAKE_VITE_FILES = {
  'vite.config.ts': 'export default {}\n',
  'node_modules/vite/package.json': JSON.stringify({
    name: 'vite',
    version: '0.0.0-fake',
    type: 'module',
    exports: { '.': { import: './index.js' }, './package.json': './package.json' },
    bin: { vite: 'bin/vite.js' },
  }),
  'node_modules/vite/index.js': FAKE_VITE,
}
const fakeVite = (): { configs: Record<string, unknown>[]; closed: number } =>
  (
    globalThis as unknown as {
      __svAppFakeVite: { configs: Record<string, unknown>[]; closed: number }
    }
  ).__svAppFakeVite

describe('FW-3: node strut start serves the built UI next to the API (one port)', () => {
  it('serves files, the SPA fallback and the API, with the right caching and headers', async () => {
    const root = appFolder(BUILT_UI)
    started = await startApplication({ root, port: 0, load: async () => buildApp(root) })
    const base = started.server.url

    const asset = await fetch(`${base}/assets/index-1a2b3c.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await asset.text()).toContain('console.log')

    // A client-side route survives a reload: index.html, never cached, with a page CSP.
    const page = await fetch(`${base}/customers/7`, { headers: html })
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(page.headers.get('x-frame-options') ?? 'deny').toMatch(/deny/i)
    expect(await page.text()).toContain('<title>Northwind</title>')
    expect((await fetch(`${base}/`, { headers: html })).status).toBe(200)

    // Routes win, the API keeps its problem+json 404s, writes never reach the UI.
    expect(await (await fetch(`${base}/about`, { headers: html })).json()).toEqual({
      page: 'about',
    })
    expect(await (await fetch(`${base}/api/hello`)).json()).toEqual({ message: 'hi' })
    const missingApi = await fetch(`${base}/api/nope`, { headers: html })
    expect(missingApi.status).toBe(404)
    expect(missingApi.headers.get('content-type')).toContain('problem+json')
    const post = await fetch(`${base}/customers`, { method: 'POST' })
    expect(post.headers.get('content-type')).toContain('problem+json')
    expect((await fetch(`${base}/up`)).status).toBe(200)

    // A missing asset is a 404 (no index.html for files), and nothing escapes dist/web.
    expect((await fetch(`${base}/assets/gone.js`)).status).toBe(404)
    expect((await fetch(`${base}/..%2fbootstrap%2fapp.ts`, { headers: html })).status).toBe(404)
    expect((await fetch(`${base}/.env`)).status).toBe(404)
    const head = await fetch(`${base}/favicon.svg`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('serves the API only when there is no build, or with web: false', async () => {
    const root = appFolder()
    started = await startApplication({ root, port: 0, load: async () => buildApp(root) })
    expect((await fetch(`${started.server.url}/customers`, { headers: html })).status).toBe(404)
    await started.stop()

    const built = appFolder(BUILT_UI)
    started = await startApplication({
      root: built,
      port: 0,
      web: false,
      load: async () => buildApp(built),
    })
    expect((await fetch(`${started.server.url}/assets/index-1a2b3c.js`)).status).toBe(404)
  })

  it('refuses serveUi() once the app is booting', async () => {
    const app = buildApp(appFolder())
    await app.boot()
    expect(() => app.serveUi({ files: 'dist/web' })).toThrow(/serveUi\(\) was called after/)
    await app.shutdown()
  })
})

describe("FW-1: node strut dev mounts the project's Vite on the app's port", () => {
  it('hands UI requests to Vite, keeps the API, and closes Vite on stop', async () => {
    const root = appFolder({ ...FAKE_VITE_FILES, ...BUILT_UI })
    const before = fakeVite()?.closed ?? 0
    started = await startApplication({
      root,
      port: 0,
      vite: true,
      load: async () => buildApp(root),
    })
    const base = started.server.url
    const config = fakeVite().configs.at(-1) as {
      root: string
      appType: string
      server: { middlewareMode: boolean }
    }
    expect(config.appType).toBe('spa')
    expect(config.server.middlewareMode).toBe(true)
    expect(config.root.replace(/\\/g, '/')).toBe(`${root.replace(/\\/g, '/')}/resources/ui`)

    const page = await fetch(`${base}/customers/7`, { headers: html })
    expect(await page.text()).toContain('vite GET /customers/7')
    // A stale dist/web never shadows Vite in development.
    expect(await (await fetch(`${base}/assets/index-1a2b3c.js`)).text()).toContain(
      'vite GET /assets/index-1a2b3c.js',
    )
    expect(await (await fetch(`${base}/api/hello`)).json()).toEqual({ message: 'hi' })
    const missingApi = await fetch(`${base}/api/nope`, { headers: html })
    expect(missingApi.headers.get('content-type')).toContain('problem+json')
    // Vite passing on yields the app's own 404, and the marker never leaks.
    const passed = await fetch(`${base}/missing.js`)
    expect(passed.status).toBe(404)
    expect(passed.headers.has(UI_FALLTHROUGH_HEADER)).toBe(false)

    await started.stop()
    started = undefined
    expect(fakeVite().closed).toBe(before + 1)
  })

  it('serves the API alone (and says why) without a Vite config', async () => {
    const root = appFolder(BUILT_UI)
    const app = buildApp(root)
    const logger = new MemoryLogger()
    app.container.value(LoggerToken, logger)
    started = await startApplication({ root, port: 0, vite: true, load: async () => app })
    expect((await fetch(`${started.server.url}/assets/index-1a2b3c.js`)).status).toBe(404)
    expect(logger.entries.map((entry) => entry.message)).toContain(
      'No vite.config.* in the project: serving the API only',
    )
  })

  it('startProject routes an application (bootstrap/app.ts, no strutvane.config.ts) here', () => {
    const app = appFolder()
    expect(isApplicationProject(app)).toBe(true)
    writeFiles(app, { 'strutvane.config.ts': 'export default {}\n' })
    expect(isApplicationProject(app)).toBe(false)
    expect(isApplicationProject(appFolder({}))).toBe(true)
    expect(typeof startProject).toBe('function')
  })
})

/** A real `bootstrap/app.ts` (imports the framework source), with its port and host from `.env`. */
function realApp(env: Record<string, string>): string {
  const root = appFolder()
  writeFiles(root, {
    'bootstrap/app.ts': `import { dirname } from 'node:path'
import { Application } from '${sourceUrl('foundation/application.ts')}'
import { defineConfig } from '${sourceUrl('foundation/config.ts')}'
import { defineRoutes, Route } from '${sourceUrl('routing/route.ts')}'

const app = defineConfig((env) => ({
  name: 'Real',
  env: env.string('APP_ENV', 'production'),
  debug: false,
  url: env.string('APP_URL', 'http://localhost'),
  key: env.string('APP_KEY'),
  port: env.integer('APP_PORT', 3000),
}))

export default Application.configure({ basePath: dirname(import.meta.dirname) })
  .withConfig({ app })
  .withRouting({ web: defineRoutes([Route.get('/', (ctx) => ctx.json({ hello: true }))]) })
  .create()
`,
    '.env': Object.entries({ APP_ENV: 'local', APP_KEY, ...env })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  })
  return root
}

/** The command context the CLI hands contributed commands. */
function context(root: string, flags: Record<string, string | boolean> = {}) {
  const lines: string[] = []
  const ctx: CommandContextLike = {
    flags,
    requireProject: () => ({ root }),
    appEnv: 'local',
    out: {
      line: (text = '') => void lines.push(text),
      success: (text) => void lines.push(text),
      info: (text) => void lines.push(text),
      warn: (text) => void lines.push(text),
      table: () => undefined,
    },
  }
  return { ctx, lines }
}

const command = (name: string) => {
  const found = commands.find((c) => c.name === name)
  if (found === undefined) throw new Error(`no ${name} command`)
  return found
}

/** Hold a port, so `node strut dev` must report it before starting its child. */
async function takenPort(): Promise<number> {
  const blocker = createServer()
  blockers.push(blocker)
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
  const address = blocker.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe('FW-1 / FW-2: dev and build work on an application (no strutvane.config.ts)', () => {
  it('build boots the app (every route checked) instead of asking for strutvane.config.ts', async () => {
    const root = realApp({})
    const { ctx, lines } = context(root)
    await expect(command('build').run(ctx)).resolves.toBeUndefined()
    expect(lines.join('\n')).toMatch(/App boots: \d+ route\(s\)/)
    expect(lines.join('\n')).not.toContain('strutvane.config.ts')
  })

  it('build fails with the boot error when the app cannot boot', async () => {
    const root = realApp({ APP_KEY: 'weak' })
    const { ctx } = context(root)
    const failure = await command('build')
      .run(ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(isBootError(failure)).toBe(true)
  })

  it("dev reads the app's own port (APP_PORT) and reports it taken before starting", async () => {
    const port = await takenPort()
    const root = realApp({ APP_PORT: String(port) })
    const { ctx } = context(root)
    await expect(command('dev').run(ctx)).rejects.toThrow(new RegExp(`Port ${port} is already`))
  })
})

describe('DOCK-2: listening on every interface inside a container', () => {
  it('request URLs never name a wildcard bind address', () => {
    expect(requestUrlHost('0.0.0.0', '0.0.0.0')).toBe('127.0.0.1')
    expect(requestUrlHost('::', '[::]')).toBe('[::1]')
    expect(requestUrlHost('0:0:0:0:0:0:0:0', '[0:0:0:0:0:0:0:0]')).toBe('[::1]')
    expect(requestUrlHost('127.0.0.1', '127.0.0.1')).toBe('127.0.0.1')
    expect(requestUrlHost('10.0.0.5', '10.0.0.5')).toBe('10.0.0.5')
  })

  it('bound to 0.0.0.0 (APP_HOST), the APP_URL host is served and other hosts still refused', async () => {
    const root = appFolder()
    const app = buildApp(root, { APP_URL: 'http://northwind.test:3002', APP_HOST: '0.0.0.0' })
    started = await startApplication({ root, port: 0, load: async () => app })
    expect(started.server.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/)
    const port = started.server.port
    const get = (host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/up', headers: { host } }, (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += String(chunk)
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        req.on('error', reject)
        req.end()
      })
    // The Host the browser on the Docker host sends, the APP_URL host, and a hostile one.
    expect((await get('localhost:3002')).status).toBe(200)
    expect((await get('northwind.test:3002')).status).toBe(200)
    const refused = await get('attacker.example')
    expect(refused.status).toBe(400)
    expect(refused.body).toContain('untrusted_host')
  })

  it('reads APP_HOST and refuses a value that is not an address', async () => {
    const ok = buildApp(appFolder(), { APP_HOST: ' 0.0.0.0 ' })
    await ok.boot()
    expect(configuredHost(ok)).toBe('0.0.0.0')
    await ok.shutdown()
    const unset = buildApp(appFolder())
    await unset.boot()
    expect(configuredHost(unset)).toBeUndefined()
    await unset.shutdown()
    const bad = buildApp(appFolder(), { APP_HOST: 'http://0.0.0.0/' })
    await bad.boot()
    expect(() => configuredHost(bad)).toThrow(/not an address to listen on/)
    await bad.shutdown()
  })
})
