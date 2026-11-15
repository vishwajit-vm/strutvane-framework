/**
 * Serving a built single-page UI (`dist/web`, the output of `sv build`) from the same origin as
 * the API, so `sv start` gives one URL for both (docs/05 §1: "UI on :3000").
 *
 * - Only `GET`/`HEAD`. Paths are URL-decoded per segment and must stay inside `root`: `..`,
 *   backslashes, NUL bytes, encoded slashes and dot-files are refused (404, never a hint), and on
 *   Windows so are 8.3 short names and trailing dots or spaces (aliases of other names).
 * - Content types come from a fixed extension table; unknown extensions are served as
 *   `application/octet-stream` with `nosniff`, so nothing is ever guessed as HTML.
 * - Files under `assets/` carry content hashes (Vite), so they are cached for a year as
 *   `immutable`; everything else (`index.html` above all) is `no-cache`, so a deploy shows up on the
 *   next load.
 * - HTML pages get a page CSP (`default-src 'self'`, no inline scripts, no framing) instead of the
 *   API's `default-src 'none'`.
 * - SPA fallback: a navigation (`Accept: text/html`) to a path without a file extension that
 *   matches no file gets `index.html`, so client-side routes survive a reload. Paths under the
 *   excluded prefixes (the API base path, `/_strutvane`, `/storage`) never fall back: an unknown
 *   API route stays a problem+json 404.
 *
 * @module
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { isExcludedPath } from './ui-paths.ts'

/** Options for {@link createStaticFiles}. */
export interface StaticFilesOptions {
  /** Folder with the built UI (contains `index.html`). */
  readonly root: string
  /** Path prefixes that are never served from `root` and never fall back to `index.html`. */
  readonly exclude?: readonly string[]
  /** Serve `index.html` for unknown extension-less navigations. Default `true`. */
  readonly spaFallback?: boolean
}

/** CSP for HTML pages of the built UI (scripts and styles from the same origin only). */
export const PAGE_CSP: string =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
})

/** A request handler: a `Response` for paths it serves, `undefined` otherwise. */
export type StaticFilesHandler = (request: Request) => Promise<Response | undefined>

/** An 8.3 short-name component (`ENV~1`, `PROGRA~2.JS`): Windows aliases a long name with it. */
const SHORT_NAME = /~\d/

/**
 * Decode a URL path into safe relative segments, or `undefined` when it could escape the root or
 * name something that must never be served.
 *
 * On Windows, names that the file system resolves to *another* name are refused too, because each
 * would get past the dot-file check: 8.3 short names (`/ENV~1` opens `.env`) and segments ending
 * in a dot or a space (`/secret.` opens `secret`). `platform` is a parameter so both rule sets are
 * tested on every OS.
 */
export function safeSegments(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const out: string[] = []
  for (const raw of pathname.split('/')) {
    if (raw === '') continue
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    if (
      seg === '.' ||
      seg === '..' ||
      seg.startsWith('.') ||
      seg.includes('/') ||
      seg.includes('\\') ||
      seg.includes('\0') ||
      seg.includes(':') ||
      (platform === 'win32' && (SHORT_NAME.test(seg) || /[. ]$/.test(seg)))
    )
      return undefined
    out.push(seg)
  }
  return out
}

/** Create the static file handler. */
export function createStaticFiles(options: StaticFilesOptions): StaticFilesHandler {
  const root = resolve(options.root)
  const exclude = (options.exclude ?? []).map((p) => p.replace(/\/+$/, ''))
  const fallback = options.spaFallback !== false

  const fileAt = async (segments: readonly string[]) => {
    const full = resolve(root, ...segments)
    if (full !== root && !full.startsWith(root + sep)) return undefined
    try {
      const info = await stat(full)
      return info.isFile() ? { full, size: info.size } : undefined
    } catch {
      return undefined
    }
  }

  const respond = (
    file: { full: string; size: number },
    method: string,
    immutable: boolean,
  ): Response => {
    const ext = extname(file.full).toLowerCase()
    const type = TYPES[ext] ?? 'application/octet-stream'
    const headers = new Headers({
      'content-type': type,
      'content-length': String(file.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    if (ext === '.html') headers.set('content-security-policy', PAGE_CSP)
    else headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    const body =
      method === 'HEAD'
        ? null
        : (Readable.toWeb(createReadStream(file.full)) as ReadableStream<Uint8Array>)
    return new Response(body, { status: 200, headers })
  }

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
    const { pathname } = new URL(request.url)
    if (isExcludedPath(pathname, exclude)) return undefined
    const segments = safeSegments(pathname)
    if (segments === undefined) return undefined
    const direct = segments.length === 0 ? undefined : await fileAt(segments)
    if (direct) return respond(direct, request.method, segments[0] === 'assets')
    const last = segments.at(-1) ?? ''
    const navigation = (request.headers.get('accept') ?? '').includes('text/html')
    if (segments.length === 0 || (fallback && navigation && extname(last) === '')) {
      const index = await fileAt(['index.html'])
      if (index) return respond(index, request.method, false)
    }
    return undefined
  }
}

/** Does `root` contain a built UI (`index.html`)? */
export async function hasBuiltUi(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, 'index.html'))).isFile()
  } catch {
    return false
  }
}
