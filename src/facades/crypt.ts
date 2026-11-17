/**
 * The `Crypt` facade: the current app's encrypter (AES-256-GCM under a key derived from
 * `APP_KEY`, with `APP_PREVIOUS_KEYS` still decrypting), Laravel's `Crypt::`.
 *
 * @module
 */
import { type CryptOptions, type Encrypter, EncrypterToken } from '../security/encrypter.ts'
import { type FacadeBinding, resolveFacade } from './facade.ts'

const binding: FacadeBinding<Encrypter> = {
  facade: 'Crypt',
  token: EncrypterToken,
  provides: 'the encrypter',
  install:
    'The app binds an encrypter from APP_KEY when it boots; run `node strut key:generate` if APP_KEY is missing.',
}

/**
 * What the `Crypt` facade offers.
 *
 * @example
 * const crypt: CryptFacade = Crypt
 */
export interface CryptFacade {
  /** Encrypt any JSON value. */
  encrypt(value: unknown, options?: CryptOptions): string
  /** Decrypt to `unknown` (check it like any input). Throws `DecryptError` when tampered. */
  decrypt(payload: string, options?: CryptOptions): unknown
  /** Encrypt a string as is. */
  encryptString(plaintext: string, options?: CryptOptions): string
  /** Decrypt a string encrypted with `encryptString`. */
  decryptString(payload: string, options?: CryptOptions): string
}

/**
 * Encrypt and decrypt with the current app's keys. Pass a `purpose` so a value encrypted for one
 * use can't be replayed in another.
 *
 * @example
 * const stored = Crypt.encryptString(card.number, { purpose: 'payment-card' })
 * const number = Crypt.decryptString(stored, { purpose: 'payment-card' })
 */
export const Crypt: CryptFacade = Object.freeze({
  encrypt: (value: unknown, options?: CryptOptions): string =>
    resolveFacade(binding, 'encrypt').encrypt(value, options),
  decrypt: (payload: string, options?: CryptOptions): unknown =>
    resolveFacade(binding, 'decrypt').decrypt(payload, options),
  encryptString: (plaintext: string, options?: CryptOptions): string =>
    resolveFacade(binding, 'encryptString').encryptString(plaintext, options),
  decryptString: (payload: string, options?: CryptOptions): string =>
    resolveFacade(binding, 'decryptString').decryptString(payload, options),
})
