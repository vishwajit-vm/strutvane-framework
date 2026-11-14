/**
 * Streaming multipart parsing with limits enforced **while streaming** (RFC-0002 §3).
 *
 * Files are written straight to a temp folder as they arrive, hashed and measured on the fly,
 * and their first bytes are sniffed for the real type. The moment any limit is crossed the
 * request is abandoned: reading stops, every temp file is deleted, and a problem is thrown
 * (`FILE_TOO_LARGE` / `TOO_MANY_FILES` 413, `UPLOAD_INCOMPLETE` 400, `PAYLOAD_TOO_LARGE` 413).
 * Temp files are also deleted when the caller is done (`cleanup()`), whatever happened.
 *
 * @module
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import busboy from 'busboy'
import { StrutvaneError, ValidationError } from '../core/index.ts'
import { sanitizeFileName } from './keys.ts'
import { detectMime, SNIFF_BYTES } from './mime.ts'
import { UploadedFile } from './uploaded-file.ts'

/** Limits for one multipart request. All are enforced during streaming. */
export interface MultipartLimits {
  /** Max bytes per file. Default 25 MB. */
  readonly maxFileSize?: number
  /** Max number of files. Default 10. */
  readonly maxFiles?: number
  /** Max bytes across all files. Default 100 MB. */
  readonly maxTotalSize?: number
  /** Max number of non-file fields. Default 100. */
  readonly maxFields?: number
  /** Max bytes per non-file field value. Default 64 KB. */
  readonly maxFieldSize?: number
  /** Max parts (files + fields). Default 200. */
  readonly maxParts?: number
  /** Allowed file field names. Files in other fields are rejected. Default: any. */
  readonly fileFields?: readonly string[]
  /** Abort when no bytes arrive for this long (stalled uploads). Default 30 s. */
  readonly idleTimeoutMs?: number
  /**
   * Abort when the whole request takes longer than this, however steadily bytes arrive.
   * Default 120 s. Without a total deadline a client sending one byte just before every idle
   * timeout could hold a connection, a parser and temp files open indefinitely.
   */
  readonly totalTimeoutMs?: number
  /** Temp folder. Default the OS temp dir. */
  readonly tempDir?: string
}

/** A parsed multipart request. Call `cleanup()` when done (also safe after `store()`). */
export interface MultipartResult {
  readonly fields: Readonly<Record<string, readonly string[]>>
  readonly files: readonly UploadedFile[]
  /** Files received in one field. */
  file(name: string): UploadedFile | undefined
  filesIn(name: string): UploadedFile[]
  cleanup(): Promise<void>
}

const MB = 1024 * 1024

/** Parse a multipart/form-data request. */
export async function parseMultipart(
  request: Request,
  limits: MultipartLimits = {},
): Promise<MultipartResult> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(type)) {
    throw new StrutvaneError('UNSUPPORTED_MEDIA_TYPE', {
      status: 415,
      params: { expected: 'multipart/form-data' },
    })
  }
  if (!request.body) throw new StrutvaneError('UPLOAD_INCOMPLETE', { status: 400 })
  const maxFileSize = limits.maxFileSize ?? 25 * MB
  const maxFiles = limits.maxFiles ?? 10
  const maxTotal = limits.maxTotalSize ?? 100 * MB
  const dir = join(limits.tempDir ?? tmpdir(), `strutvane-upload-${randomUUID()}`)
  await mkdir(dir, { recursive: true })

  // A prototype-free map: field names like `__proto__` or `constructor` are just names.
  const fields: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  const files: UploadedFile[] = []
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  }

  let parser: busboy.Busboy
  try {
    parser = busboy({
      headers: { 'content-type': type },
      limits: {
        fileSize: maxFileSize,
        files: maxFiles,
        fields: limits.maxFields ?? 100,
        fieldSize: limits.maxFieldSize ?? 64 * 1024,
        parts: limits.maxParts ?? 200,
        headerPairs: 20,
      },
    })
  } catch (error) {
    await cleanup()
    throw new StrutvaneError('UPLOAD_INCOMPLETE', { status: 400, cause: error })
  }

  const source = Readable.fromWeb(
    request.body as import('node:stream/web').ReadableStream<Uint8Array>,
  )
  let total = 0
  let failure: unknown
  const pending: Promise<void>[] = []
  const writers = new Set<WriteStream>()
  const closed: Promise<void>[] = []

  const done = new Promise<void>((resolveDone, rejectDone) => {
    let idle: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(
      () => fail(new StrutvaneError('UPLOAD_INCOMPLETE', { status: 408 })),
      limits.totalTimeoutMs ?? 120_000,
    )
    const resetIdle = (): void => {
      clearTimeout(idle)
      idle = setTimeout(
        () => fail(new StrutvaneError('UPLOAD_INCOMPLETE', { status: 408 })),
        limits.idleTimeoutMs ?? 30_000,
      )
    }
    const fail = (error: unknown): void => {
      if (failure !== undefined) return
      failure = error
      clearTimeout(idle)
      clearTimeout(deadline)
      source.unpipe(parser)
      source.destroy()
      for (const w of writers) w.destroy()
      rejectDone(error)
    }

    parser.on('file', (name, stream, info) => {
      resetIdle()
      if (failure !== undefined) {
        stream.resume()
        return
      }
      if (limits.fileFields && !limits.fileFields.includes(name)) {
        stream.resume()
        fail(new ValidationError([{ path: [name], code: 'unknown_field' }]))
        return
      }
      const tempPath = join(dir, `${files.length + pending.length}-${randomUUID()}`)
      const out = createWriteStream(tempPath, { flags: 'wx' })
      // A disk error, or a write racing `fail()` destroying the stream, must reject the upload,
      // never surface as an uncaught exception.
      out.on('error', (error) =>
        fail(new StrutvaneError('UPLOAD_INCOMPLETE', { status: 400, cause: error })),
      )
      writers.add(out)
      closed.push(new Promise<void>((r) => out.once('close', () => r())))
      const hash = createHash('sha256')
      const head: Buffer[] = []
      let headLength = 0
      let size = 0
      pending.push(
        new Promise<void>((resolveFile) => {
          stream.on('data', (chunk: Buffer) => {
            if (failure !== undefined || out.destroyed) return
            resetIdle()
            size += chunk.length
            total += chunk.length
            if (total > maxTotal) {
              fail(new StrutvaneError('PAYLOAD_TOO_LARGE', { status: 413 }))
              return
            }
            hash.update(chunk)
            if (headLength < SNIFF_BYTES) {
              head.push(chunk.subarray(0, SNIFF_BYTES - headLength))
              headLength += Math.min(chunk.length, SNIFF_BYTES - headLength)
            }
            if (!out.write(chunk)) {
              stream.pause()
              out.once('drain', () => stream.resume())
            }
          })
          stream.on('limit', () =>
            fail(
              new StrutvaneError('FILE_TOO_LARGE', { status: 413, params: { max: maxFileSize } }),
            ),
          )
          stream.on('error', (error) =>
            fail(new StrutvaneError('UPLOAD_INCOMPLETE', { status: 400, cause: error })),
          )
          stream.on('end', () => {
            if (failure !== undefined || out.destroyed) {
              resolveFile()
              return
            }
            out.end(() => {
              writers.delete(out)
              if (failure === undefined) {
                files.push(
                  new UploadedFile({
                    fieldName: name,
                    clientName: sanitizeFileName(info.filename),
                    clientMime: info.mimeType,
                    detectedMime: detectMime(new Uint8Array(Buffer.concat(head))),
                    size,
                    sha256: hash.digest('hex'),
                    tempPath,
                  }),
                )
              }
              resolveFile()
            })
          })
        }),
      )
    })
    parser.on('field', (name, value, info) => {
      resetIdle()
      if (info.valueTruncated) {
        fail(
          new ValidationError([
            { path: [name], code: 'too_long', params: { max: limits.maxFieldSize ?? 64 * 1024 } },
          ]),
        )
        return
      }
      const list = fields[name] ?? []
      list.push(value)
      fields[name] = list
    })
    parser.on('filesLimit', () =>
      fail(new StrutvaneError('TOO_MANY_FILES', { status: 413, params: { max: maxFiles } })),
    )
    parser.on('fieldsLimit', () => fail(new StrutvaneError('PAYLOAD_TOO_LARGE', { status: 413 })))
    parser.on('partsLimit', () => fail(new StrutvaneError('PAYLOAD_TOO_LARGE', { status: 413 })))
    parser.on('error', (error) =>
      fail(new StrutvaneError('UPLOAD_INCOMPLETE', { status: 400, cause: error })),
    )
    parser.on('close', () => {
      clearTimeout(idle)
      clearTimeout(deadline)
      Promise.all(pending).then(() => {
        if (failure === undefined) resolveDone()
      }, fail)
    })
    source.on('error', (error) =>
      fail(new StrutvaneError('UPLOAD_INCOMPLETE', { status: 400, cause: error })),
    )
    source.on('aborted', () => fail(new StrutvaneError('UPLOAD_INCOMPLETE', { status: 400 })))
    // Any received byte counts as progress (not just part boundaries), so a large field or a
    // file header arriving slowly is not mistaken for a stall, and a stall is caught anywhere.
    source.on('data', resetIdle)
    resetIdle()
    source.pipe(parser)
  })

  try {
    await done
  } catch (error) {
    // Wait (briefly) for open temp files to close: Windows cannot delete open files.
    await Promise.race([Promise.allSettled(closed), new Promise((r) => setTimeout(r, 2000))])
    await cleanup()
    throw error
  }
  return {
    fields,
    files,
    file: (name) => files.find((f) => f.fieldName === name),
    filesIn: (name) => files.filter((f) => f.fieldName === name),
    cleanup,
  }
}
