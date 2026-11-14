/**
 * Helpers shared by disks: turning any {@link FileBody} into a byte stream while hashing and
 * counting it, so disks never buffer large files and always know size and sha256.
 *
 * @module
 */
import { createHash, type Hash } from 'node:crypto'
import type { FileBody } from '../contracts/index.ts'

/** Thrown by disks when a key does not exist. */
export class FileNotFoundError extends Error {
  override readonly name = 'FileNotFoundError'
  readonly key: string
  constructor(key: string) {
    super(`File not found: ${key}`)
    this.key = key
  }
}

/** A byte stream for a body. */
export function toStream(body: FileBody): ReadableStream<Uint8Array> {
  const source = typeof body === 'string' ? new TextEncoder().encode(body) : body
  if (source instanceof Uint8Array) {
    const bytes = source
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }
  return source
}

/** A pass-through that hashes and counts what flows through it. */
export function measuring(): {
  stream: TransformStream<Uint8Array, Uint8Array>
  result: () => { size: number; sha256: string }
} {
  const hash: Hash = createHash('sha256')
  let size = 0
  let digest: string | undefined
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk)
      size += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  return {
    stream,
    result: () => {
      digest ??= hash.digest('hex')
      return { size, sha256: digest }
    },
  }
}
