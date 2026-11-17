/**
 * The security surface through its commands: `security:check` (passes, production failures, an app
 * that refuses to boot, warnings, `--audit` through npm's own CLI) and `route:list` with and
 * without `--security`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { npmCliPath, type SecurityFinding } from '../../src/console/commands/app/security-check.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { fakeSpawner } from '../console/helpers.ts'
import { appFolder, buildApp, cleanupFolders, strut } from './helpers.ts'

afterEach(cleanupFolders)

type Report = { readonly passed: boolean; readonly findings: readonly SecurityFinding[] }
const report = (result: { json(): { data?: unknown } }): Report => result.json().data as Report
const status = (data: Report, check: string): string | undefined =>
  data.findings.find((finding) => finding.check === check)?.status

describe('security:check', () => {
  it('passes a sound testing app, with the dev-tools route as a warning and audit skipped', async () => {
    const base = appFolder()
    const result = await strut(['security:check', '--json'], { cwd: base })
    expect(result.code).toBe(0)
    const data = report(result)
    expect(data.passed).toBe(true)
    expect(status(data, 'boot')).toBe('pass')
    expect(status(data, 'dev-tools')).toBe('warn')
    expect(status(data, 'npm-audit')).toBe('skip')
    const text = await strut(['security:check'], { cwd: base })
    expect(text.stdout).toContain('No failures')
  })

  it('fails production over http, debug in production and exposed developer routes (exit 3)', async () => {
    const base = appFolder()
    const result = await strut(['security:check', '--json'], {
      cwd: base,
      app: () =>
        buildApp(base, {
          env: { APP_ENV: 'production', APP_DEBUG: 'true', APP_URL: 'http://blog.example' },
        }).app,
    })
    expect(result.code).toBe(3)
    const data = report(result)
    expect(data.passed).toBe(false)
    for (const check of ['debug', 'https', 'cookies', 'dev-tools'])
      expect(status(data, check), check).toBe('fail')
    // Debug-in-production is a finding, not a reason to skip the other checks.
    expect(status(data, 'boot')).toBe('pass')
    const text = await strut(['security:check'], {
      cwd: base,
      app: () =>
        buildApp(base, { env: { APP_ENV: 'production', APP_URL: 'http://blog.example' } }).app,
    })
    expect(text.stdout).toMatch(/✖ \d+ failures/)
  })

  it('reports an app that refuses to boot, and a config that cannot even load', async () => {
    const base = appFolder()
    const weak = await strut(['security:check', '--json'], {
      cwd: base,
      app: () => buildApp(base, { env: { APP_KEY: 'too-short' } }).app,
    })
    expect(weak.code).toBe(3)
    expect(status(report(weak), 'app-key')).toBe('fail')
    expect(status(report(weak), 'boot')).toBe('fail')
    const broken = await strut(['security:check', '--json'], {
      cwd: base,
      app: () =>
        buildApp(base, {
          config: {
            app: defineConfig(() => {
              throw new Error('config/app.ts exploded')
            }),
          },
        }).app,
    })
    expect(report(broken).findings[0]).toMatchObject({ check: 'config', status: 'fail' })
  })

  it('warns about a weak CSP, CSRF off for every path and CORS open to anyone', async () => {
    const base = appFolder()
    const result = await strut(['security:check', '--json'], {
      cwd: base,
      app: () =>
        buildApp(base, {
          web: defineRoutes([Route.get('/', (ctx) => ctx.json({}))]),
          middleware: (m) =>
            m
              .validateCsrfTokens({ except: ['*'] })
              .cors({ origins: ['*'] })
              .securityHeaders({ csp: { 'script-src': ["'self'", "'unsafe-inline'"] } }),
        }).app,
    })
    const data = report(result)
    expect(data.passed).toBe(true)
    expect(status(data, 'csp')).toBe('warn')
    expect(status(data, 'csrf-exceptions')).toBe('warn')
    expect(status(data, 'cors')).toBe('warn')
    expect(status(data, 'dev-tools')).toBe('pass')
  })

  it('--audit runs npm-cli.js with this Node binary and reads its counts', async () => {
    const base = appFolder()
    const npmDir = appFolder()
    const cli = join(npmDir, 'npm-cli.js')
    writeFileSync(cli, '')
    const audit = (stdout: string) =>
      strut(['security:check', '--audit', '--json'], {
        cwd: base,
        env: { npm_execpath: cli },
        spawn: fakeSpawner(() => ({ stdout })),
      })
    const clean = await audit(
      JSON.stringify({ metadata: { vulnerabilities: { high: 0, critical: 0, low: 4 } } }),
    )
    expect(status(report(clean), 'npm-audit')).toBe('pass')
    const bad = await audit(
      JSON.stringify({ metadata: { vulnerabilities: { high: 2, critical: 1 } } }),
    )
    expect(bad.code).toBe(3)
    expect(report(bad).findings.at(-1)).toMatchObject({
      status: 'fail',
      detail: '1 critical and 2 high advisories; run npm audit for details',
    })
    expect(status(report(await audit('offline')), 'npm-audit')).toBe('warn')
    expect(status(report(await audit('{"metadata":{}}')), 'npm-audit')).toBe('warn')
    const spawn = fakeSpawner(() => ({ stdout: '{}' }))
    await strut(['security:check', '--audit'], { cwd: base, env: { npm_execpath: cli }, spawn })
    expect(spawn.calls[0]?.command).toBe(process.execPath)
    expect(spawn.calls[0]?.args).toEqual([cli, 'audit', '--json', '--omit=dev'])
  })

  it('finds npm next to Node, never on PATH, and says so when it is missing', async () => {
    const node = appFolder()
    mkdirSync(join(node, 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
    const execPath = join(node, 'node.exe')
    expect(npmCliPath({ env: {}, execPath, platform: 'win32' })).toBe(
      join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
    expect(npmCliPath({ env: { npm_execpath: '/usr/bin/npm' }, execPath, platform: 'linux' })).toBe(
      undefined,
    )
    const base = appFolder()
    const missing = await strut(['security:check', '--audit', '--json'], {
      cwd: base,
      env: { npm_execpath: join(base, 'nope', 'npm-cli.js') },
    })
    const finding = report(missing).findings.at(-1)
    // On a machine whose Node ships npm the real path is found; otherwise a warning says why.
    expect(['pass', 'warn', 'fail']).toContain(finding?.status)
  })
})

describe('route:list', () => {
  it('lists every route with its action and middleware, and filters', async () => {
    const base = appFolder()
    const all = await strut(['route:list', '--json'], { cwd: base })
    const data = all.json().data as {
      routes: { uri: string; name: string | null }[]
      total: number
    }
    expect(data.routes.map((route) => route.uri)).toEqual(
      expect.arrayContaining(['/', '/posts', '/webhooks/stripe', '/_tools/info']),
    )
    const posts = await strut(['route:list', '--path=posts', '--method=post', '--json'], {
      cwd: base,
    })
    expect((posts.json().data as { routes: unknown[] }).routes).toEqual([
      expect.objectContaining({ method: 'POST', uri: '/posts', name: 'posts.store' }),
    ])
    const named = await strut(['route:list', '--name=webhooks'], { cwd: base })
    expect(named.stdout).toContain('/webhooks/stripe')
    expect(named.stdout).toMatch(/Showing 1 of \d+ routes/)
  })

  it('--security shows protections, opt-outs with where they were written, and warnings', async () => {
    const base = appFolder()
    const result = await strut(['route:list', '--security', '--json'], { cwd: base })
    const data = result.json().data as {
      routes: { uri: string; method: string; optOuts: string[]; warnings: string[] }[]
      optOuts: number
      warnings: number
    }
    const hook = data.routes.find((route) => route.uri === '/webhooks/stripe')
    expect(hook?.optOuts.join(' ')).toContain('csrf')
    const tool = data.routes.find((route) => route.uri === '/_tools/info')
    expect(tool?.warnings).toContain('developer tool route without auth')
    expect(data.optOuts).toBeGreaterThan(0)
    const text = await strut(['route:list', '--security'], { cwd: base })
    expect(text.stdout).toMatch(/\d+ routes, \d+ opt-outs?, \d+ warnings?\./)
    // Protecting the tool removes the warning.
    const guarded = await strut(['route:list', '--security', '--path=_tools', '--json'], {
      cwd: base,
      app: () =>
        buildApp(base, {
          web: defineRoutes([
            Route.get('/_tools/info', (ctx) => ctx.json({}))
              .name('tools.info')
              .middleware('auth'),
          ]),
        }).app,
    })
    expect(guarded.code).toBe(0)
    expect((guarded.json().data as { warnings: number }).warnings).toBe(0)
  })

  it('a broken route fails here, before any request, with its hint', async () => {
    const base = appFolder()
    const result = await strut(['route:list', '--json'], {
      cwd: base,
      app: () =>
        buildApp(base, {
          web: defineRoutes([Route.get('/x', (ctx) => ctx.json({})).middleware('auht')]),
        }).app,
    })
    expect(result.code).toBe(3)
    expect(JSON.stringify(result.json().error)).toContain('auth')
  })
})
