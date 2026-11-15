/**
 * Upload attack tests: limits enforced while streaming, MIME spoofing, path traversal in file
 * names, and temp-file cleanup on every path.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUuidV7Generator, StrutvaneError, ValidationError } from '../../src/core/index.ts'
import { createStorageManager, type StorageManager } from '../../src/storage/manager.ts'
import { createMemoryDisk } from '../../src/storage/memory-disk.ts'
import { type MultipartLimits, parseMultipart } from '../../src/storage/multipart.ts'
import { formatBytes, parseBytes } from '../../src/storage/uploaded-file.ts'

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n')
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

let temp: string
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sv-up-'))
})
afterEach(async () => {
  await rm(temp, { recursive: true, force: true })
})

/**
 * Encode a form to bytes first: a FormData request body is generated lazily by undici, which
 * throws an unhandled rejection when the parser cancels it mid-stream (a test artefact; real
 * servers stream bodies from the socket).
 */
async function form(
  parts: {
    name: string
    value?: string
    file?: { bytes: Uint8Array; filename: string; type?: string }
  }[],
): Promise<Request> {
  const fd = new FormData()
  for (const p of parts) {
    if (p.file)
      fd.append(
        p.name,
        new Blob([p.file.bytes as Uint8Array<ArrayBuffer>], {
          type: p.file.type ?? 'application/octet-stream',
        }),
        p.file.filename,
      )
    else fd.append(p.name, p.value ?? '')
  }
  const encoded = new Response(fd)
  const type = encoded.headers.get('content-type') as string
  return new Request('http://x.test/upload', {
    method: 'POST',
    body: await encoded.arrayBuffer(),
    headers: { 'content-type': type },
  })
}

const parse = async (req: Request | Promise<Request>, limits: MultipartLimits = {}) =>
  parseMultipart(await req, { tempDir: temp, ...limits })

describe('parseMultipart', () => {
  let storage: StorageManager
  beforeEach(() => {
    storage = createStorageManager({ default: 'memory', disks: [createMemoryDisk()] })
  })

  it('parses fields and files, sniffs the real type and hashes on the fly', async () => {
    const result = await parse(
      form([
        { name: 'title', value: 'Q3 report' },
        { name: 'doc', file: { bytes: PDF, filename: '../../etc/passwd.pdf', type: 'image/png' } },
      ]),
    )
    expect(result.fields).toEqual({ title: ['Q3 report'] })
    const doc = result.file('doc')
    expect(doc).toMatchObject({
      fieldName: 'doc',
      clientName: 'passwd.pdf',
      clientMime: 'image/png',
      detectedMime: 'application/pdf',
      size: PDF.length,
    })
    expect(doc?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.filesIn('doc')).toHaveLength(1)
    expect(result.file('nope')).toBeUndefined()

    const stored = await doc?.store('tenant-a/invoices', { storage, id: createUuidV7Generator() })
    expect(stored?.key).toMatch(/^tenant-a\/invoices\/[0-9a-f-]{36}\.pdf$/)
    expect(stored?.key).not.toContain('passwd')
    expect(stored).toMatchObject({
      contentType: 'application/pdf',
      originalName: 'passwd.pdf',
      sha256: doc?.sha256,
    })
    expect(await new Response(await storage.disk().get(stored?.key as string)).text()).toBe(
      new TextDecoder().decode(PDF),
    )
    await result.cleanup()
    expect(await readdir(temp)).toEqual([])
  })

  it('rejects an executable renamed to .pdf (MIME spoofing) via validation', async () => {
    const result = await parse(
      form([
        { name: 'doc', file: { bytes: EXE, filename: 'invoice.pdf', type: 'application/pdf' } },
      ]),
    )
    const doc = result.file('doc')
    expect(doc?.detectedMime).toBe('application/x-msdownload')
    expect(doc?.validate({ accept: ['application/pdf'] })).toEqual([
      { path: ['doc'], code: 'file_type_not_allowed', params: { accept: 'application/pdf' } },
    ])
    expect(result.file('doc')?.validate({ accept: ['image/*'], maxSize: 4 })).toHaveLength(2)
    await result.cleanup()
  })

  it('rejects SVG with scripts claimed as PNG', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    const result = await parse(
      form([{ name: 'img', file: { bytes: svg, filename: 'cat.png', type: 'image/png' } }]),
    )
    expect(result.file('img')?.detectedMime).toBe('image/svg+xml')
    expect(result.file('img')?.validate({ accept: ['image/png', 'image/jpeg'] })[0]?.code).toBe(
      'file_type_not_allowed',
    )
    await result.cleanup()
  })

  it('rejects empty files unless allowed', async () => {
    const result = await parse(
      form([{ name: 'f', file: { bytes: new Uint8Array(), filename: 'e.txt' } }]),
    )
    expect(result.file('f')?.validate({})).toEqual([{ path: ['f'], code: 'file_empty' }])
    expect(result.file('f')?.validate({ minSize: 0 })).toEqual([])
    await result.file('f')?.discard()
    await result.cleanup()
  })

  it('stops at the per-file size limit while streaming and cleans up', async () => {
    const big = new Uint8Array(200_000).fill(65)
    const err = await parse(form([{ name: 'f', file: { bytes: big, filename: 'big.txt' } }]), {
      maxFileSize: 1000,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StrutvaneError)
    expect((err as StrutvaneError).code).toBe('FILE_TOO_LARGE')
    expect((err as StrutvaneError).status).toBe(413)
    expect(await readdir(temp)).toEqual([])
  })

  it('stops when the total size is exceeded', async () => {
    const chunk = new Uint8Array(6000).fill(66)
    const err = await parse(
      form([
        { name: 'a', file: { bytes: chunk, filename: 'a.txt' } },
        { name: 'b', file: { bytes: chunk, filename: 'b.txt' } },
      ]),
      { maxTotalSize: 8000 },
    ).catch((e: unknown) => e)
    expect((err as StrutvaneError).code).toBe('PAYLOAD_TOO_LARGE')
    expect(await readdir(temp)).toEqual([])
  })

  it('stops at the file count limit', async () => {
    const err = await parse(
      form([
        { name: 'a', file: { bytes: PNG, filename: 'a.png' } },
        { name: 'b', file: { bytes: PNG, filename: 'b.png' } },
        { name: 'c', file: { bytes: PNG, filename: 'c.png' } },
      ]),
      { maxFiles: 2 },
    ).catch((e: unknown) => e)
    expect((err as StrutvaneError).code).toBe('TOO_MANY_FILES')
    expect(await readdir(temp)).toEqual([])
  })

  it('rejects files in unexpected fields and oversized field values', async () => {
    const unknown = await parse(form([{ name: 'evil', file: { bytes: PNG, filename: 'a.png' } }]), {
      fileFields: ['avatar'],
    }).catch((e: unknown) => e)
    expect(unknown).toBeInstanceOf(ValidationError)
    expect((unknown as ValidationError).issues).toEqual([{ path: ['evil'], code: 'unknown_field' }])
    const longField = await parse(form([{ name: 'note', value: 'x'.repeat(2000) }]), {
      maxFieldSize: 100,
    }).catch((e: unknown) => e)
    expect(longField).toBeInstanceOf(ValidationError)
    const manyFields = await parse(
      form([
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
      ]),
      { maxFields: 1 },
    ).catch((e: unknown) => e)
    expect((manyFields as StrutvaneError).code).toBe('PAYLOAD_TOO_LARGE')
    expect(await readdir(temp)).toEqual([])
  })

  it('rejects non-multipart and truncated bodies', async () => {
    const json = new Request('http://x.test', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })
    await expect(parse(json)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 })
    const noBody = new Request('http://x.test', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    })
    await expect(parse(noBody)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' })
    const truncated = new Request('http://x.test', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=XYZ' },
      body: '--XYZ\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\nhello',
    })
    await expect(parse(truncated)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' })
    const badBoundary = new Request('http://x.test', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; nope' },
      body: 'x',
    })
    await expect(parse(badBoundary)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' })
    expect(await readdir(temp)).toEqual([])
  })

  it('aborts slow-drip uploads after the idle timeout', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            '--XYZ\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\nhel',
          ),
        )
      },
    })
    const req = new Request('http://x.test', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=XYZ' },
      body,
      duplex: 'half',
    } as RequestInit)
    await expect(parse(req, { idleTimeoutMs: 50 })).rejects.toMatchObject({
      code: 'UPLOAD_INCOMPLETE',
      status: 408,
    })
    expect(await readdir(temp)).toEqual([])
  })
})

describe('sizes', () => {
  it('parses and formats byte sizes', () => {
    expect(parseBytes('10MB')).toBe(10 * 1024 * 1024)
    expect(parseBytes('1.5 kb')).toBe(1536)
    expect(parseBytes('2GB')).toBe(2 * 1024 ** 3)
    expect(parseBytes('12B')).toBe(12)
    expect(parseBytes(42)).toBe(42)
    expect(() => parseBytes('lots')).toThrow(RangeError)
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB')
  })
})

describe('parseMultipart leaves nothing running', () => {
  it('a rejected upload leaves no timer behind (nothing delays shutdown or piles up per request)', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    const before = timers()
    for (let i = 0; i < 5; i++) {
      await expect(
        parse(form([{ name: 'f', file: { bytes: EXE, filename: 'a.exe' } }]), { maxFiles: 0 }),
      ).rejects.toMatchObject({ code: 'TOO_MANY_FILES' })
    }
    expect(timers()).toBeLessThanOrEqual(before)
  })
})
