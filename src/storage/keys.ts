/**
 * Storage keys and file names (RFC-0002 §4).
 *
 * A key is the *only* thing that decides where a file lives, so it is validated strictly and is
 * never derived from a client file name: `tenants/<id>/invoices/0190…-….pdf`. Client names are kept
 * for display only, after sanitising.
 *
 * @module
 */

/** Thrown for a key that could escape the disk root or confuse a driver. */
export class UnsafeKeyError extends Error {
  override readonly name = 'UnsafeKeyError'
}

const SEGMENT = /^[a-z0-9][a-z0-9._=-]{0,127}$/
/** Device names Windows reserves in every folder, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/

/**
 * Validate a key: `/`-separated segments of `[a-z0-9._=-]`, each starting with a letter or digit
 * (so no `.`/`..`, no hidden files), no leading or trailing `/`, no backslashes, no control
 * characters, at most 1024 bytes. Throws {@link UnsafeKeyError}.
 *
 * Keys are **lowercase** and segments may not end with `.` or be a Windows device name (`con`,
 * `nul.txt`, …): on case-insensitive or Windows file systems such keys would alias another file
 * or a device, so two different keys could read or overwrite the same bytes.
 */
export function assertSafeKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024)
    throw new UnsafeKeyError('key must be 1-1024 characters')
  const segments = key.split('/')
  for (const s of segments) {
    if (!SEGMENT.test(s) || s.endsWith('.') || WINDOWS_RESERVED.test(s))
      throw new UnsafeKeyError(`unsafe key segment in "${printable(key)}"`)
  }
}

/** Validate a key prefix used for listing (`""` or a safe key, optionally ending in `/`). */
export function assertSafePrefix(prefix: string): void {
  if (prefix === '') return
  assertSafeKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)
}

function printable(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point.
  return s.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80)
}

/**
 * Sanitise a client file name for display and `Content-Disposition`: NFC-normalised, path parts
 * and control/bidi characters removed, at most 200 characters, never empty.
 */
export function sanitizeFileName(name: string | undefined): string {
  const base = (name ?? '').normalize('NFC').split(/[\\/]/).pop() ?? ''
  const clean = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 200)
  return clean === '' ? 'file' : clean
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
}

/** The file extension for a MIME type, if well known. */
export function extensionFor(mime: string): string | undefined {
  return EXTENSIONS[mime]
}

/** Join key segments, validating the result. */
export function joinKey(...parts: readonly string[]): string {
  const key = parts.filter((p) => p !== '').join('/')
  assertSafeKey(key)
  return key
}
