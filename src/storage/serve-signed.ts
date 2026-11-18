/**
 * Serving files behind signed, expiring URLs (`disk.temporaryUrl(key)`): the route that checks
 * the signature, then streams the file with headers that keep it from running in the app's
 * origin.
 *
 * - Only `GET` and `HEAD`, verified as `GET` (the method the URL was signed for).
 * - The key comes from the path below `prefix`, is URL-decoded per segment and validated like any
 *   other key; anything odd is a 404, a bad or expired signature a 403.
 * - Responses carry `X-Content-Type-Options: nosniff`, a sandboxing CSP, `Cache-Control: private,
 *   no-store`, and active content (HTML, SVG, XML, scripts) is sent as an `attachment` with type
 *   `application/octet-stream`, so a signed link to an uploaded SVG can never execute script.
 *
 * Mount it with `createHttpApp(app, { signedFiles: [{ disk, secret, prefix }] })`.
 *
 * @module
 */
import type { StorageDisk } from '../contracts/index.ts'
import { ForbiddenError, NotFoundError, StrutvaneError } from '../core/index.ts'
import { FileNotFoundError } from './body.ts'
import { assertSafeKey } from './keys.ts'
import { isActiveContent } from './mime.ts'
import { verifySignedUrl } from './signing.ts'

/** Options for {@link serveSignedFile}. */
export interface SignedFileOptions {
  /** The disk whose `temporaryUrl` produced the links. */
  readonly disk: StorageDisk
  /** The same secret the disk signs with (`signingSecret`). */
  readonly secret: string
  /** The URL path the links start with: the disk's `url` option, default `/storage/<disk>`. */
  readonly prefix?: string
  readonly now?: () => number
}

/** The path prefix of a disk's signed links. */
export function signedFilePrefix(options: SignedFileOptions): string {
  return (options.prefix ?? `/storage/${options.disk.name}`).replace(/\/+$/, '')
}

/** Verify a signed file URL and stream the file. Throws Strutvane errors (404/403/405). */
export async function serveSignedFile(
  request: Request,
  options: SignedFileOptions,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    throw new StrutvaneError('method_not_allowed', { status: 405 })
  const url = new URL(request.url)
  const prefix = `${signedFilePrefix(options)}/`
  if (!url.pathname.startsWith(prefix)) throw new NotFoundError()
  let key: string
  try {
    key = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    assertSafeKey(key)
  } catch {
    throw new NotFoundError()
  }
  const valid = verifySignedUrl(
    options.disk.name,
    key,
    { expires: url.searchParams.get('expires'), signature: url.searchParams.get('signature') },
    { secret: options.secret, method: 'GET', ...(options.now ? { now: options.now } : {}) },
  )
  if (!valid) throw new ForbiddenError()
  const info = await options.disk.stat(key)
  if (!info) throw new NotFoundError()
  const active = isActiveContent(info.contentType)
  const name = (key.split('/').pop() ?? 'file').replace(/[^a-z0-9._=-]/g, '_')
  const headers = new Headers({
    'Content-Type': active ? 'application/octet-stream' : info.contentType,
    'Content-Disposition': `${active ? 'attachment' : 'inline'}; filename="${name}"`,
    'Content-Length': String(info.size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  try {
    return new Response(await options.disk.get(key), { status: 200, headers })
  } catch (error) {
    if (error instanceof FileNotFoundError) throw new NotFoundError()
    throw error
  }
}
