/**
 * Storage and upload attacks: slow uploads, prototype-polluting field names, active-content
 * polyglots and wildcard allow-lists, cross-tenant keys, and signed-link misuse.
 */
import { createHmac } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStorageManager } from '../../src/storage/manager.ts'
import { createMemoryDisk } from '../../src/storage/memory-disk.ts'
import { ACTIVE_CONTENT, detectMime, mimeMatches } from '../../src/storage/mime.ts'
import { parseMultipart } from '../../src/storage/multipart.ts'
import { serveSignedFile } from '../../src/storage/serve-signed.ts'
import { signUrl } from '../../src/storage/signing.ts'
import { tenantDisk, tenantPrefix } from '../../src/storage/tenant-disk.ts'
import { createTestApp } from '../../src/testing/index.ts'
import { Customer, Invoice } from '../helpers/models.ts'
import { TENANT_A, TENANT_B } from '../helpers/setup.ts'

const SECRET = 's'.repeat(32)
const enc = (s: string) => new TextEncoder().encode(s)

let temp: string
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sv-hard-'))
})
afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

/** A multipart body delivered in timed chunks. */
function dripped(chunks: readonly string[], everyMs: number, boundary = 'XYZ'): Request {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i >= chunks.length) {
        c.close()
        return
      }
      await new Promise((r) => setTimeout(r, everyMs))
      c.enqueue(enc(chunks[i++] as string))
    },
  })
  return new Request('http://x.test', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: 'half',
  } as RequestInit)
}

describe('multipart hardening', () => {
  it('a steady trickle cannot outlast the total upload deadline', async () => {
    const chunks = [
      '--XYZ\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\n',
      ...Array.from({ length: 50 }, () => 'a'),
    ]
    await expect(
      parseMultipart(dripped(chunks, 20), {
        tempDir: temp,
        idleTimeoutMs: 1000,
        totalTimeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: 'upload_incomplete', status: 408 })
    expect(await readdir(temp)).toEqual([])
  })

  it('any received byte counts as progress for the idle timer (slow but alive uploads pass)', async () => {
    const chunks = [
      '--XYZ\r\nContent-Disposition: form-data; name="note"\r\n\r\n',
      ...Array.from({ length: 8 }, () => 'abcd'),
      '\r\n--XYZ--\r\n',
    ]
    const result = await parseMultipart(dripped(chunks, 30), { tempDir: temp, idleTimeoutMs: 120 })
    expect(result.fields['note']).toEqual(['abcd'.repeat(8)])
    await result.cleanup()
  })

  it('field names like __proto__ and constructor are plain names (no prototype pollution)', async () => {
    const body =
      '--XYZ\r\nContent-Disposition: form-data; name="__proto__"\r\n\r\nx\r\n' +
      '--XYZ\r\nContent-Disposition: form-data; name="constructor"\r\n\r\ny\r\n--XYZ--\r\n'
    const result = await parseMultipart(dripped([body], 0), { tempDir: temp })
    expect(Object.getPrototypeOf(result.fields)).toBeNull()
    expect(Object.getOwnPropertyDescriptor(result.fields, '__proto__')?.value).toEqual(['x'])
    expect(result.fields['constructor']).toEqual(['y'])
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
    await result.cleanup()
  })
})

describe('active content', () => {
  it('detects markup anywhere in the sniffed head, in any case', () => {
    expect(detectMime(enc('hello there\n<SCRIPT>alert(1)</SCRIPT>'))).toBe('text/html')
    expect(detectMime(enc('<!-- harmless -->\n<svg xmlns="http://www.w3.org/2000/svg">'))).toBe(
      'image/svg+xml',
    )
    expect(detectMime(enc('name,value\n1,<iframe src=x>'))).toBe('text/html')
    expect(detectMime(enc('plain notes about svg and html'))).toBe('text/plain')
  })

  it('image/* (and */*) never allow SVG or other active content; naming it explicitly does', () => {
    for (const mime of ACTIVE_CONTENT) {
      expect(mimeMatches(mime, ['image/*', 'text/*', 'application/*', '*/*']), mime).toBe(false)
      expect(mimeMatches(mime, [mime])).toBe(true)
    }
    expect(mimeMatches('image/png', ['image/*'])).toBe(true)
    expect(mimeMatches('application/pdf', ['*/*'])).toBe(true)
  })
})

describe('tenant-scoped disks', () => {
  it("a tenant can neither read nor list another tenant's files", async () => {
    const shared = createMemoryDisk({ name: 'memory' })
    const a = tenantDisk(shared, TENANT_A)
    const b = tenantDisk(shared, TENANT_B)
    const stored = await a.put('invoices/1.pdf', 'A-data')
    expect(stored.key).toBe('invoices/1.pdf')
    expect(await shared.exists(`${tenantPrefix(TENANT_A)}invoices/1.pdf`)).toBe(true)
    expect(await b.exists('invoices/1.pdf')).toBe(false)
    expect(await b.stat('invoices/1.pdf')).toBeUndefined()
    expect((await b.list('')).items).toEqual([])
    expect((await a.list('invoices/')).items.map((f) => f.key)).toEqual(['invoices/1.pdf'])
    expect((await a.stat('invoices/1.pdf'))?.key).toBe('invoices/1.pdf')
    await expect(a.put('../x', 'y')).rejects.toThrow()
    expect(() => tenantDisk(shared, '../other')).toThrow(/UUID/)
    await a.put('invoices/2.pdf', 'more')
    const page = await a.list('invoices/', { limit: 1 })
    expect(page.nextCursor).toBe('invoices/1.pdf')
    const cursor = page.nextCursor ?? ''
    expect((await a.list('invoices/', { cursor })).items.map((f) => f.key)).toEqual([
      'invoices/2.pdf',
    ])
    await a.delete('invoices/1.pdf')
    expect(await shared.exists(`${tenantPrefix(TENANT_A)}invoices/1.pdf`)).toBe(false)
  })

  it('the manager hands out tenant disks', async () => {
    const storage = createStorageManager({ default: 'memory', disks: [createMemoryDisk()] })
    await storage.forTenant(TENANT_A).put('x.txt', 'a')
    expect(await storage.disk().exists(`${tenantPrefix(TENANT_A)}x.txt`)).toBe(true)
  })
})

describe('signed file links', () => {
  const disk = createMemoryDisk({ name: 'files', signingSecret: SECRET })
  const now = () => Date.parse('2026-11-14T12:00:00Z')

  it('signatures use a derived subkey, not the raw secret', () => {
    const url = new URL(signUrl('http://x.test/f', 'files', 'a.txt', 60, { secret: SECRET, now }))
    const raw = createHmac('sha256', SECRET)
      .update(`GET\nfiles\na.txt\n${url.searchParams.get('expires')}`)
      .digest('base64url')
    expect(url.searchParams.get('signature')).not.toBe(raw)
  })

  it('serves a valid link, refuses tampering, traversal and other methods', async () => {
    await disk.put('docs/a.txt', 'hello', { contentType: 'text/plain' })
    await disk.put('docs/logo.svg', '<svg onload="alert(1)"/>', { contentType: 'image/svg+xml' })
    const link = (key: string) =>
      new URL(signUrl('http://x.test/storage/files', 'files', key, 60, { secret: SECRET, now }))
    const opts = { disk, secret: SECRET, now }
    const ok = await serveSignedFile(new Request(link('docs/a.txt')), opts)
    expect(await ok.text()).toBe('hello')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-security-policy')).toContain('sandbox')
    const svg = await serveSignedFile(new Request(link('docs/logo.svg')), opts)
    expect(svg.headers.get('content-type')).toBe('application/octet-stream')
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment/)
    const head = await serveSignedFile(new Request(link('docs/a.txt'), { method: 'HEAD' }), opts)
    expect(head.body).toBeNull()
    const tampered = link('docs/a.txt')
    tampered.pathname = '/storage/files/docs/logo.svg'
    await expect(serveSignedFile(new Request(tampered), opts)).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      serveSignedFile(
        new Request('http://x.test/storage/files/..%2fx?expires=1&signature=x'),
        opts,
      ),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      serveSignedFile(new Request('http://x.test/other/docs/a.txt'), opts),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      serveSignedFile(new Request(link('docs/a.txt'), { method: 'POST' }), opts),
    ).rejects.toMatchObject({ status: 405 })
    await expect(serveSignedFile(new Request(link('docs/gone.txt')), opts)).rejects.toMatchObject({
      status: 404,
    })
  })

  it('active content stays an attachment however its type is spelled (parameters, case, +xml)', async () => {
    const link = (key: string) =>
      new URL(signUrl('http://x.test/storage/files', 'files', key, 60, { secret: SECRET, now }))
    const spellings = [
      'text/html; charset=utf-8',
      'Text/HTML',
      ' image/svg+xml ',
      'application/rss+xml',
      '',
    ]
    for (const [index, contentType] of spellings.entries()) {
      const key = `docs/active-${index}.bin`
      await disk.put(key, '<script>alert(1)</script>', { contentType })
      const served = await serveSignedFile(new Request(link(key)), { disk, secret: SECRET, now })
      expect(served.headers.get('content-type'), contentType).toBe('application/octet-stream')
      expect(served.headers.get('content-disposition'), contentType).toMatch(/^attachment/)
    }
  })

  it('createHttpApp mounts signed links with problem responses', async () => {
    await disk.put('docs/b.txt', 'via app', { contentType: 'text/plain' })
    const t = await createTestApp({
      resources: [Customer, Invoice],
      http: { signedFiles: [{ disk, secret: SECRET }] },
    })
    try {
      const url = new URL(await disk.temporaryUrl('docs/b.txt'), 'http://x.test')
      const res = await t.http.request(`${url.pathname}${url.search}`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('via app')
      const bad = await t.http.request(`${url.pathname}?expires=1&signature=nope`)
      expect(bad.status).toBe(403)
      expect(bad.headers.get('content-type')).toBe('application/problem+json')
    } finally {
      await t.close()
    }
  })
})
