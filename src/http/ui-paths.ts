/**
 * Which requests the web UI may answer when the app serves it on the API's origin (`node strut start`
 * from `dist/web`, `node strut dev` through the project's Vite). One rule for both, so production and
 * development never disagree about what belongs to the API:
 *
 * - only `GET` and `HEAD` (a UI never handles writes);
 * - never a path under the API base path (`/api/v1` or whatever `config/api.ts` sets), the
 *   framework's own paths (`/_strutvane`, `/storage`, `/openapi.json`, `/health`, `/ready`) or
 *   the discovery documents (`/.well-known`, which holds the manifest). An unknown API path must
 *   stay an RFC 9457 problem, never become an HTML page that a client would try to parse;
 * - only after routing found nothing and no `http.onRequest` hook answered (sign-in routes, the
 *   log viewer): callers apply these rules in the not-found handler, which runs after both.
 *
 * @module
 */

/** Framework-owned path prefixes the UI never answers (the API base path is added per app). */
export const FRAMEWORK_PATHS: readonly string[] = Object.freeze([
  '/_strutvane',
  '/storage',
  '/openapi.json',
  '/health',
  '/ready',
  '/.well-known',
])

/**
 * Response header that marks "routing found nothing and the UI may answer this" for the Node
 * adapter (`serve({ fallback })`), which then hands the request to Vite's middleware in `node strut dev`.
 * The adapter always strips it, so it never reaches a client; a client cannot set response
 * headers, so it cannot forge it either.
 */
export const UI_FALLTHROUGH_HEADER = 'x-strutvane-ui-fallthrough'

/** Every excluded prefix for an app: its API base path, the framework paths and `extra`. */
export function uiExcludedPaths(basePath: string, extra: readonly string[] = []): string[] {
  return [basePath, ...FRAMEWORK_PATHS, ...extra]
    .map((p) => p.replace(/\/+$/, ''))
    .filter((p) => p !== '')
}

/** Is `pathname` one of `exclude`, or below one of them? */
export function isExcludedPath(pathname: string, exclude: readonly string[]): boolean {
  return exclude.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/** May the UI answer `request` (a `GET`/`HEAD` outside every excluded prefix)? */
export function isUiRequest(request: Request, exclude: readonly string[]): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  return !isExcludedPath(new URL(request.url).pathname, exclude)
}
