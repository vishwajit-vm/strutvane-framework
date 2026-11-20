/**
 * The web UI next to the API, for an application (`bootstrap/app.ts`): one port serves both
 * (docs/05 §1: `npm run dev` and `node strut start` give the API and the UI on one origin, so the
 * UI's cookie session, CSRF token and fetches need no proxy and no CORS).
 *
 * Two sources, chosen by the server that starts the app:
 * - **built files** (`node strut start`): `dist/web`, from `node strut build`, served by the
 *   hardened static handler (`http/static-files.ts`: no traversal, fixed content types, hashed
 *   assets cached for a year, `index.html` never cached, SPA fallback for navigations);
 * - **fallthrough** (`node strut dev`): the request is handed to the project's Vite by the Node
 *   adapter (`serve({ fallback })`), which answers with hot reload.
 *
 * Why after routing, never before: a route always wins (an app may serve `/` itself), the request
 * hooks (sign-in) answer their own paths first, and an unknown API path stays an RFC 9457
 * problem. Only `GET`/`HEAD` requests outside the API base path and the framework's own paths
 * (`ui-paths.ts`: one rule for production and development) may get the UI.
 *
 * @module
 */
import { createStaticFiles } from '../static-files.ts'
import { isUiRequest, uiExcludedPaths } from '../ui-paths.ts'

/**
 * Where the UI comes from.
 *
 * @example
 * const built: WebUiOptions = { files: join(root, 'dist', 'web') }
 * const dev: WebUiOptions = { fallthrough: true }
 */
export interface WebUiOptions {
  /** A built UI folder (it holds `index.html`): its files are served, with the SPA fallback. */
  readonly files?: string
  /**
   * Hand UI requests no file answered to the Node adapter's fallback (Vite in `node strut dev`).
   * The app's own 404 problem is sent if the fallback passes.
   */
  readonly fallthrough?: boolean
  /** More path prefixes the UI must never answer (besides the API base and framework paths). */
  readonly exclude?: readonly string[]
}

/**
 * What the UI makes of a request routing did not match: a response (a file or `index.html`),
 * `'fallthrough'` (let the adapter's fallback answer), or `undefined` (not the UI's: a 404).
 *
 * @example
 * const answer: WebUiAnswer = 'fallthrough'
 */
export type WebUiAnswer = Response | 'fallthrough' | undefined

/**
 * Build the UI responder for an app whose API lives under `apiPrefix`.
 *
 * @example
 * const ui = webUiResponder({ files: 'dist/web' }, '/api')
 * await ui(new Request('http://localhost/assets/index-1a2b.js')) // the file, cached for a year
 * await ui(new Request('http://localhost/api/nope'))             // undefined: the API's 404
 */
export function webUiResponder(
  options: WebUiOptions,
  apiPrefix: string,
): (request: Request) => Promise<WebUiAnswer> {
  const exclude = uiExcludedPaths(apiPrefix, options.exclude ?? [])
  const files =
    options.files === undefined ? undefined : createStaticFiles({ root: options.files, exclude })
  return async (request) => {
    if (!isUiRequest(request, exclude)) return undefined
    const served = files === undefined ? undefined : await files(request)
    if (served !== undefined) return served
    return options.fallthrough === true ? 'fallthrough' : undefined
  }
}
