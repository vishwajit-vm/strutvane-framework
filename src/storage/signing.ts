/**
 * Signed, expiring URLs for private files (`temporaryUrl`). The signature is an HMAC-SHA256 over
 * the disk, key, method and expiry, so a URL cannot be extended, moved to another key, or reused
 * for another method. Comparison is constant-time.
 *
 * @module
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Options for {@link signUrl} / {@link verifySignedUrl}. */
export interface SigningOptions {
  /** At least 32 bytes of secret (e.g. `APP_KEY`). */
  readonly secret: string
  readonly now?: () => number
}

const payload = (disk: string, key: string, method: string, expires: number): string =>
  `${method.toUpperCase()}\n${disk}\n${key}\n${expires}`

function sign(secret: string, data: string): string {
  if (Buffer.byteLength(secret) < 32)
    throw new Error('The URL signing secret must be at least 32 bytes')
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/** Build `<base>/<key>?expires=…&signature=…`. */
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
    expiresInSeconds > 7 * 24 * 3600
  ) {
    throw new RangeError('expiresInSeconds must be between 1 second and 7 days')
  }
  const now = options.now ?? Date.now
  const expires = Math.floor(now() / 1000) + expiresInSeconds
  const signature = sign(options.secret, payload(disk, key, options.method ?? 'GET', expires))
  const path = key.split('/').map(encodeURIComponent).join('/')
  return `${base.replace(/\/+$/, '')}/${path}?expires=${expires}&signature=${signature}`
}

/** Verify a signed URL's parameters. Returns `false` for anything wrong or expired. */
export function verifySignedUrl(
  disk: string,
  key: string,
  params: { readonly expires?: string | null; readonly signature?: string | null },
  options: SigningOptions & { readonly method?: string },
): boolean {
  const { expires, signature } = params
  if (!expires || !signature || !/^\d{1,12}$/.test(expires)) return false
  const now = options.now ?? Date.now
  if (Number(expires) < Math.floor(now() / 1000)) return false
  const expected = Buffer.from(
    sign(options.secret, payload(disk, key, options.method ?? 'GET', Number(expires))),
  )
  const given = Buffer.from(signature)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
