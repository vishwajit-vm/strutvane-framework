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
