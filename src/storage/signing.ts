/**
 * Signed, expiring URLs for private files (`temporaryUrl`), made and checked by the framework's
 * one URL signer (CONSISTENCY #64, `security/signer.ts`). The link's path is the file key; the
 * signer's `purpose` is `storage:<disk>:<METHOD>`, so a URL cannot be extended, moved to another
 * key or disk, reused for another method, or replayed as any other kind of signed link.
 * Comparison is constant-time.
 *
 * The HMAC key is never the configured secret itself: the secret becomes a keyring and the signer
 * derives its own purpose-bound subkey from it (HKDF-SHA256, CONSISTENCY #66). Passing the app's
 * {@link Keyring} instead of a secret also accepts links made with `APP_PREVIOUS_KEYS`, so
 * `key:rotate` keeps unexpired links working.
 *
 * @module
 */
import { Keyring, parseAppKey } from '../security/keyring.ts'
import { UrlSigner } from '../security/signer.ts'

/**
 * Options for {@link signUrl} / {@link verifySignedUrl}.
 *
 * @example
 * const options: SigningOptions = { secret: process.env.APP_KEY ?? '' }
 */
export interface SigningOptions {
  /** At least 32 bytes of secret (e.g. `APP_KEY`), or the app's keyring. */
  readonly secret: string | Keyring
  /** Epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number
}

/** The longest a storage link may live: past a week, a "temporary" URL is a permanent leak. */
const MAX_EXPIRY_SECONDS = 7 * 24 * 3600

const bySecret = new Map<string, UrlSigner>()
const byKeyring = new WeakMap<Keyring, UrlSigner>()

/** The signer for a secret or keyring (cached: building one derives keys). */
function signerFor(secret: string | Keyring): UrlSigner {
  if (secret instanceof Keyring) {
    let signer = byKeyring.get(secret)
    if (signer === undefined) {
      signer = new UrlSigner(secret)
      byKeyring.set(secret, signer)
    }
    return signer
  }
  if (Buffer.byteLength(secret) < 32)
    throw new Error('The URL signing secret must be at least 32 bytes')
  let signer = bySecret.get(secret)
  if (signer === undefined) {
    signer = new UrlSigner(new Keyring(parseAppKey(secret, 'the URL signing secret')))
    if (bySecret.size > 16) bySecret.clear() // a handful of secrets at most; never grows unbounded
    bySecret.set(secret, signer)
  }
  return signer
}

const purpose = (disk: string, method: string | undefined): string =>
  `storage:${disk}:${(method ?? 'GET').toUpperCase()}`

/** The key as a URL path: each segment percent-encoded, so `/` stays the separator. */
const keyPath = (key: string): string => `/${key.split('/').map(encodeURIComponent).join('/')}`

/**
 * Build `<base>/<key>?expires=…&signature=…`, valid for `expiresInSeconds` (1 second to 7 days).
 *
 * @example
 * signUrl('/storage/files', 'files', 'docs/a.pdf', 300, { secret: env.APP_KEY })
 * // '/storage/files/docs/a.pdf?expires=1763200000&signature=…'
 */
export function signUrl(
  base: string,
  disk: string,
  key: string,
  expiresInSeconds: number,
  options: SigningOptions & { readonly method?: string },
): string {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > MAX_EXPIRY_SECONDS
  ) {
    throw new RangeError('expiresInSeconds must be between 1 second and 7 days')
  }
  const now = options.now ?? Date.now
  const signed = signerFor(options.secret).sign(keyPath(key), {
    purpose: purpose(disk, options.method),
    expiresAt: now() + expiresInSeconds * 1000,
  })
  return `${base.replace(/\/+$/, '')}${signed}`
}

/**
 * Verify a signed URL's parameters. Returns `false` for anything wrong, expired or unsigned
 * (storage links always expire), and never throws for hostile parameters.
 *
 * @example
 * verifySignedUrl('files', 'docs/a.pdf', { expires: url.searchParams.get('expires'), signature: url.searchParams.get('signature') }, { secret })
 */
export function verifySignedUrl(
  disk: string,
  key: string,
  params: { readonly expires?: string | null; readonly signature?: string | null },
  options: SigningOptions & { readonly method?: string },
): boolean {
  const { expires, signature } = params
  if (!expires || !signature || !/^\d{1,12}$/.test(expires)) return false
  const query = new URLSearchParams({ expires, signature })
  const now = options.now ?? Date.now
  return (
    signerFor(options.secret).verifySync(`${keyPath(key)}?${query.toString()}`, {
      purpose: purpose(disk, options.method),
      now: now(),
    }) === 'valid'
  )
}
