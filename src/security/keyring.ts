/**
 * The app's keys: `APP_KEY` plus the retired keys in `APP_PREVIOUS_KEYS`, so `key:rotate` never
 * breaks existing encrypted values, cookies or signed links. New values are always produced with
 * the current key; old ones are still *accepted* with a previous key until it is removed.
 *
 * **One keyring, one derivation (CONSISTENCY #66).** Every feature gets its own subkey through
 * {@link Keyring.derive}: `HKDF-SHA256(APP_KEY, salt "strutvane", info "strutvane:<purpose>:v1")`.
 * A value signed for one purpose (a URL) can therefore never be replayed as another (a cookie),
 * and the raw key is never used directly as an HMAC or cipher key. The CSRF token, signed URLs,
 * `encrypt()`, the maintenance bypass and the bootstrap caches all derive here.
 *
 * Key values: `base64:<…>` is decoded (Laravel's format); anything else is used as UTF-8 text
 * (what `node strut key:generate` writes: 32 random bytes as base64url). Either way at least 32
 * bytes of material are required.
 *
 * @module
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { type Token, token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'

/** The least key material accepted: 256 bits, the AES-256 key size. */
export const MIN_KEY_BYTES = 32

/** The HKDF salt every derivation uses. */
export const KEYRING_SALT = 'strutvane'

/** Purposes are short, lowercase labels: `csrf`, `signed-url`, `encrypt`, `cache.config`. */
const PURPOSE = /^[a-z0-9][a-z0-9._:-]{0,63}$/

/**
 * One key: its bytes and a short public id (an HMAC of the key, which reveals nothing about it).
 *
 * @example
 * const key: AppKey = parseAppKey('base64:…')
 */
export interface AppKey {
  readonly material: Buffer
  /** 16 hex characters; stored next to ciphertexts and caches to pick the right key. */
  readonly id: string
}

/**
 * Why a key value is unusable, or `undefined` when it's fine. Used by the boot guard,
 * `security:check` and `key:rotate`. Never echoes the value.
 *
 * @example
 * keyProblem('short') // 'is too short: 5 bytes, at least 32 are needed'
 */
export function keyProblem(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return 'is missing'
  const material = keyMaterial(value)
  if (material === undefined) return 'starts with "base64:" but the rest is not valid base64'
  if (material.length < MIN_KEY_BYTES)
    return `is too short: ${material.length} bytes, at least ${MIN_KEY_BYTES} are needed`
  return undefined
}

/**
 * The bytes of a key value, or `undefined` for broken base64. Node's decoder silently skips
 * junk, which would shorten a key unnoticed, so the decoding is round-trip checked.
 */
function keyMaterial(value: string): Buffer | undefined {
  if (!value.startsWith('base64:')) return Buffer.from(value, 'utf8')
  const encoded = value.slice('base64:'.length)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined
  const bytes = Buffer.from(encoded, 'base64')
  return bytes.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, '')
    ? bytes
    : undefined
}

/**
 * Parse a key value, or throw a friendly {@link BootError} naming the variable (never the value).
 *
 * @example
 * parseAppKey(process.env.APP_KEY, 'APP_KEY')
 */
export function parseAppKey(value: string | undefined, variable = 'APP_KEY'): AppKey {
  const problem = keyProblem(value)
  const material = value === undefined ? undefined : keyMaterial(value)
  if (problem !== undefined || material === undefined) {
    throw new BootError(
      'invalid_app_key',
      `${variable} ${problem ?? 'is invalid'}.`,
      'Run `node strut key:generate` to create a strong key (32 random bytes).',
    )
  }
  return {
    material,
    id: createHmac('sha256', material).update('strutvane:key-id').digest('hex').slice(0, 16),
  }
}

/**
 * The current key and the previous ones.
 *
 * @example
 * const keyring = Keyring.from(env.APP_KEY, env.APP_PREVIOUS_KEYS)
 * keyring.derive('signed-url') // 32 bytes for URL signatures
 */
export class Keyring {
  /** The key every new value is made with. */
  readonly current: AppKey
  /** Retired keys, newest first: still accepted, never used to produce. */
  readonly previous: readonly AppKey[]

  constructor(current: AppKey, previous: readonly AppKey[] = []) {
    this.current = current
    this.previous = Object.freeze([...previous])
  }

  /**
   * Build from `APP_KEY` and a comma-separated `APP_PREVIOUS_KEYS`.
   *
   * @example
   * Keyring.from('base64:…', 'base64:old1,base64:old2')
   */
  static from(appKey: string | undefined, previousKeys = ''): Keyring {
    const previous = previousKeys
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .map((value, index) => parseAppKey(value, `APP_PREVIOUS_KEYS[${index}]`))
    return new Keyring(parseAppKey(appKey), previous)
  }

  /**
   * Every key, current first.
   *
   * @example
   * keyring.all.length // 1 + previous keys
   */
  get all(): readonly AppKey[] {
    return [this.current, ...this.previous]
  }

  /**
   * A 32-byte subkey for one purpose, from the current key (or the given one):
   * `HKDF-SHA256(key, "strutvane", "strutvane:<purpose>:v1")`.
   *
   * @example
   * keyring.derive('encrypt')
   */
  derive(purpose: string, key: AppKey = this.current): Buffer {
    if (!PURPOSE.test(purpose)) {
      throw new BootError(
        'invalid_key_purpose',
        `"${purpose}" is not a valid key purpose.`,
        'Use a short lowercase label such as "csrf" or "signed-url".',
      )
    }
    return Buffer.from(
      hkdfSync('sha256', key.material, KEYRING_SALT, `strutvane:${purpose}:v1`, 32),
    )
  }

  /**
   * The subkeys for one purpose from every key, current first: what a verifier tries, so values
   * made before `key:rotate` keep working.
   *
   * @example
   * keyring.deriveAll('signed-url').some((key) => verify(key))
   */
  deriveAll(purpose: string): readonly Buffer[] {
    return this.all.map((key) => this.derive(purpose, key))
  }

  /**
   * The key with this id, if the keyring still has it.
   *
   * @example
   * keyring.byId('3f2a…')
   */
  byId(id: string): AppKey | undefined {
    return this.all.find((key) => key.id === id)
  }
}

/**
 * The container token for the app's keyring, bound at boot.
 *
 * @example
 * app.make(KeyringToken).current.id
 */
export const KeyringToken: Token<Keyring> = token<Keyring>('strutvane.keyring')
