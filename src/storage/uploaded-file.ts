/**
 * `UploadedFile`: one file from a multipart request, already on local temp storage, measured,
 * hashed and type-sniffed. `store()` moves it onto a disk under a generated key; the client file
 * name is kept for display only (RFC-0002).
 *
 * @module
 */
import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { FileVisibility, StoredFile } from '../contracts/index.ts'
import type { IssueInput } from '../core/index.ts'
import { extensionFor, joinKey } from './keys.ts'
import type { StorageManager } from './manager.ts'
import { mimeMatches } from './mime.ts'

/** Validation rules for one uploaded file (RFC-0002 "basic rules"). */
export interface FileRules {
  /** Allowed detected MIME types (`image/*` wildcards allowed). */
  readonly accept?: readonly string[]
  /** Maximum size in bytes. */
  readonly maxSize?: number
  /** Minimum size in bytes. Default 1 (empty files are rejected). */
  readonly minSize?: number
}

/** Options for {@link UploadedFile.store}. */
export interface StoreOptions {
  readonly storage: StorageManager
  readonly disk?: string
  readonly visibility?: FileVisibility
  /** Key generator (UUIDv7 recommended). */
  readonly id: () => string
  /**
   * Store under the tenant's prefix (`tenants/<tenantId>/…`, see `StorageManager.forTenant`).
   * Pass it for every tenant-owned upload; the returned `key` is relative to that prefix.
   */
  readonly tenantId?: string
}

/** A file received in a multipart request. */
export class UploadedFile {
  /** The form field it arrived in. */
  readonly fieldName: string
  /** Sanitised client file name, for display only. */
  readonly clientName: string
  /** What the browser claimed. Informational only; never trusted. */
  readonly clientMime: string
  /** What the bytes say. This is what validation and storage use. */
  readonly detectedMime: string
  readonly size: number
  readonly sha256: string
  /** @internal temp file location */
  readonly tempPath: string

  constructor(init: {
    fieldName: string
    clientName: string
    clientMime: string
    detectedMime: string
    size: number
    sha256: string
    tempPath: string
  }) {
    this.fieldName = init.fieldName
    this.clientName = init.clientName
    this.clientMime = init.clientMime
    this.detectedMime = init.detectedMime
    this.size = init.size
    this.sha256 = init.sha256
    this.tempPath = init.tempPath
  }

  /** Read the contents as a stream. */
  stream(): ReadableStream<Uint8Array> {
    return Readable.toWeb(createReadStream(this.tempPath)) as ReadableStream<Uint8Array>
  }

  /** Validate against rules; returns RFC-0003 issues (empty when valid). */
  validate(rules: FileRules): IssueInput[] {
    const issues: IssueInput[] = []
    const path = [this.fieldName]
    if (this.size < (rules.minSize ?? 1)) issues.push({ path, code: 'file_empty' })
    if (rules.maxSize !== undefined && this.size > rules.maxSize) {
      issues.push({ path, code: 'file_too_large', params: { max: formatBytes(rules.maxSize) } })
    }
    if (rules.accept && !mimeMatches(this.detectedMime, rules.accept)) {
      issues.push({
        path,
        code: 'file_type_not_allowed',
        params: { accept: rules.accept.join(', ') },
      })
    }
    return issues
  }

  /** Store under `<directory>/<id>.<ext>` on a disk. The key never contains the client name. */
  async store(directory: string, options: StoreOptions): Promise<StoredFile> {
    const ext = extensionFor(this.detectedMime)
    const key = joinKey(directory, `${options.id().toLowerCase()}${ext ? `.${ext}` : ''}`)
    const disk =
      options.tenantId !== undefined
        ? options.storage.forTenant(options.tenantId, options.disk)
        : options.storage.disk(options.disk)
    const stored = await disk.put(key, this.stream(), {
      contentType: this.detectedMime,
      ...(options.visibility ? { visibility: options.visibility } : {}),
    })
    return { ...stored, originalName: this.clientName }
  }

  /** Delete the temp file (idempotent). */
  async discard(): Promise<void> {
    await rm(this.tempPath, { force: true })
  }
}

/** `10485760` → `10 MB`. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`
  if (n >= 1024 * 1024) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`
  if (n >= 1024) return `${Math.round((n / 1024) * 10) / 10} KB`
  return `${n} B`
}

/** `'10MB'` / `'512KB'` / `1024` → bytes. */
export function parseBytes(value: string | number): number {
  if (typeof value === 'number') return value
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i.exec(value.trim())
  if (!m) throw new RangeError(`Invalid size "${value}" (use e.g. "10MB")`)
  const unit = (m[2] as string).toUpperCase()
  const factor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
  return Math.floor(Number(m[1]) * factor)
}
