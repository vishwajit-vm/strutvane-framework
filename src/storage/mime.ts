/**
 * MIME detection from file contents ("magic bytes"), never from the extension or the browser's
 * `Content-Type`, which are attacker-controlled (RFC-0002: a renamed `.exe` posing as `.pdf`).
 *
 * Detection looks at the first {@link SNIFF_BYTES} bytes. Anything unrecognised is
 * `application/octet-stream`, which no allow-list should contain by accident.
 *
 * @module
 */

/** How many leading bytes detection needs. */
export const SNIFF_BYTES = 512

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v)

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** Detect a MIME type from the first bytes of a file. */
export function detectMime(head: Uint8Array): string {
  if (head.length === 0) return 'application/x-empty'
  if (startsWith(head, ascii('%PDF-'))) return 'application/pdf'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(head, ascii('BM')) && head.length >= 14) return 'image/bmp'
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff'
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]))
    return 'application/zip'
  if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip'
  if (startsWith(head, ascii('MZ'))) return 'application/x-msdownload'
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-executable'
  if (startsWith(head, ascii('ftyp'), 4)) return 'video/mp4'
  return detectText(head)
}

function detectText(head: Uint8Array): string {
  if (head.includes(0)) return 'application/octet-stream'
  let text: string
  try {
    // Incomplete trailing sequences are allowed: the head may cut a character in half.
    text = new TextDecoder('utf-8', { fatal: true }).decode(trimPartialUtf8(head))
  } catch {
    return 'application/octet-stream'
  }
  const lower = text.replace(/^﻿/, '').toLowerCase()
  const start = lower.trimStart()
  // Browsers sniff markup anywhere near the start, not just at byte 0 (a "text" file with a
  // harmless first line and `<script>` further down is still HTML to a sniffing browser), so the
  // whole sniffed head is scanned for active markup.
  if (start.startsWith('<svg') || /<svg[\s>/]/.test(lower)) return 'image/svg+xml'
  if (
    /<(!doctype\s+html|html|head|body|script|iframe|object|embed|img|meta|link|style)[\s>/]/.test(
      lower,
    )
  )
    return 'text/html'
  if (start.startsWith('<?xml')) return 'application/xml'
  return 'text/plain'
}

/** Drop an incomplete UTF-8 sequence at the end of a buffer. */
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let end = b.length
  for (let i = b.length - 1; i >= Math.max(0, b.length - 4); i--) {
    const byte = b[i] as number
    if ((byte & 0xc0) === 0x80) continue // continuation byte
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    if (b.length - i < need) end = i
    break
  }
  return b.subarray(0, end)
}

/** Types that can run script when served inline; never serve these inline from your origin. */
export const ACTIVE_CONTENT: ReadonlySet<string> = new Set([
  'text/html',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/xhtml+xml',
  'text/javascript',
  'application/javascript',
])

/**
 * Whether a stored content type is active content, however it is spelled: parameters
 * (`text/html; charset=utf-8`), case (`Text/HTML`) and whitespace are ignored, so a declared type
 * can never slip past {@link ACTIVE_CONTENT} and be served inline.
 *
 * @example
 * isActiveContent('text/html; charset=utf-8') // true
 */
export function isActiveContent(contentType: string): boolean {
  const essence = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return ACTIVE_CONTENT.has(essence) || essence.endsWith('+xml') || essence === ''
}

/**
 * Whether `mime` matches an allow-list entry (`application/pdf`, `image/*`, `*\/*`).
 *
 * Wildcards never match {@link ACTIVE_CONTENT}: `image/*` is meant as "pictures", and an SVG
 * (which can carry script) must be allowed by naming `image/svg+xml` explicitly. Serve allowed
 * active content only as an attachment with `X-Content-Type-Options: nosniff` (see
 * `serveSignedFile`), or from a separate origin.
 */
export function mimeMatches(mime: string, accept: readonly string[]): boolean {
  return accept.some((a) => {
    if (a === mime) return true
    if (ACTIVE_CONTENT.has(mime)) return false
    if (a === '*/*') return true
    if (a.endsWith('/*')) return mime.startsWith(a.slice(0, -1))
    return false
  })
}

/**
 * Types a stored file may be served **inline** as, from the app's own origin: things a browser
 * only displays (raster images, PDF, plain text, audio, video). Everything else, including every
 * type nobody thought of yet, is a download. An allow-list, because a deny-list of "active"
 * types always misses one (a new `+xml`, `text/xsl`, `application/x-shockwave-flash`…).
 */
export const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/pdf',
  'text/plain',
])

/** Audio and video families are display-only too (no script in either). */
const INLINE_FAMILIES = ['audio/', 'video/'] as const

/** A media type token (RFC 9110 `token`): letters, digits and `!#$%&'*+.^_`|~-` minus quotes. */
const TYPE_ESSENCE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/

/** How a stored file is sent: the `Content-Type` and the `Content-Disposition` kind. */
export interface ServedType {
  readonly contentType: string
  readonly disposition: 'inline' | 'attachment'
}

/**
 * How to serve a file stored with `stored` as its type. Inline only for {@link INLINE_TYPES} and
 * audio/video, sent as the bare type (plus `charset=utf-8` for text, never a stored parameter);
 * anything else, and any type with a comma, a quote, a control character or no valid essence,
 * becomes an `application/octet-stream` attachment. The stored string never reaches a header.
 *
 * @example
 * servedType('image/png')                 // { contentType: 'image/png', disposition: 'inline' }
 * servedType('text/html; charset=utf-8')  // { contentType: 'application/octet-stream', disposition: 'attachment' }
 * servedType('image/png, text/html')      // attachment: two types in one header
 */
export function servedType(stored: string): ServedType {
  const download: ServedType = {
    contentType: 'application/octet-stream',
    disposition: 'attachment',
  }
  if (!isStorableContentType(stored)) return download
  const essence = stored.split(';')[0]?.trim().toLowerCase() ?? ''
  const inline =
    INLINE_TYPES.has(essence) || INLINE_FAMILIES.some((family) => essence.startsWith(family))
  if (!inline || isActiveContent(essence)) return download
  return {
    contentType: essence === 'text/plain' ? 'text/plain; charset=utf-8' : essence,
    disposition: 'inline',
  }
}

/**
 * Whether a content type may be stored: one type (`type/subtype`, optional `; key=value`
 * parameters), at most 255 characters, and no comma, quote, backslash or control character
 * (each could split a header or smuggle a second type past a check).
 *
 * @example
 * isStorableContentType('image/png') // true
 * isStorableContentType('text/plain\r\nSet-Cookie: x=1') // false
 */
export function isStorableContentType(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (value.length > 255 || /[,"'\\\u0000-\u001f\u007f]/.test(value)) return false
  const [essence = '', ...parameters] = value.split(';')
  if (!TYPE_ESSENCE.test(essence.trim().toLowerCase())) return false
  return parameters.every((parameter) =>
    /^\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+\s*$/i.test(parameter),
  )
}

/**
 * Refuse a content type that {@link isStorableContentType} rejects, before anything is written.
 * An empty string means "unknown" (as `undefined` does) and is allowed: {@link servedType}
 * always sends such a file as an `application/octet-stream` download.
 *
 * @example
 * assertStorableContentType(put.contentType)
 */
export function assertStorableContentType(value: string | undefined): void {
  if (value === undefined || value === '' || isStorableContentType(value)) return
  throw new TypeError(
    'contentType must be one media type such as "image/png" (no comma, quote or control character).',
  )
}
