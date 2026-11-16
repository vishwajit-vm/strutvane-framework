/**
 * `encrypt()` / `decrypt()` and the `Crypt` facade's engine: AES-256-GCM with key rotation.
 *
 * Format: `sv1.<key id>.<base64url(iv | tag | ciphertext)>`. The key id says which key made it,
 * so after `key:rotate` old values open with the previous key while new ones use the current
 * key. Each value is bound to a purpose (GCM additional data): a value encrypted for `'cookie'`
 * won't decrypt as `'default'`. The cipher key is `keyring.derive('encrypt')`, never `APP_KEY`.
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'
import { currentApplication } from '../foundation/current.ts'
import { DecryptError, openSealed, packSealed, seal, unpackSealed } from './aead.ts'
import type { Keyring } from './keyring.ts'
import { parseJsonSafely } from './safe-json.ts'

export { DecryptError }

const PREFIX = 'sv1'

/**
 * Options for one encryption.
 *
 * @example
 * encrypter.encryptString('4111…', { purpose: 'payment-card' })
 */
export interface CryptOptions {
  /** What the value is for; it must match when decrypting. Default `'default'`. */
  readonly purpose?: string
}

/**
 * Encrypts and decrypts with the app's keyring.
 *
 * @example
 * const encrypter = new Encrypter(keyring)
 * encrypter.decryptString(encrypter.encryptString('hi')) // 'hi'
 */
export class Encrypter {
  readonly #keyring: Keyring

  constructor(keyring: Keyring) {
    this.#keyring = keyring
  }

  /**
   * Encrypt a string with the current key.
   *
   * @example
   * encrypter.encryptString('secret')
   */
  encryptString(plaintext: string, options: CryptOptions = {}): string {
    const key = this.#keyring.current
    const sealed = seal(
      this.#keyring.derive('encrypt', key),
      Buffer.from(plaintext, 'utf8'),
      aad(options),
    )
    return `${PREFIX}.${key.id}.${packSealed(sealed).toString('base64url')}`
  }

  /**
   * Decrypt a string made by {@link Encrypter.encryptString} with the current or a previous key.
   * Throws {@link DecryptError} on any tampering, truncation, wrong purpose or unknown key.
   *
   * @example
   * encrypter.decryptString(payload)
   */
  decryptString(payload: string, options: CryptOptions = {}): string {
    const [prefix, keyId, body, extra] = payload.split('.')
    if (
      prefix !== PREFIX ||
      keyId === undefined ||
      body === undefined ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(body)
    )
      throw new DecryptError()
    const key = this.#keyring.byId(keyId)
    if (key === undefined) throw new DecryptError()
    return openSealed(
      this.#keyring.derive('encrypt', key),
      unpackSealed(Buffer.from(body, 'base64url')),
      aad(options),
    ).toString('utf8')
  }

  /**
   * Encrypt any JSON value.
   *
   * @example
   * encrypter.encrypt({ card: '4111…' })
   */
  encrypt(value: unknown, options: CryptOptions = {}): string {
    return this.encryptString(JSON.stringify(value), options)
  }

  /**
   * Decrypt a JSON value. The result is `unknown`: validate it before use, as with any input.
   *
   * @example
   * const value = encrypter.decrypt(payload)
   */
  decrypt(payload: string, options: CryptOptions = {}): unknown {
    return parseJsonSafely(this.decryptString(payload, options))
  }
}

function aad(options: CryptOptions): string {
  return `strutvane:encrypt:${options.purpose ?? 'default'}`
}

/**
 * The container token for the app's encrypter.
 *
 * @example
 * app.make(EncrypterToken).encrypt('x')
 */
export const EncrypterToken: Token<Encrypter> = token<Encrypter>('strutvane.encrypter')

/**
 * Encrypt with the current app's key, Laravel's `encrypt()`.
 *
 * @example
 * const stored = encrypt({ note })
 */
export function encrypt(value: unknown, options: CryptOptions = {}): string {
  return currentApplication('encrypt()').container.make(EncrypterToken).encrypt(value, options)
}

/**
 * Decrypt with the current app's keys, Laravel's `decrypt()`. Returns `unknown`.
 *
 * @example
 * const note = decrypt(stored)
 */
export function decrypt(payload: string, options: CryptOptions = {}): unknown {
  return currentApplication('decrypt()').container.make(EncrypterToken).decrypt(payload, options)
}
