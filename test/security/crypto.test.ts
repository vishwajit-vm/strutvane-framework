/**
 * The keyring, AES-256-GCM sealing and `encrypt()`/`decrypt()` (ported from spike 12's
 * `crypto-urls.test.ts`). Attack-style cases: genuine short GCM tags made by Node itself,
 * tampering, truncation, wrong purpose, unknown keys, and keys never echoed in errors.
 */
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createContainer } from '../../src/core/container.ts'
import { BootError } from '../../src/foundation/boot-error.ts'
import { runInApplication } from '../../src/foundation/current.ts'
import {
  DecryptError,
  IV_BYTES,
  openSealed,
  packSealed,
  seal,
  TAG_BYTES,
  unpackSealed,
} from '../../src/security/aead.ts'
import { decrypt, Encrypter, EncrypterToken, encrypt } from '../../src/security/encrypter.ts'
import { Keyring, KeyringToken, keyProblem, parseAppKey } from '../../src/security/keyring.ts'

const KEY_A = `base64:${randomBytes(32).toString('base64')}`
const KEY_B = `base64:${randomBytes(32).toString('base64')}`
const TEXT_KEY = randomBytes(32).toString('base64url')

describe('the keyring', () => {
  it('accepts 32+ byte keys, base64 or text, and explains every bad one', () => {
    expect(keyProblem(KEY_A)).toBeUndefined()
    expect(keyProblem(TEXT_KEY)).toBeUndefined()
    expect(keyProblem(undefined)).toBe('is missing')
    expect(keyProblem('')).toBe('is missing')
    expect(keyProblem('   ')).toBe('is missing')
    expect(keyProblem('short-key')).toBe('is too short: 9 bytes, at least 32 are needed')
    expect(keyProblem(`base64:${randomBytes(16).toString('base64')}`)).toBe(
      'is too short: 16 bytes, at least 32 are needed',
    )
    expect(keyProblem('base64:not*base64!')).toBe(
      'starts with "base64:" but the rest is not valid base64',
    )
    // Node's decoder would silently skip junk and shorten the key; the round trip catches it.
    expect(keyProblem('base64:AAAA=AAAA')).toBe(
      'starts with "base64:" but the rest is not valid base64',
    )
  })

  it('refuses bad keys with a BootError that names the variable and never echoes the value', () => {
    for (const value of ['short-key-value', 'base64:%%%not-base64%%%', '']) {
      const error = (() => {
        try {
          parseAppKey(value)
          return undefined
        } catch (caught) {
          return caught
        }
      })()
      expect(error).toBeInstanceOf(BootError)
      const boot = error as BootError
      expect(boot.code).toBe('invalid_app_key')
      expect(boot.message.startsWith('APP_KEY ')).toBe(true)
      expect(boot.hint).toContain('node strut key:generate')
      if (value !== '') expect(`${boot.message} ${boot.hint}`).not.toContain(value)
    }
    expect(() => Keyring.from(KEY_A, 'too-short')).toThrow('APP_PREVIOUS_KEYS[0] is too short')
    expect(() => Keyring.from(KEY_A, `${KEY_B}, tiny`)).toThrow(
      'APP_PREVIOUS_KEYS[1] is too short: 4 bytes',
    )
  })

  it('derives HKDF-SHA256(key, "strutvane", "strutvane:<purpose>:v1"), per purpose and per key', () => {
    const keyring = Keyring.from(KEY_A, `${KEY_B},`)
    expect(keyring.previous).toHaveLength(1)
    expect(keyring.all.map((key) => key.id)).toEqual([keyring.current.id, keyring.previous[0]?.id])
    expect(keyring.current.id).toMatch(/^[0-9a-f]{16}$/)
    const expected = Buffer.from(
      hkdfSync('sha256', keyring.current.material, 'strutvane', 'strutvane:csrf:v1', 32),
    )
    expect(keyring.derive('csrf').equals(expected)).toBe(true)
    expect(keyring.derive('encrypt').equals(keyring.derive('signer'))).toBe(false)
    const [current, previous] = keyring.deriveAll('signer')
    expect(current?.equals(keyring.derive('signer'))).toBe(true)
    expect(previous?.equals(current ?? Buffer.alloc(0))).toBe(false)
    expect(keyring.byId(keyring.previous[0]?.id ?? '')).toBe(keyring.previous[0])
    expect(keyring.byId('0000000000000000')).toBeUndefined()
    // A text key and its base64 spelling are different keys (the text is used as UTF-8 bytes).
    expect(parseAppKey(TEXT_KEY).material.toString('utf8')).toBe(TEXT_KEY)
  })

  it('refuses purposes that could collide or smuggle separators', () => {
    const keyring = Keyring.from(KEY_A)
    for (const purpose of ['', 'CSRF', 'a b', 'x\ny', ':leading', 'a'.repeat(65)])
      expect(() => keyring.derive(purpose), JSON.stringify(purpose)).toThrow(BootError)
    expect(keyring.derive('cache.config:v2-x_y').length).toBe(32)
    expect(KeyringToken.name).toBe('strutvane.keyring')
  })
})

describe('AES-256-GCM sealing', () => {
  it('round-trips, binds the additional data, and uses a fresh IV every time', () => {
    const key = randomBytes(32)
    const sealed = seal(key, Buffer.from('hello'), 'aad')
    expect(sealed.iv).toHaveLength(IV_BYTES)
    expect(sealed.tag).toHaveLength(TAG_BYTES)
    expect(openSealed(key, sealed, 'aad').toString()).toBe('hello')
    expect(() => openSealed(key, sealed, 'other')).toThrow(DecryptError)
    expect(seal(key, Buffer.from('hello'), 'aad').iv.equals(sealed.iv)).toBe(false)
    expect(openSealed(key, unpackSealed(packSealed(sealed)), 'aad').toString()).toBe('hello')
  })

  it('refuses authentication tags shorter than 16 bytes (Node would accept 4, 8 or 12)', () => {
    const key = randomBytes(32)
    const iv = randomBytes(12)
    for (const length of [4, 8, 12]) {
      // A *genuine* short tag made by Node itself: decryption must still refuse it.
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: length })
      cipher.setAAD(Buffer.from('aad'))
      const ciphertext = Buffer.concat([cipher.update('hello'), cipher.final()])
      const tag = cipher.getAuthTag()
      expect(tag).toHaveLength(length)
      expect(() => openSealed(key, { iv, tag, ciphertext }, 'aad'), `${length}-byte tag`).toThrow(
        DecryptError,
      )
      // Packed: the fixed offsets read 16 tag bytes, so the short tag can't be smuggled in either.
      const packed = Buffer.concat([iv, tag, ciphertext])
      expect(() => openSealed(key, unpackSealed(packed), 'aad')).toThrow(DecryptError)
    }
    const good = seal(key, Buffer.from('hello'), 'aad')
    expect(() => openSealed(key, { ...good, tag: good.tag.subarray(0, 12) }, 'aad')).toThrow(
      DecryptError,
    )
  })

  it('refuses wrong key sizes, wrong IVs, truncation and tampering with one vague error', () => {
    const key = randomBytes(32)
    const sealed = seal(key, Buffer.from('secret'), 'aad')
    expect(() => seal(randomBytes(16), Buffer.from('x'), 'aad')).toThrow(RangeError)
    expect(() => openSealed(randomBytes(16), sealed, 'aad')).toThrow(DecryptError)
    expect(() => openSealed(key, { ...sealed, iv: randomBytes(16) }, 'aad')).toThrow(DecryptError)
    expect(() => openSealed(randomBytes(32), sealed, 'aad')).toThrow(DecryptError)
    const flipped = Buffer.from(sealed.ciphertext)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(() => openSealed(key, { ...sealed, ciphertext: flipped }, 'aad')).toThrow(DecryptError)
    expect(() => unpackSealed(Buffer.alloc(IV_BYTES + TAG_BYTES - 1))).toThrow(DecryptError)
    const error = new DecryptError()
    expect(error.code).toBe('decrypt_failed')
    expect(error.message).not.toMatch(/tag|key id|iv/i)
  })
})

describe('encrypt() and decrypt()', () => {
  it('round-trips values and binds them to a purpose', () => {
    const encrypter = new Encrypter(Keyring.from(KEY_A))
    const payload = encrypter.encrypt({ card: '4111', amount: 12 })
    expect(payload).toMatch(/^sv1\.[0-9a-f]{16}\.[A-Za-z0-9_-]+$/)
    expect(encrypter.decrypt(payload)).toEqual({ card: '4111', amount: 12 })
    expect(encrypter.encryptString('same')).not.toBe(encrypter.encryptString('same'))
    const cookie = encrypter.encryptString('v', { purpose: 'cookie' })
    expect(() => encrypter.decryptString(cookie)).toThrow(DecryptError)
    expect(encrypter.decryptString(cookie, { purpose: 'cookie' })).toBe('v')
  })

  it('refuses tampering, truncation and unknown keys with one vague error', () => {
    const encrypter = new Encrypter(Keyring.from(KEY_A))
    const payload = encrypter.encryptString('secret')
    const [prefix, id, body = ''] = payload.split('.')
    const bytes = Buffer.from(body, 'base64url')
    const flipped = Buffer.from(bytes)
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1
    for (const bad of [
      `${prefix}.${id}.${flipped.toString('base64url')}`,
      `${prefix}.${id}.${bytes.subarray(0, 20).toString('base64url')}`,
      `${prefix}.0000000000000000.${body}`,
      `sv2.${id}.${body}`,
      `${payload}.x`,
      `${prefix}.${id}.${body}===`,
      `${prefix}.${id}`,
      'garbage',
      '',
    ]) {
      expect(() => encrypter.decryptString(bad), bad).toThrow(DecryptError)
    }
  })

  it('keeps old values readable after key rotation, and writes with the new key', () => {
    const before = new Encrypter(Keyring.from(KEY_A))
    const old = before.encryptString('kept')
    const after = new Encrypter(Keyring.from(KEY_B, KEY_A))
    expect(after.decryptString(old)).toBe('kept')
    expect(() => before.decryptString(after.encryptString('new'))).toThrow(DecryptError)
    // Once the old key is dropped from APP_PREVIOUS_KEYS, its values are gone.
    expect(() => new Encrypter(Keyring.from(KEY_B)).decryptString(old)).toThrow(DecryptError)
  })

  it('decrypted JSON goes through the pollution guard', () => {
    const encrypter = new Encrypter(Keyring.from(KEY_A))
    const hostile = encrypter.encryptString('{"__proto__":{"admin":true}}')
    expect(() => encrypter.decrypt(hostile)).toThrow(/__proto__/)
  })

  it('is available as encrypt()/decrypt() helpers inside the app, and refuses outside it', () => {
    const container = createContainer()
    container.value(EncrypterToken, new Encrypter(Keyring.from(KEY_A)))
    const scope = { container, basePath: '.' }
    const payload = runInApplication(scope, () => encrypt('note', { purpose: 'notes' }))
    expect(runInApplication(scope, () => decrypt(payload, { purpose: 'notes' }))).toBe('note')
    expect(() => encrypt('x')).toThrow()
  })
})
