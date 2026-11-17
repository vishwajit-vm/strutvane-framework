/**
 * Type-level tests for the security kit's public helpers (ported from spike 12's
 * `security-types.test.ts`, the parts this kit owns). Every `@ts-expect-error` must really be an
 * error, so misuse fails to compile.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { ForwardedClient, TrustProxy } from '../../src/http/proxy.ts'
import { forwardedClient, resolveTrustProxy } from '../../src/http/proxy.ts'
import type { BootGuardResult } from '../../src/security/boot-guards.ts'
import { checkBootGuards } from '../../src/security/boot-guards.ts'
import { decrypt, type Encrypter, encrypt } from '../../src/security/encrypter.ts'
import { HttpClient, type HttpClientErrorCode, type HttpResponse } from '../../src/security/http.ts'
import { type SafeResponse, safeFetch } from '../../src/security/http-client.ts'
import { Keyring } from '../../src/security/keyring.ts'
import { Redirector } from '../../src/security/redirect.ts'
import { SecuritySettings } from '../../src/security/settings.ts'
import { type SignatureVerdict, UrlSigner } from '../../src/security/signer.ts'

/** Wraps code that must type-check but never run. */
function typeOnly(_check: () => void): void {}

describe('the signer', () => {
  it('verdicts are exactly the three outcomes, and options are typed', () => {
    expectTypeOf<SignatureVerdict>().toEqualTypeOf<
      'valid' | 'invalid_signature' | 'signature_expired'
    >()
    typeOnly(() => {
      const signer = new UrlSigner(Keyring.from(''))
      expectTypeOf(signer.sign('/x', { purpose: 'route:x' })).toEqualTypeOf<string>()
      expectTypeOf(signer.verify('/x', { purpose: 'route:x', now: Date.now() })).toEqualTypeOf<
        Promise<SignatureVerdict>
      >()
      expectTypeOf(
        signer.verifySync('/x', { purpose: 'route:x', now: new Date() }),
      ).toEqualTypeOf<SignatureVerdict>()
      signer.sign('/x', { purpose: 'route:x', expiresAt: new Date(), oneTime: true })
      // @ts-expect-error: a purpose is required
      signer.sign('/x', {})
      // @ts-expect-error: verification needs the current time
      void signer.verify('/x', { purpose: 'route:x' })
      // @ts-expect-error: the expiry is a Date or epoch ms, not a duration string
      signer.sign('/x', { purpose: 'route:x', expiresAt: '30m' })
    })
  })
})

describe('encryption', () => {
  it('decrypt() returns unknown, so callers must check what they got', () => {
    expectTypeOf(decrypt).returns.toEqualTypeOf<unknown>()
    expectTypeOf(encrypt).returns.toEqualTypeOf<string>()
    expectTypeOf<Encrypter['decryptString']>().returns.toEqualTypeOf<string>()
    typeOnly(() => {
      // @ts-expect-error: unknown can't be used as a string without a check
      decrypt('sv1.x.y').toUpperCase()
    })
  })
})

describe('the HTTP client', () => {
  it('responses, error codes and options are typed', () => {
    expectTypeOf(safeFetch).returns.toEqualTypeOf<Promise<SafeResponse>>()
    expectTypeOf<HttpResponse>().toEqualTypeOf<SafeResponse>()
    expectTypeOf<ReturnType<SafeResponse['json']>>().toEqualTypeOf<unknown>()
    expectTypeOf<HttpClientErrorCode>().toEqualTypeOf<
      | 'ssrf_blocked'
      | 'invalid_url'
      | 'invalid_header'
      | 'timeout'
      | 'response_too_large'
      | 'too_many_redirects'
      | 'dns_failed'
      | 'connection_failed'
      | 'stray_request'
    >()
    typeOnly(() => {
      const http = new HttpClient()
      void http.get('https://example.com', { page: 2, q: 'x', exact: true })
      void http
        .withHeaders({ a: 'b' })
        .timeout(1000)
        .allow(['10.0.0.0/8'])
        .post('https://example.com', { a: 1 })
      http.fake({ 'example.com/*': { status: 200, body: {} } }).preventStrayRequests()
      http.assertSent((request) => request.method === 'POST')
      void safeFetch('https://example.com', { allow: ['10.0.0.0/8'], timeoutMs: 1000 })
      // @ts-expect-error: allow takes CIDR ranges or host names
      void safeFetch('https://example.com', { allow: true })
      // @ts-expect-error: query values are strings, numbers or booleans
      void http.get('https://example.com', { nested: { a: 1 } })
      // @ts-expect-error: headers are strings
      http.withHeaders({ 'x-count': 1 })
      // @ts-expect-error: a predicate returns a boolean
      http.assertSent(() => 'yes')
    })
  })
})

describe('settings, proxies, guards and redirects', () => {
  it('options are typed', () => {
    expectTypeOf<TrustProxy>().toEqualTypeOf<boolean | number | readonly string[]>()
    expectTypeOf(forwardedClient).returns.toEqualTypeOf<ForwardedClient>()
    expectTypeOf<ForwardedClient['ip']>().toEqualTypeOf<string | undefined>()
    expectTypeOf(checkBootGuards).returns.toEqualTypeOf<BootGuardResult>()
    typeOnly(() => {
      const settings = new SecuritySettings()
      settings.cors({ origins: ['https://app.example.com'], credentials: true })
      settings.trustProxies({ at: ['10.0.0.0/8'], headers: ['for', 'proto'] })
      settings.trustProxies(1)
      settings.headers({ csp: { 'img-src': ['https://images.example.com'] }, hsts: false })
      settings.csrf({ except: ['api/webhooks/*'] })
      resolveTrustProxy(['10.0.0.0/8'])
      // @ts-expect-error: origins is required
      settings.cors({ credentials: true })
      // @ts-expect-error: forwarded headers are 'for' | 'proto' | 'host'
      settings.trustProxies({ at: [], headers: ['port'] })
      // @ts-expect-error: CSRF exceptions are a list of patterns, not one string
      settings.csrf({ except: 'webhooks/*' })
      // @ts-expect-error: no such header preset
      settings.headers({ preset: 'web' })
      const redirect = new Redirector('https://app.example.com')
      expectTypeOf(redirect.to('/x')).toEqualTypeOf<Response>()
      // @ts-expect-error: 200 is not a redirect status
      redirect.to('/x', 200)
    })
  })
})
