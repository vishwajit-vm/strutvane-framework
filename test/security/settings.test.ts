/**
 * The settings collector (one `BootError` listing every bad setting), the boot guards (debug in
 * production, weak keys never echoed; CONSISTENCY #19) and the security catalog.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createErrorRegistry } from '../../src/core/errors/registry.ts'
import { BootError } from '../../src/foundation/boot-error.ts'
import { csrfToken } from '../../src/http/csrf.ts'
import { isTrustedHost } from '../../src/http/trusted-hosts.ts'
import { checkBootGuards } from '../../src/security/boot-guards.ts'
import { SECURITY_ERRORS, SECURITY_MESSAGES_EN } from '../../src/security/catalog.ts'
import { hasControlCharacter } from '../../src/security/control-characters.ts'
import { Keyring } from '../../src/security/keyring.ts'
import { SecuritySettings, SecurityToken } from '../../src/security/settings.ts'

const KEY = randomBytes(32).toString('base64url')
const LOCAL = { appUrl: 'http://localhost:3000', environment: 'local' }

function bootError(run: () => unknown): BootError {
  try {
    run()
  } catch (error) {
    if (error instanceof BootError) return error
    throw error
  }
  throw new Error('Expected a BootError')
}

describe('SecuritySettings', () => {
  it('resolves safe defaults: CSRF on, no proxies, loopback + APP_URL hosts, CORS off', () => {
    const security = new SecuritySettings().resolve({
      appUrl: 'https://blog.example.com',
      environment: 'production',
      keyring: Keyring.from(KEY),
    })
    expect(security.csrf.origins).toEqual(['https://blog.example.com'])
    expect(security.csrf.cookie.name).toBe('__Host-strutvane_session')
    expect(security.proxies).toEqual({ hops: 0, ranges: [], headers: ['for', 'proto', 'host'] })
    expect(isTrustedHost('blog.example.com', security.hosts)).toBe(true)
    expect(isTrustedHost('localhost', security.hosts)).toBe(true)
    expect(isTrustedHost('evilblog.example.com', security.hosts)).toBe(false)
    expect(security.cors.enabled).toBe(false)
    expect(security.headers.hsts).toBe('max-age=31536000; includeSubDomains')
    expect(security.limits).toEqual({ maxBytes: 1_048_576, maxDepth: 32, maxKeys: 1000 })
    expect(SecurityToken.name).toBe('strutvane.security')
  })

  it('merges list settings across calls (a package and the app can both add exceptions)', () => {
    const keyring = Keyring.from(KEY)
    const security = new SecuritySettings()
      .csrf({ except: ['/api/webhooks/*'] })
      .csrf({ except: ['oauth/callback'], origins: ['https://admin.example.com'] })
      .trustProxies({ at: ['10.0.0.0/8'], headers: ['for', 'proto'] })
      .trustProxies(['192.168.1.1'])
      .trustHosts({ at: ['example.com'], subdomains: true })
      .trustHosts({ at: ['*.cdn.example.net'], subdomains: true })
      .cors({ origins: ['https://app.example.com'], credentials: true })
      .headers({ csp: { 'img-src': ['https://images.example.com'] } })
      .headers({ cspReportOnly: true })
      .limits({ maxDepth: 64 })
      .limits({ maxKeys: 5000 })
      .resolve({ ...LOCAL, keyring })
    expect(security.csrf.except).toEqual(['api/webhooks/*', 'oauth/callback'])
    expect(security.csrf.origins).toEqual(['http://localhost:3000', 'https://admin.example.com'])
    // The CSRF key is the keyring's csrf subkey (spike open question 2).
    expect(security.csrf.key.equals(keyring.derive('csrf'))).toBe(true)
    expect(security.proxies.ranges).toHaveLength(2)
    expect(security.proxies.headers).toEqual(['for', 'proto'])
    expect(isTrustedHost('api.example.com', security.hosts)).toBe(true)
    expect(isTrustedHost('example.com', security.hosts)).toBe(true)
    expect(isTrustedHost('a.cdn.example.net', security.hosts)).toBe(true)
    expect(security.cors.credentials).toBe(true)
    expect(security.headers.cspReportOnly).toBe(true)
    expect(security.headers.csp?.get('img-src')).toContain('https://images.example.com')
    expect(security.limits).toEqual({ maxBytes: 1_048_576, maxDepth: 64, maxKeys: 5000 })
    expect(new SecuritySettings().trustProxies(2).resolve(LOCAL).proxies.hops).toBe(2)
  })

  it('throws ONE BootError listing every bad setting', () => {
    const error = bootError(() =>
      new SecuritySettings()
        .csrf({ except: [' '], origins: ['null', '*'] })
        .trustProxies({ at: ['*', '10.0.0.0/33'] })
        .trustHosts({ at: ['*'] })
        .cors({ origins: ['*'], credentials: true })
        .headers({ referrerPolicy: 'unsafe-url', csp: { 'script-src': ["'self'; script-src *"] } })
        .limits({ maxBytes: 0 })
        .resolve(LOCAL),
    )
    expect(error.code).toBe('insecure_configuration')
    expect(error.message).toContain(
      "The app can't start: 10 security settings are unsafe or invalid.",
    )
    for (const fragment of [
      'csrf.except',
      'csrf.origins: "null"',
      'csrf.origins: "*"',
      'trustProxy: "*"',
      'trustProxy: "10.0.0.0/33"',
      'trustedHosts: "*"',
      'credentials: true',
      'referrerPolicy',
      'would inject another directive',
      'limits.maxBytes',
    ])
      expect(error.message).toContain(fragment)
    expect(error.hint).toContain('bootstrap/app.ts')
  })

  it('refuses mixing a hop count with a proxy list, and a missing or bad APP_URL', () => {
    expect(
      bootError(() =>
        new SecuritySettings().trustProxies(1).trustProxies(['10.0.0.1']).resolve(LOCAL),
      ).message,
    ).toContain('1 security setting is unsafe')
    expect(
      bootError(() => new SecuritySettings().resolve({ appUrl: '', environment: 'local' })).message,
    ).toContain('APP_URL is required')
    expect(
      bootError(() => new SecuritySettings().resolve({ appUrl: 'ftp://x', environment: 'local' }))
        .message,
    ).toContain('must use http or https')
  })

  it('works without a keyring (per-process key) and rethrows real bugs', () => {
    const a = new SecuritySettings().resolve(LOCAL)
    const b = new SecuritySettings().resolve(LOCAL)
    expect(a.csrf.key.equals(b.csrf.key)).toBe(false)
    const settings = new SecuritySettings()
    // A getter that throws a non-setting error must not be swallowed as a "problem".
    const broken = Object.defineProperty({ ...LOCAL }, 'environment', {
      get: () => {
        throw new RangeError('boom')
      },
    })
    expect(() => settings.resolve(broken)).toThrow(RangeError)
  })

  it('CSRF tokens made before key:rotate stay valid', () => {
    const before = Keyring.from(KEY)
    const after = Keyring.from(randomBytes(32).toString('base64url'), KEY)
    const security = new SecuritySettings().resolve({ ...LOCAL, keyring: after })
    const old = csrfToken(before.derive('csrf'), 'session-1')
    expect(security.csrf.keys.some((key) => csrfToken(key, 'session-1') === old)).toBe(true)
    expect(csrfToken(security.csrf.key, 'session-1')).not.toBe(old)
  })
})

describe('boot guards', () => {
  const base = { environment: 'production', debug: false, appKey: KEY }

  it('refuses APP_DEBUG=true with APP_ENV=production unless forced (with a warning)', () => {
    const refused = bootError(() => checkBootGuards({ ...base, debug: true }))
    expect(refused.code).toBe('debug_in_production')
    expect(refused.message).toBe(
      'The app refuses to start: APP_DEBUG=true with APP_ENV=production.',
    )
    expect(refused.hint).toContain('--force-debug')
    const forced = checkBootGuards({ ...base, debug: true, forceDebug: true })
    expect(forced.warnings).toHaveLength(1)
    expect(forced.warnings[0]).toMatch(/^Started with --force-debug/)
    expect(checkBootGuards(base).warnings).toEqual([])
    expect(checkBootGuards({ ...base, environment: 'local', debug: true }).warnings).toEqual([])
    expect(checkBootGuards(base).keyring.current.material.toString()).toBe(KEY)
  })

  it.each([
    ['too short', 'short-key', 'APP_KEY is too short: 9 bytes, at least 32 are needed.'],
    [
      'short base64',
      `base64:${randomBytes(16).toString('base64')}`,
      'APP_KEY is too short: 16 bytes, at least 32 are needed.',
    ],
    [
      'broken base64',
      'base64:%%%not-base64%%%',
      'APP_KEY starts with "base64:" but the rest is not valid base64.',
    ],
    ['missing', undefined, 'APP_KEY is missing.'],
  ])('refuses a key that is %s, without printing it', (_label, key, message) => {
    const error = bootError(() => checkBootGuards({ ...base, appKey: key }))
    expect(error.code).toBe('invalid_app_key')
    expect(error.message).toBe(message)
    if (key !== undefined) expect(`${error.message} ${error.hint}`).not.toContain(key)
    expect(error.hint).toContain('node strut key:generate')
  })

  it('refuses a weak previous key, naming its position', () => {
    const error = bootError(() =>
      checkBootGuards({
        ...base,
        previousKeys: `base64:${randomBytes(32).toString('base64')},tiny`,
      }),
    )
    expect(error.message).toBe(
      'APP_PREVIOUS_KEYS[1] is too short: 4 bytes, at least 32 are needed.',
    )
  })
})

describe('the security catalog', () => {
  it('has a title and a detail for every code, lowercase snake_case, registrable', () => {
    const registry = createErrorRegistry({ builtin: false })
    for (const definition of SECURITY_ERRORS) {
      expect(definition.code).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(SECURITY_MESSAGES_EN[`errors.${definition.code}.title`]).toBe(definition.title)
      expect(SECURITY_MESSAGES_EN[`errors.${definition.code}.detail`]).toBeTypeOf('string')
      expect(definition.owner).toBe('@strutvane/framework')
      registry.register(definition)
    }
    expect(registry.get('invalid_signature')?.status).toBe(403)
    expect(registry.get('signature_expired')?.status).toBe(403)
    expect(registry.get('json_too_deep')?.status).toBe(413)
    expect(Object.keys(SECURITY_MESSAGES_EN)).toHaveLength(SECURITY_ERRORS.length * 2)
  })

  it('control characters are found wherever they are', () => {
    expect(hasControlCharacter('a\r\nb')).toBe(true)
    expect(hasControlCharacter('\u007f')).toBe(true)
    expect(hasControlCharacter('\t')).toBe(true)
    expect(hasControlCharacter('camera=() é')).toBe(false)
  })
})
