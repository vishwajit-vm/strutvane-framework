/**
 * Serving a **public** disk over HTTP: `config/filesystems.ts`'s `public` disk (root
 * `storage/app/public`, `url: APP_URL + '/storage'`) answers `GET /storage/avatars/7.png`, so
 * `await Storage.disk('public').url(key)` links work without a web server in front (Laravel needs
 * `storage:link` plus nginx for that; `node strut storage:link` still exists for apps that serve
 * `public/` from a CDN or a web server).
 *
 * What is served, and what never is:
 * - Only `GET` and `HEAD`. Other methods fall through to the router (the app may own the path).
 * - The key comes from the path below the mount, URL-decoded per segment and validated like every
 *   storage key (`assertSafeKey`): no `..`, no backslashes, no hidden files, no control
 *   characters. Anything odd is a plain 404, never an error that echoes the path.
 * - Only a stored file whose metadata says `visibility: 'public'`. A private file that ended up
 *   on the disk, a folder (`/storage/avatars/`), or the disk's own metadata folder is a 404:
 *   there is no directory listing.
 * - The content type is the one recorded when the file was stored (never guessed from the URL's
 *   extension), sent with `X-Content-Type-Options: nosniff`, a sandboxing CSP and `inline`.
 *   Active content (HTML, SVG, XML, scripts) is sent as an `attachment` of type
 *   `application/octet-stream`: an uploaded `.svg` can never run script in the app's origin.
 * - An `ETag` (the stored SHA-256) with `If-None-Match` → 304, and `Cache-Control: public,
 *   max-age=0, must-revalidate`, so a replaced file is never served stale.
 *
 * @module
 */
import type { StorageDisk, StoredFile } from '../contracts/index.ts'
import { NotFoundError } from '../core/errors/errors.ts'
import { BootError } from '../foundation/boot-error.ts'
import { FileNotFoundError } from './body.ts'
import { assertSafeKey } from './keys.ts'
import { isActiveContent } from './mime.ts'

/**
 * A public disk and the URL path it is served under.
 *
 * @example
 * const mount: PublicMount = { disk: publicDisk, prefix: '/storage' }
 */
export interface PublicMount {
  readonly disk: StorageDisk
  /** A path such as `/storage`, without a trailing slash; never `/`. */
  readonly prefix: string
}

/**
 * The disk settings {@link publicMounts} reads (a `config/filesystems.ts` disk entry).
 *
 * @example
 * const disk: PublicDiskSettings = { visibility: 'public', url: 'http://localhost:3000/storage' }
 */
export interface PublicDiskSettings {
  readonly visibility?: 'private' | 'public'
  readonly url?: string
}

/**
 * Where each public disk is served: the path of its `url` setting (`APP_URL/storage` →
 * `/storage`), else `/storage` for the disk named `public` and `/storage/<name>` for others.
 * A `url` on another origin's root (a CDN) is not served by the app at all.
 *
 * Throws a `BootError` when two disks would share a path (one would silently hide the other).
 *
 * @example
 * publicMounts({ public: { visibility: 'public', url: 'http://localhost/storage' } }, disks)
 */
export function publicMounts(
  settings: Readonly<Record<string, PublicDiskSettings>>,
  disks: readonly StorageDisk[],
): readonly PublicMount[] {
  const mounts: PublicMount[] = []
  for (const disk of disks) {
    const entry = Object.hasOwn(settings, disk.name) ? settings[disk.name] : undefined
    if (entry?.visibility !== 'public') continue
    const prefix = mountPath(disk.name, entry.url)
    if (prefix === undefined) continue
    const clash = mounts.find(
      (mount) =>
        mount.prefix === prefix ||
        prefix.startsWith(`${mount.prefix}/`) ||
        mount.prefix.startsWith(`${prefix}/`),
    )
    if (clash !== undefined)
      throw new BootError(
        'public_disk_path_clash',
        `The public disks "${clash.disk.name}" and "${disk.name}" would both be served under ${clash.prefix}.`,
        'Give each public disk its own url in config/filesystems.ts (for example APP_URL/storage and APP_URL/media).',
      )
    mounts.push({ disk, prefix })
  }
  return mounts
}

function mountPath(name: string, url: string | undefined): string | undefined {
  let path: string
  if (url === undefined || url === '') path = name === 'public' ? '/storage' : `/storage/${name}`
  else {
    try {
      path = new URL(url, 'http://localhost').pathname
    } catch {
      throw new BootError(
        'invalid_disk_url',
        `The url of the "${name}" disk is not a URL.`,
        'Use the app URL plus a path, for example http://localhost:3000/storage (APP_URL + "/storage").',
      )
    }
  }
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? undefined : trimmed
}

/**
 * Answer a request for a file on one of `mounts`, or `undefined` when the request is not for
 * them (wrong method or path): the caller carries on with routing.
 *
 * @example
 * const response = await servePublicFile(request, mounts)
 */
export async function servePublicFile(
  request: Request,
  mounts: readonly PublicMount[],
): Promise<Response | undefined> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
  const path = new URL(request.url).pathname
  const mount = mounts.find((candidate) => path.startsWith(`${candidate.prefix}/`))
  if (mount === undefined) return undefined
  const key = keyFrom(path.slice(mount.prefix.length + 1))
  if (key === undefined) throw new NotFoundError()
  const info = await statOrUndefined(mount.disk, key)
  if (info === undefined || info.visibility !== 'public') throw new NotFoundError()
  const active = isActiveContent(info.contentType)
  const name = (key.split('/').pop() ?? 'file').replace(/[^a-z0-9._=-]/g, '_')
  const etag = `"${info.sha256}"`
  const headers = new Headers({
    'Content-Type': active ? 'application/octet-stream' : info.contentType,
    'Content-Disposition': `${active ? 'attachment' : 'inline'}; filename="${name}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'public, max-age=0, must-revalidate',
    ETag: etag,
  })
  if (matchesEtag(request.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers })
  headers.set('Content-Length', String(info.size))
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  try {
    return new Response(await mount.disk.get(key), { status: 200, headers })
  } catch (error) {
    if (error instanceof FileNotFoundError) throw new NotFoundError()
    throw error
  }
}

/** The storage key in a URL path, or `undefined` when it isn't a safe key. */
function keyFrom(rest: string): string | undefined {
  try {
    const key = rest.split('/').map(decodeURIComponent).join('/')
    assertSafeKey(key)
    return key
  } catch {
    return undefined
  }
}

/** A missing file (or one whose metadata can't be read) is simply not there. */
async function statOrUndefined(disk: StorageDisk, key: string): Promise<StoredFile | undefined> {
  try {
    return await disk.stat(key)
  } catch (error) {
    if (error instanceof FileNotFoundError) return undefined
    // `a.png/x` when a.png is a file, or a folder where a file was expected: not a file either.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOTDIR' || code === 'EISDIR') return undefined
    throw error
  }
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === etag || value === '*')
}
