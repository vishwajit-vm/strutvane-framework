/**
 * Which stored files a browser may render inline: an allow-list of display-only types, and a
 * stored type that can never split a header or carry a second type past the check.
 */
import { describe, expect, it } from 'vitest'
import { createMemoryDisk } from '../../src/storage/memory-disk.ts'
import {
  assertStorableContentType,
  isStorableContentType,
  servedType,
} from '../../src/storage/mime.ts'
import { serveSignedFile } from '../../src/storage/serve-signed.ts'
import { signUrl } from '../../src/storage/signing.ts'

const SECRET = 's'.repeat(32)
const now = () => 1_700_000_000_000

describe('servedType: inline only for display-only types', () => {
  it.each([
    ['image/png', 'image/png'],
    ['IMAGE/JPEG', 'image/jpeg'],
    ['application/pdf', 'application/pdf'],
    ['video/mp4', 'video/mp4'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['text/plain; charset=latin1', 'text/plain; charset=utf-8'],
  ])('%s is inline as %s (never a stored parameter)', (stored, sent) => {
    expect(servedType(stored)).toEqual({ contentType: sent, disposition: 'inline' })
  })

  it.each([
    'text/html',
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'application/ecmascript',
    'text/jscript',
    'module/javascript',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/xsl',
    'application/rss+xml',
    'application/x-shockwave-flash',
    'application/wasm',
    'text/css',
    'multipart/x-mixed-replace',
    'application/json',
    'x/y,text/html',
    'image/png, text/html',
    'image/png; a="b"',
    "image/png'",
    'image/png\\',
    'image/png\r\nSet-Cookie: a=1',
    'image/png\u0000',
    'nonsense',
    '',
    `image/${'a'.repeat(300)}`,
  ])('%j is an octet-stream attachment', (stored) => {
    expect(servedType(stored)).toEqual({
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    })
  })
})

describe('stored content types are one plain media type', () => {
  it('accepts a type with token parameters and refuses lists, quotes and control characters', () => {
    expect(isStorableContentType('image/png')).toBe(true)
    expect(isStorableContentType('text/plain; charset=utf-8')).toBe(true)
    for (const value of [
      'x/y,text/html',
      'text/plain; charset="utf-8"',
      "text/plain; charset='x'",
      'text/plain\\',
      'text/plain\r\nX: 1',
      'text/plain\u007f',
      'text/plain; =x',
      'textplain',
      '/png',
    ])
      expect(isStorableContentType(value), JSON.stringify(value)).toBe(false)
  })

  it('assertStorableContentType allows "unknown" (undefined or empty) and throws a hint otherwise', () => {
    expect(() => assertStorableContentType(undefined)).not.toThrow()
    expect(() => assertStorableContentType('')).not.toThrow()
    expect(() => assertStorableContentType('x/y,text/html')).toThrow(/one media type/)
  })

  it('a disk refuses to store a type that could smuggle a second one, before writing', async () => {
    const disk = createMemoryDisk({ name: 'files' })
    await expect(
      disk.put('docs/a.bin', 'x', { contentType: 'image/png,text/html' }),
    ).rejects.toThrow(/one media type/)
    expect(await disk.exists('docs/a.bin')).toBe(false)
  })

  it('a signed link serves an image inline and markup as a download', async () => {
    const disk = createMemoryDisk({ name: 'files' })
    await disk.put('docs/pic.png', 'png', { contentType: 'image/png' })
    await disk.put('docs/page.js', 'alert(1)', { contentType: 'text/javascript' })
    const serve = (key: string) =>
      serveSignedFile(
        new Request(
          new URL(
            signUrl('http://x.test/storage/files', 'files', key, 60, { secret: SECRET, now }),
          ),
        ),
        { disk, secret: SECRET, now },
      )
    const image = await serve('docs/pic.png')
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('content-disposition')).toMatch(/^inline/)
    const script = await serve('docs/page.js')
    expect(script.headers.get('content-type')).toBe('application/octet-stream')
    expect(script.headers.get('content-disposition')).toMatch(/^attachment/)
  })
})
