/**
 * Host allowlist attack tests (CONSISTENCY #20). The allowlist is on in every environment, so a
 * DNS-rebinding page (`Host: attacker.example` pointed at 127.0.0.1) cannot talk to the dev API,
 * and a forged `Host` cannot poison links in production. Unknown hosts get 400 `untrusted_host`
 * before any app code (request hooks, routes, the UI fallthrough) runs.
 */
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { HTTP_HOOKS } from '../../src/contracts/index.ts'
import { HooksToken } from '../../src/core/index.ts'
import type { HttpAppOptions } from '../../src/http/create-http-app.ts'
import {
  hostName,
  isTrustedHost,
  LOOPBACK_HOSTS,
  resolveTrustedHosts,
  UNTRUSTED_HOST_CODE,
} from '../../src/http/trusted-hosts.ts'
import { frameworkProvider } from '../../src/provider.ts'
import { bootProject } from '../../src/runtime/boot.ts'
import { serve } from '../../src/runtime/serve.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { Customer, Invoice } from '../helpers/models.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

async function boot(
  http: Omit<HttpAppOptions, 'resources' | 'registry' | 'database'> = {},
): Promise<TestApp> {
  t = await createTestApp({ resources: [Customer, Invoice], http })
  return t
}

const get = (app: TestApp, host: string, headers: Record<string, string> = {}) =>
  app.http.request('/health', { headers: { host, ...headers } })

describe('trusted hosts: unknown Host headers are refused in every environment', () => {
  it('DNS rebinding of the local dev API (Host: attacker) gets 400 untrusted_host', async () => {
    for (const env of ['local', 'testing', 'production']) {
      const app = await boot({ env })
      let reached = false
      app.app.make(HooksToken).on(
        HTTP_HOOKS.request,
        () => {
          reached = true
          return undefined
        },
        { name: 'test.reached' },
      )
      const res = await get(app, 'rebind.attacker.example:3000')
      expect(res.status, env).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe(UNTRUSTED_HOST_CODE)
      // Refused before any app code: no request hook ran.
      expect(reached).toBe(false)
      // Still a problem response with the security headers.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      await app.close()
      t = undefined
    }
  })

  it('loopback names and the APP_URL host are always allowed, with or without a port', async () => {
    const app = await boot({ publicUrl: 'https://app.example.com' })
    for (const host of [
      'localhost',
      'localhost:3000',
      '127.0.0.1:8080',
      '[::1]:3000',
      'APP.example.com',
      'app.example.com.',
    ]) {
      expect((await get(app, host)).status, host).toBe(200)
    }
    expect((await app.http.request('/health')).status).toBe(200)
  })

  it('look-alike hosts are refused: suffixes, prefixes, userinfo and garbage', async () => {
    const app = await boot({ publicUrl: 'https://app.example.com' })
    for (const host of [
      'app.example.com.evil.test',
      'evilapp.example.com',
      'example.com',
      'app.example.com@evil.test',
      'evil.test/app.example.com',
      'local host',
      '',
      '127.0.0.2',
      '[::2]',
      '0.0.0.0',
    ]) {
      expect((await get(app, host)).status, JSON.stringify(host)).toBe(400)
    }
  })

  it('configured hosts and *.domain patterns are trusted, never the bare domain', async () => {
    const app = await boot({ trustedHosts: ['api.internal', '*.tenants.example.com'] })
    expect((await get(app, 'api.internal')).status).toBe(200)
    expect((await get(app, 'acme.tenants.example.com')).status).toBe(200)
    expect((await get(app, 'a.b.tenants.example.com')).status).toBe(200)
    expect((await get(app, 'tenants.example.com')).status).toBe(400)
    expect((await get(app, 'eviltenants.example.com')).status).toBe(400)
  })

  it('X-Forwarded-Host is checked only from a trusted proxy, and then it must be allowed too', async () => {
    const direct = await boot()
    // Without trustProxy the header is ignored (it cannot change anything either).
    expect((await get(direct, 'localhost', { 'x-forwarded-host': 'evil.test' })).status).toBe(200)
    await direct.close()
    const proxied = await boot({ trustProxy: 1, publicUrl: 'https://app.example.com' })
    expect((await get(proxied, 'localhost', { 'x-forwarded-host': 'evil.test' })).status).toBe(400)
    expect(
      (await get(proxied, 'localhost', { 'x-forwarded-host': 'evil.test, app.example.com' }))
        .status,
    ).toBe(200)
  })

  it('every route is covered: the API, discovery documents and unknown paths', async () => {
    const app = await boot()
    for (const path of [
      '/api/v1/customers',
      '/.well-known/strutvane.json',
      '/openapi.json',
      '/nope',
    ]) {
      const res = await app.http.request(path, { headers: { host: 'evil.test' } })
      expect(res.status, path).toBe(400)
    }
    const write = await app.http.request('/api/v1/customers', {
      method: 'POST',
      headers: { host: 'evil.test', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(write.status).toBe(400)
  })

  it('a booted project reads config/app.ts trustedHosts', async () => {
    const booted = await bootProject({
      root: process.cwd(),
      config: {
        app: {
          env: 'local',
          publicUrl: 'https://app.example.com',
          trustedHosts: ['admin.example.com'],
        },
      },
      providers: [
        frameworkProvider({ database: { driver: 'sqlite', url: ':memory:' }, models: [] }),
      ],
      models: [],
      resources: [],
      routes: [],
    })
    try {
      const ask = (host: string) => booted.http.request('/health', { headers: { host } })
      expect((await ask('admin.example.com')).status).toBe(200)
      expect((await ask('app.example.com')).status).toBe(200)
      expect((await ask('other.example.com')).status).toBe(400)
    } finally {
      await booted.shutdown()
    }
  })
})

describe('trusted hosts over a real socket (the DNS-rebinding path)', () => {
  it('the dev server refuses a rebound host name and answers its own', async () => {
    const app = await boot({ env: 'local' })
    const server = await serve((request, bindings) => app.http.fetch(request, bindings), {
      port: 0,
    })
    try {
      const port = new URL(server.url).port
      // node:http, not fetch: fetch drops a caller-set Host header, a browser after a DNS
      // rebind does not.
      const ask = (host: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = httpRequest(
            { host: '127.0.0.1', port, path: '/health', headers: { host } },
            (res) => {
              let body = ''
              res.on('data', (d: Buffer) => {
                body += d.toString()
              })
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
            },
          )
          req.on('error', reject)
          req.end()
        })
      const rebound = await ask(`rebind.attacker.example:${port}`)
      expect(rebound.status).toBe(400)
      expect((JSON.parse(rebound.body) as { code: string }).code).toBe(UNTRUSTED_HOST_CODE)
      expect((await ask(`localhost:${port}`)).status).toBe(200)
    } finally {
      await server.close()
    }
  })
})

describe('trusted hosts: settings fail closed', () => {
  it('refuses "*", ports, schemes and malformed entries at boot', () => {
    for (const entry of ['*', 'example.com:443', 'https://example.com', '*.', 'a..b', '-a.com']) {
      expect(() => resolveTrustedHosts({ hosts: [entry] }), entry).toThrow(TypeError)
    }
    expect(resolveTrustedHosts({}).patterns).toEqual(LOOPBACK_HOSTS)
  })

  it('host names are parsed, lowercased and stripped of the port', () => {
    expect(hostName('API.Example.com:443')).toBe('api.example.com')
    expect(hostName('[::1]:3000')).toBe('[::1]')
    expect(hostName('a@b')).toBeUndefined()
    expect(isTrustedHost('x.example.com', { patterns: ['*.example.com'] })).toBe(true)
    expect(isTrustedHost('example.com', { patterns: ['*.example.com'] })).toBe(false)
  })
})
