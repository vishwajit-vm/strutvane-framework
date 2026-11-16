/**
 * AES-256-GCM sealing and opening, shared by `encrypt()`, the config cache and `env:encrypt`.
 *
 * Why a module of its own: GCM has two sharp edges, and every caller must get them right:
 * 1. a fresh random 96-bit IV for every message (reusing one with the same key breaks GCM);
 * 2. the authentication tag must be checked at its **full 16 bytes**. Node accepts shorter tags
 *    unless told otherwise (deprecated as DEP0182), which makes forgeries far cheaper, so
 *    {@link openSealed} passes `authTagLength: 16` *and* refuses any tag that isn't exactly 16
 *    bytes before using it. Packed messages use fixed offsets, so a short tag can't be smuggled
 *    in through a length field.
 *
 * @module
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** GCM's recommended IV length (96 bits). */
export const IV_BYTES = 12
/** The only tag length accepted (128 bits). */
export const TAG_BYTES = 16
/** AES-256 key length. */
export const KEY_BYTES = 32

/**
 * The three parts of a sealed message.
 *
 * @example
 * const sealed: Sealed = seal(key, Buffer.from('hi'), 'purpose')
 */
export interface Sealed {
  readonly iv: Buffer
  readonly tag: Buffer
  readonly ciphertext: Buffer
}

/**
 * Thrown when a message can't be opened. Deliberately vague: whether the key, the tag or the
 * data was wrong is not something to tell an attacker.
 *
 * @example
 * try { openSealed(key, sealed, 'x') } catch (error) { if (error instanceof DecryptError) … }
 */
export class DecryptError extends Error {
  /** Stable code (lowercase snake_case, CONSISTENCY #68). */
  readonly code = 'decrypt_failed'

  constructor() {
    super(
      'The value could not be decrypted: it was tampered with, truncated, or made with another key.',
    )
    this.name = 'DecryptError'
  }
}

/**
 * Encrypt and authenticate `plaintext` with a 32-byte key. `aad` binds the message to a context
 * (its purpose), so it can't be opened as something else.
 *
 * @example
 * const sealed = seal(subkey, Buffer.from('secret'), 'strutvane:encrypt:cookie')
 */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  if (key.length !== KEY_BYTES) throw new RangeError(`seal(): the key must be ${KEY_BYTES} bytes`)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), ciphertext }
}

/**
 * Check and decrypt a sealed message. Throws {@link DecryptError} on any problem, including a
 * tag or IV of the wrong length.
 *
 * @example
 * const plaintext = openSealed(subkey, sealed, 'strutvane:encrypt:cookie')
 */
export function openSealed(key: Buffer, sealed: Sealed, aad: string): Buffer {
  if (key.length !== KEY_BYTES || sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES)
    throw new DecryptError()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(sealed.tag)
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()])
  } catch {
    throw new DecryptError()
  }
}

/**
 * Pack a sealed message as `iv | tag | ciphertext` (fixed offsets).
 *
 * @example
 * const bytes = packSealed(sealed)
 */
export function packSealed(sealed: Sealed): Buffer {
  return Buffer.concat([sealed.iv, sealed.tag, sealed.ciphertext])
}

/**
 * Unpack `iv | tag | ciphertext`. Too short → {@link DecryptError}.
 *
 * @example
 * openSealed(key, unpackSealed(bytes), 'aad')
 */
export function unpackSealed(bytes: Buffer): Sealed {
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new DecryptError()
  return {
    iv: bytes.subarray(0, IV_BYTES),
    tag: bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    ciphertext: bytes.subarray(IV_BYTES + TAG_BYTES),
  }
}
