/**
 * The one URL signer (CONSISTENCY #64, #65, #67), ported from spike 12's signed-URL tests and
 * extended with purposes and one-time links. Attack-style cases: tampering with the path, any
 * parameter, the expiry or the signature; duplicated parameters; cross-purpose replay; the
 * `//path` regression the spike's fuzzer found; replaying a one-time link, also concurrently.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { StrutvaneError } from '../../src/core/errors/errors.ts'
import { BootError } from '../../src/foundation/boot-error.ts'
import { Keyring } from '../../src/security/keyring.ts'
import {
  MemoryUsedSignatureStore,
  type SignatureVerdict,
  signatureError,
  UrlSigner,
  UrlSignerToken,
  UsedSignatureStoreToken,
} from '../../src/security/signer.ts'
import { signUrl, verifySignedUrl } from '../../src/storage/signing.ts'

const KEY_A = `base64:${randomBytes(32).toString('base64')}`
const KEY_B = `base64:${randomBytes(32).toString('base64')}`
const NOW = Date.parse('2026-11-15T10:00:00Z')
const PURPOSE = 'route:downloads.show'

const keyring = Keyring.from(KEY_A)
const signer = new UrlSigner(keyring)
const check = (url: string, purpose = PURPOSE, now = NOW): SignatureVerdict =>
  signer.verifySync(url, { purpose, now })

describe('signed and temporary signed URLs', () => {
  it('verifies untouched links and refuses every tampering', async () => {
    const url = signer.sign('/downloads/7?format=pdf', { purpose: PURPOSE })
    expect(url).toMatch(/^\/downloads\/7\?format=pdf&signature=[A-Za-z0-9_-]{43}$/)
    expect(check(url)).toBe('valid')
    expect(await signer.verify(url, { purpose: PURPOSE, now: new Date(NOW) })).toBe('valid')
    const tampered = [
      url.replace('/downloads/7', '/downloads/8'),
      url.replace('format=pdf', 'format=zip'),
      `${url}&extra=1`,
      url.replace(/signature=[^&]+/, `signature=${'A'.repeat(43)}`),
      url.replace(/&signature=[^&]+/, ''),
      `${url}&signature=${'B'.repeat(43)}`,
      url.replace(
        /signature=([^&]+)/,
        (_match, value: string) => `signature=${value.toLowerCase()}`,
      ),
      url.replace(/signature=([^&]+)/, (_match, value: string) => `signature=${value}A`),
      `${url}&expires=99999999999`,
      `${url}&expires=1&expires=2`,
      `${url}&once=${'a'.repeat(22)}`,
    ]
    for (const bad of tampered) expect(check(bad), bad).toBe('invalid_signature')
    // Parameter order doesn't matter (keys are sorted before signing).
    const reordered = signer.sign('/x?b=2&a=1', { purpose: PURPOSE }).replace('b=2&a=1', 'a=1&b=2')
    expect(check(reordered)).toBe('valid')
  })

  it('binds the purpose: a link for one feature is useless for another', () => {
    const url = signer.sign('/files/7', { purpose: 'auth:verify-email' })
    expect(check(url, 'auth:verify-email')).toBe('valid')
    expect(check(url, 'auth:reset-password')).toBe('invalid_signature')
    expect(check(url, '')).toBe('invalid_signature')
    expect(check(url, 'x\ny')).toBe('invalid_signature')
  })

  it('expires temporary links, and the expiry itself is signed', () => {
    const url = signer.sign('/reset', { purpose: PURPOSE, expiresAt: new Date(NOW + 60_000) })
    expect(url).toMatch(/^\/reset\?expires=\d+&signature=/)
    expect(check(url)).toBe('valid')
    expect(check(url, PURPOSE, NOW + 59_999)).toBe('valid')
    expect(check(url, PURPOSE, NOW + 60_000)).toBe('signature_expired')
    const extended = url.replace(/expires=\d+/, `expires=${Math.floor(NOW / 1000) + 999_999}`)
    expect(check(extended)).toBe('invalid_signature')
    expect(check(url.replace(/expires=\d+/, 'expires=1e99'))).toBe('invalid_signature')
    expect(check(url.replace(/expires=\d+/, 'expires=-1'))).toBe('invalid_signature')
  })

  it('signs absolute URLs without signing the host, and keeps fragments', () => {
    const url = signer.sign('https://app.example.com/files/7?a=1#top', { purpose: PURPOSE })
    expect(url.startsWith('https://app.example.com/files/7?a=1&signature=')).toBe(true)
    expect(url.endsWith('#top')).toBe(true)
    expect(check(url)).toBe('valid')
    expect(check(url.replace('app.example.com', 'mirror.example.com'))).toBe('valid')
    expect(check(new URL(url).pathname + new URL(url).search)).toBe('valid')
    expect(signer.verifySync(new URL(url), { purpose: PURPOSE, now: NOW })).toBe('valid')
  })

  it('regression (found by fuzzing): a path starting with // is a path, never a host', () => {
    const url = signer.sign('//cdn.example/x', { purpose: PURPOSE })
    expect(url.startsWith('//cdn.example/x?signature=')).toBe(true)
    expect(check(url)).toBe('valid')
    expect(check(url.replace('//cdn.example/x', '/x'))).toBe('invalid_signature')
    expect(check('//?signature=x')).toBe('invalid_signature')
  })

  it('accepts links signed with a previous key after rotation, never after the key is dropped', () => {
    const url = signer.sign('/x', { purpose: PURPOSE })
    const rotated = new UrlSigner(Keyring.from(KEY_B, KEY_A))
    expect(rotated.verifySync(url, { purpose: PURPOSE, now: NOW })).toBe('valid')
    expect(rotated.sign('/x', { purpose: PURPOSE })).not.toBe(url)
    expect(new UrlSigner(Keyring.from(KEY_B)).verifySync(url, { purpose: PURPOSE, now: NOW })).toBe(
      'invalid_signature',
    )
  })

  it('never throws on hostile input', () => {
    for (const bad of [
      '',
      'garbage',
      'javascript:alert(1)',
      'http://[::1',
      '/%',
      `/${'a'.repeat(9000)}?signature=${'A'.repeat(43)}`,
      '/x?signature=%ZZ',
      '/x?signature=',
    ])
      expect(check(bad), bad).toBe('invalid_signature')
  })

  it('refuses to sign malformed targets, signed targets, bad purposes and bad expiries', () => {
    const fails = (run: () => unknown, code: string): void => {
      try {
        run()
      } catch (error) {
        expect(error).toBeInstanceOf(BootError)
        expect((error as BootError).code).toBe(code)
        return
      }
      throw new Error(`expected ${code}`)
    }
    fails(() => signer.sign('relative/path', { purpose: PURPOSE }), 'invalid_signing_target')
    fails(() => signer.sign('http://[::1', { purpose: PURPOSE }), 'invalid_signing_target')
    for (const name of ['signature', 'expires', 'once'])
      fails(() => signer.sign(`/x?${name}=abc`, { purpose: PURPOSE }), 'already_signed')
    fails(() => signer.sign('/x', { purpose: '' }), 'invalid_signing_purpose')
    fails(() => signer.sign('/x', { purpose: 'a\r\nb' }), 'invalid_signing_purpose')
    fails(() => signer.sign('/x', { purpose: 'a'.repeat(201) }), 'invalid_signing_purpose')
    fails(
      () => signer.sign('/x', { purpose: PURPOSE, expiresAt: Number.NaN }),
      'invalid_link_expiry',
    )
    fails(
      () => signer.sign('/x', { purpose: PURPOSE, expiresAt: new Date(0) }),
      'invalid_link_expiry',
    )
    fails(
      () => signer.sign('/x', { purpose: PURPOSE, oneTime: true, expiresAt: NOW + 1000 }),
      'one_time_link_needs_store',
    )
    fails(
      () => signer.sign('/x', { purpose: PURPOSE, oneTime: true }),
      'one_time_link_needs_expiry',
    )
  })

  it('turns verdicts into 403 problems (CONSISTENCY #67)', () => {
    expect(signatureError('valid')).toBeUndefined()
    for (const verdict of ['invalid_signature', 'signature_expired'] as const) {
      const error = signatureError(verdict)
      expect(error).toBeInstanceOf(StrutvaneError)
      expect(error?.code).toBe(verdict)
      expect(error?.status).toBe(403)
    }
    expect(UrlSignerToken.name).toBe('strutvane.url-signer')
    expect(UsedSignatureStoreToken.name).toBe('strutvane.used-signatures')
  })
})

describe('one-time links', () => {
  const store = (): MemoryUsedSignatureStore => new MemoryUsedSignatureStore({ now: () => NOW })

  it('work once, then answer signature_expired; the sync check refuses them outright', async () => {
    const oneTime = new UrlSigner(keyring, { usedSignatures: store() })
    const url = oneTime.sign('/invite/7', {
      purpose: PURPOSE,
      expiresAt: NOW + 60_000,
      oneTime: true,
    })
    expect(url).toMatch(/once=[A-Za-z0-9_-]{22}/)
    expect(oneTime.verifySync(url, { purpose: PURPOSE, now: NOW })).toBe('invalid_signature')
    expect(await oneTime.verify(url, { purpose: PURPOSE, now: NOW })).toBe('valid')
    expect(await oneTime.verify(url, { purpose: PURPOSE, now: NOW })).toBe('signature_expired')
    // Every one-time link is unique, so a second one for the same page still works.
    const second = oneTime.sign('/invite/7', {
      purpose: PURPOSE,
      expiresAt: NOW + 60_000,
      oneTime: true,
    })
    expect(second).not.toBe(url)
    expect(await oneTime.verify(second, { purpose: PURPOSE, now: NOW })).toBe('valid')
    // A tampered once id is just a bad signature.
    expect(
      await oneTime.verify(second.replace(/once=[^&]+/, `once=${'b'.repeat(22)}`), {
        purpose: PURPOSE,
        now: NOW,
      }),
    ).toBe('invalid_signature')
  })

  it('one concurrent replay wins, never two', async () => {
    const oneTime = new UrlSigner(keyring, { usedSignatures: store() })
    const url = oneTime.sign('/pay/7', { purpose: PURPOSE, expiresAt: NOW + 60_000, oneTime: true })
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => oneTime.verify(url, { purpose: PURPOSE, now: NOW })),
    )
    expect(verdicts.filter((verdict) => verdict === 'valid')).toHaveLength(1)
  })

  it('a verifier without a store fails closed, and expired one-time links are expired', async () => {
    const oneTime = new UrlSigner(keyring, { usedSignatures: store() })
    const url = oneTime.sign('/x', { purpose: PURPOSE, expiresAt: NOW + 1000, oneTime: true })
    expect(await signer.verify(url, { purpose: PURPOSE, now: NOW })).toBe('invalid_signature')
    expect(await oneTime.verify(url, { purpose: PURPOSE, now: NOW + 1000 })).toBe(
      'signature_expired',
    )
  })

  it('the memory store forgets expired claims and fails closed when full of live ones', async () => {
    let now = NOW
    const bounded = new MemoryUsedSignatureStore({ maxEntries: 2, now: () => now })
    expect(await bounded.claim('a', NOW + 10)).toBe(true)
    expect(await bounded.claim('a', NOW + 10)).toBe(false)
    expect(await bounded.claim('b', NOW + 1000)).toBe(true)
    expect(await bounded.claim('c', NOW + 1000)).toBe(false)
    expect(await bounded.claim('d', NOW - 1)).toBe(false)
    now = NOW + 11
    expect(await bounded.claim('c', NOW + 1000)).toBe(true)
    expect(bounded.size).toBe(2)
    expect(() => new MemoryUsedSignatureStore({ maxEntries: 0 })).toThrow(BootError)
    expect(await new MemoryUsedSignatureStore().claim('x', Date.now() + 1000)).toBe(true)
  })
})

describe('storage temporary URLs use the same signer', () => {
  const secret = randomBytes(32).toString('base64url')
  const now = (): number => NOW

  it('keeps the expires/signature format, and storage links are not route links', () => {
    const url = new URL(
      signUrl('https://x.test/storage/files', 'files', 'a/b c.pdf', 60, { secret, now }),
    )
    expect(url.pathname).toBe('/storage/files/a/b%20c.pdf')
    const params = {
      expires: url.searchParams.get('expires'),
      signature: url.searchParams.get('signature'),
    }
    expect(verifySignedUrl('files', 'a/b c.pdf', params, { secret, now })).toBe(true)
    // The signer underneath: the same link verifies with the storage purpose, never another one.
    const storageSigner = new UrlSigner(Keyring.from(secret))
    const asPath = `/a/b%20c.pdf?expires=${params.expires}&signature=${params.signature}`
    expect(storageSigner.verifySync(asPath, { purpose: 'storage:files:GET', now: NOW })).toBe(
      'valid',
    )
    expect(storageSigner.verifySync(asPath, { purpose: 'route:files', now: NOW })).toBe(
      'invalid_signature',
    )
    expect(
      verifySignedUrl('files', 'a/b c.pdf', { ...params, expires: 'x' }, { secret, now }),
    ).toBe(false)
  })

  it('accepts a keyring, so links survive key rotation', () => {
    const before = Keyring.from(KEY_A)
    const after = Keyring.from(KEY_B, KEY_A)
    const url = new URL(
      signUrl('/s', 'files', 'k.txt', 60, { secret: before, now }),
      'http://x.test',
    )
    const params = {
      expires: url.searchParams.get('expires'),
      signature: url.searchParams.get('signature'),
    }
    expect(verifySignedUrl('files', 'k.txt', params, { secret: after, now })).toBe(true)
    expect(verifySignedUrl('files', 'k.txt', params, { secret: Keyring.from(KEY_B), now })).toBe(
      false,
    )
  })
})
