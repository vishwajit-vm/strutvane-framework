/**
 * The CLI's own name and version.
 *
 * Read from `package.json` at runtime instead of being inlined at build time, so the version shown
 * by `sv --version`, written into generated headers and compared by the launcher is always the one
 * npm actually installed. `../package.json` resolves correctly from both `src/` (tests, type
 * stripping) and `dist/` (published build), because both sit one level below the package root.
 *
 * @module
 */
import { readFileSync } from 'node:fs'

/** The npm package that implements the CLI. */
export const CLI_PACKAGE = '@strutvane/cli'

/** Read a `version` field from a package.json URL; `0.0.0` if it is missing or unreadable. */
export function readPackageVersion(url: URL): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // Fall through: a broken install must still be able to print help and errors.
  }
  return '0.0.0'
}

/** The installed version of `@strutvane/cli`. */
export const CLI_VERSION: string = readPackageVersion(new URL('../package.json', import.meta.url))
