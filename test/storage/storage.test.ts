import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StorageDisk } from '../../src/contracts/index.ts'
import { FileNotFoundError } from '../../src/storage/body.ts'
import {
  assertSafeKey,
  extensionFor,
  joinKey,
  sanitizeFileName,
  UnsafeKeyError,
} from '../../src/storage/keys.ts'
import { createLocalDisk, localDiskSidecar } from '../../src/storage/local-disk.ts'
import { createStorageManager } from '../../src/storage/manager.ts'
import { createMemoryDisk } from '../../src/storage/memory-disk.ts'
import { detectMime, mimeMatches } from '../../src/storage/mime.ts'
import { signUrl, verifySignedUrl } from '../../src/storage/signing.ts'

const SECRET = 'x'.repeat(32)
const now = () => new Date('2026-11-14T12:00:00.000Z')

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

describe('keys', () => {
  it('accepts safe keys', () => {
    for (const k of ['a', 'tenant-1/invoices/0190a.pdf', 'a/b_c/d=e.txt', 'console/con1.txt'])
      expect(() => assertSafeKey(k)).not.toThrow()
  })
  it('rejects traversal, absolute, backslash, hidden and control-character keys', () => {
    for (const k of [
      '',
      '../etc/passwd',
      'a/../b',
      '/abs',
      'a//b',
      'a/',
      'C:\\x',
      'a\\b',
      '.env',
      'a/.git/x',
      'a\u0000b',
      'a\nb',
      'x'.repeat(1025),
      'a b',
      '%2e%2e/x',
      // aliasing on case-insensitive / Windows file systems
      'A/b.txt',
      'invoices/Report.PDF',
      'a/b.',
      'a./b',
      'con',
      'nul.txt',
      'x/com1',
      'lpt9.log/y',
    ]) {
      expect(() => assertSafeKey(k), JSON.stringify(k)).toThrow(UnsafeKeyError)
    }
  })
  it('never accepts a key with a ".." segment (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', '..', '.', 'b', '', '..%2f'), { minLength: 1, maxLength: 5 }),
        (parts) => {
          const key = parts.join('/')
          if (parts.some((p) => p === '..' || p === '.' || p === '' || p.startsWith('.'))) {
            expect(() => assertSafeKey(key)).toThrow()
          }
        },
      ),
    )
  })
  it('sanitises client file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf')
    expect(sanitizeFileName('evil\u202Efdp.exe')).toBe('evilfdp.exe')
    expect(sanitizeFileName('..hidden')).toBe('hidden')
    expect(sanitizeFileName('')).toBe('file')
    expect(sanitizeFileName(undefined)).toBe('file')
    expect(sanitizeFileName('e\u0301.txt')).toBe('\u00e9.txt')
    expect(sanitizeFileName('x'.repeat(500))).toHaveLength(200)
  })
  it('joins and maps extensions', () => {
    expect(joinKey('a', '', 'b.pdf')).toBe('a/b.pdf')
    expect(() => joinKey('a', '..')).toThrow()
    expect(extensionFor('application/pdf')).toBe('pdf')
    expect(extensionFor('application/x-unknown')).toBeUndefined()
  })
})

describe('MIME sniffing', () => {
  const bytes = (...b: number[]) => new Uint8Array(b)
  const text = (s: string) => new TextEncoder().encode(s)
  it('detects common types from magic bytes', () => {
    expect(detectMime(text('%PDF-1.7\n'))).toBe('application/pdf')
    expect(detectMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png')
    expect(detectMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(detectMime(text('GIF89a...'))).toBe('image/gif')
    expect(detectMime(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
    expect(detectMime(bytes(0x42, 0x4d, ...new Array(14).fill(0)))).toBe('image/bmp')
    expect(detectMime(bytes(0x49, 0x49, 0x2a, 0x00))).toBe('image/tiff')
    expect(detectMime(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('application/zip')
    expect(detectMime(bytes(0x1f, 0x8b, 8))).toBe('application/gzip')
    expect(detectMime(text('MZ\u0090\u0000'))).toBe('application/x-msdownload')
    expect(detectMime(bytes(0x7f, 0x45, 0x4c, 0x46))).toBe('application/x-executable')
    expect(detectMime(bytes(0, 0, 0, 0x18, ...text('ftypmp42')))).toBe('video/mp4')
    expect(detectMime(new Uint8Array())).toBe('application/x-empty')
  })
  it('detects active text content regardless of claims', () => {
    expect(detectMime(text('  <svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBe(
      'image/svg+xml',
    )
    expect(detectMime(text('<?xml version="1.0"?><svg/>'))).toBe('image/svg+xml')
    expect(detectMime(text('\uFEFF<!DOCTYPE html><html>'))).toBe('text/html')
    expect(detectMime(text('<script>alert(1)</script>'))).toBe('text/html')
    expect(detectMime(text('<?xml version="1.0"?><a/>'))).toBe('application/xml')
    expect(detectMime(text('hello, world'))).toBe('text/plain')
    expect(detectMime(text('caf\u00e9').subarray(0, 4))).toBe('text/plain') // cut mid-character
    expect(detectMime(bytes(0xc3, 0x28))).toBe('application/octet-stream')
    expect(detectMime(bytes(0x41, 0x00, 0x42))).toBe('application/octet-stream')
  })
  it('matches allow-lists with wildcards', () => {
    expect(mimeMatches('image/png', ['image/*'])).toBe(true)
    expect(mimeMatches('application/pdf', ['image/*'])).toBe(false)
    expect(mimeMatches('x/y', ['*/*'])).toBe(true)
    expect(mimeMatches('application/pdf', ['application/pdf'])).toBe(true)
  })
})

describe('signed URLs', () => {
  const opts = { secret: SECRET, now: () => 1_000_000_000_000 }
  it('round-trips and rejects tampering, expiry and other methods', () => {
    const url = new URL(
      signUrl('https://x.test/files', 'local', 'a/b c.pdf', 60, opts),
      'https://x.test',
    )
    expect(url.pathname).toBe('/files/a/b%20c.pdf')
    const params = {
      expires: url.searchParams.get('expires'),
      signature: url.searchParams.get('signature'),
    }
    expect(verifySignedUrl('local', 'a/b c.pdf', params, opts)).toBe(true)
    expect(verifySignedUrl('local', 'a/other.pdf', params, opts)).toBe(false)
    expect(verifySignedUrl('s3', 'a/b c.pdf', params, opts)).toBe(false)
    expect(verifySignedUrl('local', 'a/b c.pdf', params, { ...opts, method: 'PUT' })).toBe(false)
    expect(
      verifySignedUrl(
        'local',
        'a/b c.pdf',
        { ...params, expires: String(Number(params.expires) + 1) },
        opts,
      ),
    ).toBe(false)
    expect(
      verifySignedUrl('local', 'a/b c.pdf', params, {
        ...opts,
        now: () => 1_000_000_000_000 + 61_000,
      }),
    ).toBe(false)
    expect(verifySignedUrl('local', 'a/b c.pdf', { expires: null, signature: null }, opts)).toBe(
      false,
    )
    expect(verifySignedUrl('local', 'a/b c.pdf', { ...params, signature: 'short' }, opts)).toBe(
      false,
    )
  })
  it('requires a strong secret and a sane expiry', () => {
    expect(() => signUrl('/f', 'd', 'k', 60, { secret: 'short' })).toThrow(/32 bytes/)
    expect(() => signUrl('/f', 'd', 'k', 0, opts)).toThrow(RangeError)
    expect(() => signUrl('/f', 'd', 'k', 8 * 24 * 3600, opts)).toThrow(RangeError)
  })
})

describe.each(['memory', 'local'] as const)('%s disk', (kind) => {
  let disk: StorageDisk
  let root: string | undefined
  let base: string | undefined
  beforeEach(async () => {
    if (kind === 'local') {
      // The root is a child folder: the disk keeps its sidecars beside it, inside `base`.
      base = await mkdtemp(join(tmpdir(), 'sv-disk-'))
      root = join(base, 'root')
      disk = createLocalDisk({ root, url: '/storage', signingSecret: SECRET, now })
    } else disk = createMemoryDisk({ url: '/storage', signingSecret: SECRET, now })
  })
  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true })
    root = undefined
    base = undefined
  })

  it('puts, stats, reads, lists and deletes with size and sha256', async () => {
    const info = await disk.put('t1/docs/a.txt', 'hello', { contentType: 'text/plain' })
    expect(info).toMatchObject({
      key: 't1/docs/a.txt',
      size: 5,
      contentType: 'text/plain',
      visibility: 'private',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      createdAt: '2026-11-14T12:00:00.000Z',
    })
    expect(await readAll(await disk.get('t1/docs/a.txt'))).toBe('hello')
    expect(await disk.exists('t1/docs/a.txt')).toBe(true)
    expect(await disk.stat('t1/docs/a.txt')).toEqual(info)
    await disk.put('t1/docs/b.bin', new Uint8Array([1, 2, 3]))
    await disk.put('t2/c.txt', new Blob(['streamed']).stream())
    const page1 = await disk.list('t1/', { limit: 1 })
    expect(page1.items.map((i) => i.key)).toEqual(['t1/docs/a.txt'])
    const page2 = await disk.list('t1/', {
      limit: 1,
      ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}),
    })
    expect(page2.items.map((i) => i.key)).toEqual(['t1/docs/b.bin'])
    expect(page2.nextCursor).toBeUndefined()
    expect((await disk.list('')).items).toHaveLength(3)
    await disk.delete('t1/docs/a.txt')
    await disk.delete('t1/docs/a.txt') // idempotent
    expect(await disk.exists('t1/docs/a.txt')).toBe(false)
    expect(await disk.stat('t1/docs/a.txt')).toBeUndefined()
    await expect(disk.get('t1/docs/a.txt')).rejects.toBeInstanceOf(FileNotFoundError)
  })

  it('rejects unsafe keys on every operation', async () => {
    for (const op of [
      () => disk.put('../x', 'a'),
      () => disk.get('../x'),
      () => disk.exists('/etc/passwd'),
      () => disk.stat('a/../../b'),
      () => disk.delete('..'),
      () => disk.list('../'),
      () => disk.temporaryUrl('..\\x'),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(UnsafeKeyError)
    }
  })

  it('serves public URLs only for public files and signs temporary URLs', async () => {
    await disk.put('pub/logo.png', 'x', { visibility: 'public' })
    await disk.put('priv/doc.pdf', 'x')
    expect(await disk.url('pub/logo.png')).toBe('/storage/pub/logo.png')
    await expect(disk.url('priv/doc.pdf')).rejects.toThrow(/no public URL/)
    await expect(disk.url('missing/x')).rejects.toBeInstanceOf(FileNotFoundError)
    const signed = await disk.temporaryUrl('priv/doc.pdf', { expiresInSeconds: 60 })
    expect(signed).toMatch(/^\/storage\/priv\/doc\.pdf\?expires=\d+&signature=/)
  })

  if (kind === 'local') {
    it('writes atomically and keeps metadata out of the key space', async () => {
      const failing = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]))
          c.error(new Error('client went away'))
        },
      })
      await expect(disk.put('x/partial.bin', failing)).rejects.toThrow('client went away')
      expect(await disk.exists('x/partial.bin')).toBe(false)
      expect(await readdir(localDiskSidecar(root as string).tmp)).toEqual([])
      await expect(disk.get('.strutvane-meta/x.json')).rejects.toBeInstanceOf(UnsafeKeyError)
      await disk.put('dir/file.txt', 'a')
      await expect(disk.get('dir')).rejects.toBeInstanceOf(FileNotFoundError)
    })
    it('requires a signing secret for temporary URLs', async () => {
      const plain = createLocalDisk({ root: root as string })
      await expect(plain.temporaryUrl('a.txt')).rejects.toThrow(/signing secret/)
    })
  }
})

describe('storage manager', () => {
  it('resolves disks by name, defaults and rejects duplicates and unknowns', () => {
    const memory = createMemoryDisk()
    const manager = createStorageManager({ default: 'memory', disks: [memory] })
    expect(manager.disk()).toBe(memory)
    expect(manager.disk('memory')).toBe(memory)
    expect(() => manager.disk('s3')).toThrow(/Unknown storage disk "s3"/)
    expect(() => manager.extend(createMemoryDisk())).toThrow(/already registered/)
    manager.extend(createMemoryDisk({ name: 'other' }))
    expect(manager.names()).toEqual(['memory', 'other'])
    expect(() => createStorageManager({ default: 'nope', disks: [] })).toThrow(/not configured/)
  })
})
