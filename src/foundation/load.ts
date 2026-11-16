/**
 * Load an app the way `node strut` does: import `bootstrap/app.ts` (or the built `.js`) and take
 * its default export, the `Application` that `Application.configure(…).create()` returned.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Application } from './application.ts'
import { BootError } from './boot-error.ts'

const CANDIDATES = ['app.ts', 'app.mts', 'app.js', 'app.mjs']

/**
 * Import `<root>/bootstrap/app.ts` and return its default export. Throws a friendly `BootError`
 * when the file is missing or doesn't export an application. The app is not booted.
 *
 * @example
 * const app = await loadApplication(process.cwd())
 * await app.boot()
 */
export async function loadApplication(root: string): Promise<Application> {
  const file = CANDIDATES.map((name) => join(root, 'bootstrap', name)).find((path) =>
    existsSync(path),
  )
  if (file === undefined)
    throw new BootError(
      'missing_bootstrap',
      `There is no bootstrap/app.ts in ${root}.`,
      'Run node strut from the project root, or create bootstrap/app.ts exporting Application.configure({ basePath }).create() as its default export.',
    )
  const module: Record<string, unknown> = await import(pathToFileURL(file).href)
  const app = module['default']
  if (isApplication(app)) return app
  throw new BootError(
    'invalid_bootstrap',
    `${join('bootstrap', file.slice(file.lastIndexOf('app.')))} does not export an application as its default export.`,
    'End the file with: export default Application.configure({ basePath: dirname(import.meta.dirname) }).create()',
  )
}

/** An `Application`, also across two copies of the framework module (by shape). */
function isApplication(value: unknown): value is Application {
  if (value instanceof Application) return true
  return (
    typeof value === 'object' &&
    value !== null &&
    value.constructor?.name === 'Application' &&
    typeof (value as { handle?: unknown }).handle === 'function' &&
    typeof (value as { boot?: unknown }).boot === 'function'
  )
}
