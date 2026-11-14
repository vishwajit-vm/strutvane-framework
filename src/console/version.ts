/**
 * The CLI's own name and version.
 *
 * Read from `package.json` at runtime instead of being inlined at build time, so the version shown
 * by `sv --version`, written into generated headers and compared by the launcher is always the one
 * npm actually installed. The manifest is the nearest `package.json` above this module (see
 * `ownManifest`), which is right from `src/console/` (tests, type stripping) and from any `dist/`
 * chunk (published build) alike.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'

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

/**
 * The package.json of the package this module ships in: the nearest one above it. Since the CLI
 * moved into `@strutvane/framework`, this file sits deeper than the package root in src/ (and
 * dist/ chunk layout is the bundler's choice), so a fixed `../package.json` is no longer right.
 */
export function ownManifest(from: URL): URL {
  let dir = new URL('.', from)
  for (;;) {
    const candidate = new URL('package.json', dir)
    if (existsSync(candidate)) return candidate
    const parent = new URL('..', dir)
    if (parent.href === dir.href) return new URL('../package.json', from)
    dir = parent
  }
}

/** The installed version of the package that ships the CLI (`@strutvane/framework`). */
export const CLI_VERSION: string = readPackageVersion(ownManifest(new URL(import.meta.url)))
