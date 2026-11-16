/**
 * The one URL signer (CONSISTENCY #64): signed routes, temporary signed routes, auth verification
 * and reset links, and storage temporary URLs all sign and verify here. Ported from spike 12's
 * `signed-url.ts` and extended with a `purpose` and one-time links.
 *
 * **What is signed:** an HMAC-SHA256 over a version tag, the `purpose`, the path and the query
 * string (keys sorted, `signature` removed; the expiry and the one-time id are ordinary signed
 * parameters). Changing any byte of the path, any parameter, the expiry or the purpose breaks the
 * signature. The host is *not* signed, so a link keeps working behind a proxy or on a second
 * domain; the trusted-host check already decides which hosts the app answers for.
 *
 * **Why a purpose:** a link signed for one feature (a password reset) can never be replayed as
 * another (a storage download) even when the paths happen to collide.
 *
 * **Keys:** the HMAC key is `keyring.derive('signer')` (CONSISTENCY #66), never `APP_KEY` itself.
 * Verification tries every key in the keyring (`deriveAll`), so `key:rotate` keeps old links
 * working until the previous key is dropped. Comparison is constant-time.
 *
 * **Hostile input:** verification never throws on what a client sends, whatever it is (the fuzz
 * tests feed it thousands of mutated links). A path is appended to a fixed base and never
 * *resolved* as a URL: the spike's fuzzer found that resolving `//cdn/x` read `cdn` as a host name
 * and dropped it from the signed path.
 *
 * **One-time links** carry a random `once` id and need a {@link UsedSignatureStore}: the first
 * successful verification claims the signature, every later one fails. They must expire, so the
 * store can forget them.
 *
 * @module
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { type Token, token } from '../core/container.ts'
import { StrutvaneError } from '../core/errors/errors.ts'
import { BootError } from '../foundation/boot-error.ts'
import { hasControlCharacter } from './control-characters.ts'
import type { Keyring } from './keyring.ts'

/**
 * The verdict on a signed URL. The two failures are also the 403 problem codes (CONSISTENCY #67).
 *
 * @example
 * const verdict: SignatureVerdict = 'signature_expired'
 */
export type SignatureVerdict = 'valid' | 'invalid_signature' | 'signature_expired'

/** The query parameter holding the signature. */
export const SIGNATURE_PARAMETER = 'signature'
/** The query parameter holding the expiry (Unix seconds). */
export const EXPIRES_PARAMETER = 'expires'
/** The query parameter holding a one-time link's random id. */
export const ONCE_PARAMETER = 'once'

/** The keyring purpose of the signing subkey. */
const KEY_PURPOSE = 'signer'
/** A signature is exactly a base64url SHA-256 HMAC: 43 characters. */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/
/** Unix seconds; 12 digits reach the year 33658, so anything longer is junk. */
const EXPIRES = /^\d{1,12}$/
/** A one-time id: 16 random bytes as base64url. */
const ONCE = /^[A-Za-z0-9_-]{22}$/
/** Purposes are printable labels (no line breaks: they separate the parts of the signed message). */
const MAX_PURPOSE_LENGTH = 200
/** Real links are far shorter; anything longer is refused before any parsing. */
const MAX_TARGET_LENGTH = 8192
/** A fixed base a path is appended to (never resolved against). `.invalid` never resolves. */
const PATH_BASE = 'http://signing.invalid'

/**
 * Options for {@link UrlSigner.sign}.
 *
 * @example
 * const options: SignOptions = { purpose: 'route:files.show', expiresAt: new Date(Date.now() + 60_000) }
 */
export interface SignOptions {
  /** What the link is for (`route:<name>`, `storage:<disk>:GET`); must match when verifying. */
  readonly purpose: string
  /** When the link stops working: a `Date`, or epoch milliseconds. Omit for a permanent link. */
  readonly expiresAt?: Date | number
  /** Make the link work once (needs `expiresAt` and a {@link UsedSignatureStore}). */
  readonly oneTime?: boolean
}

/**
 * Options for {@link UrlSigner.verify}.
 *
 * @example
 * const options: VerifyOptions = { purpose: 'route:files.show', now: clock.now() }
 */
export interface VerifyOptions {
  /** The purpose the link must have been signed for. */
  readonly purpose: string
  /** The current time: a `Date`, or epoch milliseconds (what `ClockToken`'s `now()` returns). */
  readonly now: Date | number
}

/**
 * Remembers which one-time links were already used. Implementations must be atomic per
 * signature (two concurrent claims: exactly one wins) and may forget a signature after
 * `expiresAt`, when the link is dead anyway. Production apps with several processes bind a shared
 * store (database or Redis) under {@link UsedSignatureStoreToken}.
 *
 * @example
 * const store: UsedSignatureStore = new MemoryUsedSignatureStore()
 * await store.claim(signature, expiresAtMs) // true the first time, false afterwards
 */
export interface UsedSignatureStore {
  /**
   * Record the signature as used. `true` when this call was the first, `false` when it was
   * already used (or the store refuses, which must fail closed).
   */
  claim(signature: string, expiresAt: number): Promise<boolean>
}

/**
 * Options for {@link MemoryUsedSignatureStore}.
 *
 * @example
 * const options: MemoryUsedSignatureStoreOptions = { maxEntries: 50_000, now: () => clock.now() }
 */
export interface MemoryUsedSignatureStoreOptions {
  /** The most live claims kept (default 10,000). When full of live claims, new claims fail. */
  readonly maxEntries?: number
  /** Epoch milliseconds, for forgetting expired claims. Default `Date.now`. */
  readonly now?: () => number
}

/**
 * A bounded, per-process {@link UsedSignatureStore}: right for one process and for tests. It
 * forgets claims once their link has expired; when it is full of claims that are still live, it
 * refuses new ones (fail closed: a flood can make one-time links fail, never work twice).
 *
 * @example
 * const signer = new UrlSigner(keyring, { usedSignatures: new MemoryUsedSignatureStore() })
 */
export class MemoryUsedSignatureStore implements UsedSignatureStore {
  readonly #used = new Map<string, number>()
  readonly #maxEntries: number
  readonly #now: () => number

  constructor(options: MemoryUsedSignatureStoreOptions = {}) {
    const max = options.maxEntries ?? 10_000
    if (!Number.isInteger(max) || max < 1)
      throw new BootError(
        'invalid_store_size',
        `MemoryUsedSignatureStore maxEntries must be a positive whole number (got ${String(max)}).`,
        'Pass a size such as 10000, or leave it out for the default.',
      )
    this.#maxEntries = max
    this.#now = options.now ?? Date.now
  }

  /**
   * Claim a signature; see {@link UsedSignatureStore.claim}.
   *
   * @example
   * await store.claim('k1Yq…', Date.now() + 60_000) // true
   */
  async claim(signature: string, expiresAt: number): Promise<boolean> {
    const now = this.#now()
    if (expiresAt <= now) return false
    const seen = this.#used.get(signature)
    if (seen !== undefined && seen > now) return false
    if (this.#used.size >= this.#maxEntries) this.#sweep(now)
    if (this.#used.size >= this.#maxEntries) return false
    this.#used.set(signature, expiresAt)
    return true
  }

  /** How many claims are held (for tests and diagnostics). */
  get size(): number {
    return this.#used.size
  }

  #sweep(now: number): void {
    for (const [signature, expiresAt] of this.#used)
      if (expiresAt <= now) this.#used.delete(signature)
  }
}

/**
 * Options for {@link UrlSigner}.
 *
 * @example
 * const options: UrlSignerOptions = { usedSignatures: new MemoryUsedSignatureStore() }
 */
export interface UrlSignerOptions {
  /** Where one-time links are claimed. Without it, one-time links can't be made or used. */
  readonly usedSignatures?: UsedSignatureStore
}

/**
 * Signs and verifies URLs with the app's keyring.
 *
 * @example
 * const signer = new UrlSigner(keyring)
 * const link = signer.sign('/downloads/7?format=pdf', { purpose: 'route:downloads.show' })
 * await signer.verify(link, { purpose: 'route:downloads.show', now: Date.now() }) // 'valid'
 */
export class UrlSigner {
  /** The signing subkeys, current first (derived once: the keyring never changes). */
  readonly #keys: readonly Buffer[]
  readonly #usedSignatures: UsedSignatureStore | undefined

  constructor(keyring: Keyring, options: UrlSignerOptions = {}) {
    this.#keys = keyring.deriveAll(KEY_PURPOSE)
    this.#usedSignatures = options.usedSignatures
  }

  /**
   * Sign a path with an optional query (`/downloads/7?format=pdf`), or an absolute URL. Adds
   * `expires` (temporary links), `once` (one-time links) and `signature`. Throws a `BootError`
   * for a malformed target, a target that already carries one of those parameters, a bad
   * purpose or expiry, or a one-time link without an expiry or a store.
   *
   * @example
   * signer.sign('/reset?user=7', { purpose: 'auth:reset', expiresAt: Date.now() + 3_600_000 })
   * // '/reset?user=7&expires=1763200000&signature=…'
   */
  sign(target: string, options: SignOptions): string {
    assertPurpose(options.purpose)
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(target)
    const url = absolute || target.startsWith('/') ? parseTarget(target) : undefined
    if (url === undefined)
      throw new BootError(
        'invalid_signing_target',
        `"${target.slice(0, 200)}" is not a path or an absolute URL.`,
        'Sign a path such as /downloads/7 or a full https:// URL.',
      )
    for (const name of [SIGNATURE_PARAMETER, EXPIRES_PARAMETER, ONCE_PARAMETER]) {
      if (url.searchParams.has(name))
        throw new BootError(
          'already_signed',
          `The URL to sign already has a "${name}" parameter.`,
          'Sign the plain URL: the signer adds "expires", "once" and "signature" itself.',
        )
    }
    const expires = options.expiresAt === undefined ? undefined : expirySeconds(options.expiresAt)
    if (expires !== undefined) url.searchParams.set(EXPIRES_PARAMETER, String(expires))
    if (options.oneTime === true) {
      if (expires === undefined)
        throw new BootError(
          'one_time_link_needs_expiry',
          'A one-time link must also expire.',
          'Pass expiresAt (or expiresIn) together with oneTime, so used links can be forgotten.',
        )
      if (this.#usedSignatures === undefined)
        throw new BootError(
          'one_time_link_needs_store',
          'One-time links need a used-signature store, and none is configured.',
          'Bind a UsedSignatureStore (MemoryUsedSignatureStore for one process) before signing one-time links.',
        )
      url.searchParams.set(ONCE_PARAMETER, randomBytes(16).toString('base64url'))
    }
    url.searchParams.set(SIGNATURE_PARAMETER, mac(message(url, options.purpose), this.#current()))
    return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`
  }

  /**
   * Check a signed URL: the signature against every key, then the expiry, then (for one-time
   * links) claim it. Never throws for anything a client can send; a store failure is the only
   * thing that propagates.
   *
   * @example
   * const verdict = await signer.verify(request.url, { purpose: 'route:files.show', now: clock.now() })
   * if (verdict !== 'valid') throw signatureError(verdict)
   */
  async verify(target: string | URL, options: VerifyOptions): Promise<SignatureVerdict> {
    const checked = this.#check(target, options)
    if (checked.verdict !== 'valid' || checked.once === undefined) return checked.verdict
    if (this.#usedSignatures === undefined || checked.expiresAt === undefined)
      return 'invalid_signature'
    return (await this.#usedSignatures.claim(checked.signature, checked.expiresAt))
      ? 'valid'
      : 'signature_expired'
  }

  /**
   * The synchronous check for links that are never one-time (storage URLs): signature and
   * expiry only. A one-time link is refused here (`invalid_signature`), so it can never be used
   * without being claimed: use {@link UrlSigner.verify} for those.
   *
   * @example
   * signer.verifySync('/storage/files/a.txt?expires=…&signature=…', { purpose: 'storage:files:GET', now: Date.now() })
   */
  verifySync(target: string | URL, options: VerifyOptions): SignatureVerdict {
    const checked = this.#check(target, options)
    return checked.once === undefined ? checked.verdict : 'invalid_signature'
  }

  #current(): Buffer {
    const [current] = this.#keys
    // The keyring always has a current key; this only satisfies the type checker.
    if (current === undefined) throw new Error('The keyring has no current key.')
    return current
  }

  #check(
    target: string | URL,
    options: VerifyOptions,
  ): {
    readonly verdict: SignatureVerdict
    readonly signature: string
    readonly expiresAt?: number
    readonly once?: string
  } {
    const invalid = { verdict: 'invalid_signature', signature: '' } as const
    try {
      if (!validPurpose(options.purpose)) return invalid
      const text = typeof target === 'string' ? target : target.href
      if (text.length > MAX_TARGET_LENGTH) return invalid
      const url =
        text.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(text) ? parseTarget(text) : undefined
      if (url === undefined) return invalid
      const signatures = url.searchParams.getAll(SIGNATURE_PARAMETER)
      const expiries = url.searchParams.getAll(EXPIRES_PARAMETER)
      const onces = url.searchParams.getAll(ONCE_PARAMETER)
      const [signature] = signatures
      const [expiry] = expiries
      const [once] = onces
      // Exactly one well-formed signature, at most one expiry and one-time id: duplicates are
      // ambiguous (which one would the app read?), so they are refused.
      if (
        signatures.length !== 1 ||
        signature === undefined ||
        !SIGNATURE.test(signature) ||
        expiries.length > 1 ||
        onces.length > 1 ||
        (expiry !== undefined && !EXPIRES.test(expiry)) ||
        (once !== undefined && !ONCE.test(once))
      )
        return invalid
      const signed = message(url, options.purpose)
      const given = Buffer.from(signature)
      let matches = false
      // Every key is tried (no early exit), so timing doesn't reveal which key matched.
      for (const key of this.#keys) {
        const expected = Buffer.from(mac(signed, key))
        if (expected.length === given.length && timingSafeEqual(expected, given)) matches = true
      }
      if (!matches) return invalid
      const expiresAt = expiry === undefined ? undefined : Number(expiry) * 1000
      const verdict: SignatureVerdict =
        expiresAt !== undefined && expiresAt <= epochMs(options.now) ? 'signature_expired' : 'valid'
      return {
        verdict,
        signature,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(once !== undefined ? { once } : {}),
      }
    } catch {
      // Defensive: nothing above should throw, but a verifier must never turn input into a 500.
      return invalid
    }
  }
}

/**
 * The client-facing error for a failed verdict: a 403 problem with code `invalid_signature` or
 * `signature_expired` (CONSISTENCY #67), or `undefined` for a valid link.
 *
 * @example
 * const error = signatureError(verdict)
 * if (error) throw error
 */
export function signatureError(verdict: SignatureVerdict): StrutvaneError | undefined {
  return verdict === 'valid' ? undefined : new StrutvaneError(verdict, { status: 403 })
}

/**
 * The container token for the app's URL signer, bound at boot.
 *
 * @example
 * app.make(UrlSignerToken).sign('/x', { purpose: 'route:x' })
 */
export const UrlSignerToken: Token<UrlSigner> = token<UrlSigner>('strutvane.url-signer')

/**
 * The container token for the store that remembers used one-time links.
 *
 * @example
 * app.container.value(UsedSignatureStoreToken, new MemoryUsedSignatureStore())
 */
export const UsedSignatureStoreToken: Token<UsedSignatureStore> = token<UsedSignatureStore>(
  'strutvane.used-signatures',
)

function validPurpose(purpose: string): boolean {
  return (
    typeof purpose === 'string' &&
    purpose.length > 0 &&
    purpose.length <= MAX_PURPOSE_LENGTH &&
    !hasControlCharacter(purpose)
  )
}

function assertPurpose(purpose: string): void {
  if (!validPurpose(purpose))
    throw new BootError(
      'invalid_signing_purpose',
      'A signing purpose must be 1 to 200 printable characters, without line breaks.',
      'Use a short label such as "route:files.show" or "storage:files:GET".',
    )
}

/**
 * Parse a path or an absolute URL without the relative-URL traps: a path is appended to a fixed
 * base instead of being *resolved* against it, so `//host/x` stays the path `//host/x` (found by
 * the spike's fuzz test).
 */
function parseTarget(target: string): URL | undefined {
  const text = target.startsWith('/') ? `${PATH_BASE}${target}` : target
  return URL.canParse(text) ? new URL(text) : undefined
}

/** The signed message: version, purpose, path, then the query without `signature`, keys sorted. */
function message(url: URL, purpose: string): string {
  const query = new URLSearchParams(url.search)
  query.delete(SIGNATURE_PARAMETER)
  query.sort()
  return `strutvane-signed-url:v1\n${purpose}\n${url.pathname}\n${query.toString()}`
}

function mac(text: string, key: Buffer): string {
  return createHmac('sha256', key).update(text).digest('base64url')
}

function epochMs(value: Date | number): number {
  return typeof value === 'number' ? value : value.getTime()
}

function expirySeconds(value: Date | number): number {
  const ms = epochMs(value)
  const seconds = Math.floor(ms / 1000)
  if (!Number.isFinite(ms) || seconds < 1 || seconds > 999_999_999_999)
    throw new BootError(
      'invalid_link_expiry',
      'The link expiry is not a valid point in time.',
      'Pass a Date or epoch milliseconds, e.g. Date.now() + 60_000.',
    )
  return seconds
}
