/**
 * Loading code that packages and plugins contribute through their `package.json`:
 *
 * ```json
 * { "strutvane": { "commands": "./dist/commands.js", "installer": "./dist/installer.js",
 *                  "templates": "./dist/templates.js", "compat": "^0.1.0" } }
 * ```
 *
 * **Threat model.** These modules run with the user's privileges, so the CLI only ever imports a
 * module that (1) belongs to a dependency the project declares in its own package.json, (2) has a
 * plain registry package name, and (3) resolves (after following symlinks) to a file inside that
 * package's own directory under the project's `node_modules`. A manifest that points elsewhere
 * (`"commands": "../../../evil.js"`, an absolute path, a symlink out of the package) is refused
 * with `UNSAFE_CONTRIBUTION` instead of being executed. Nothing outside `node_modules` is ever
 * imported, including the project's own source files.
 *
 * @module
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { type InstalledPackage, strutvaneField } from './project.ts'
import { satisfies } from './semver.ts'

/** The contribution points a package can declare. */
export type ContributionKey = 'commands' | 'installer' | 'templates'

/** Is `child` inside (or equal to) `parent`? Both must be real, absolute paths. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

/**
 * Resolve a package's contribution to an absolute file path, enforcing the containment rules
 * above. Returns `undefined` when the package does not declare `key`.
 */
export function resolveContribution(
  pkg: InstalledPackage,
  key: ContributionKey,
): string | undefined {
  const field = strutvaneField(pkg.manifest)
  const declared = field?.[key]
  if (declared === undefined) return undefined
  const fail = (detail: string): CliError =>
    new CliError('INVALID_CONTRIBUTION', {
      exitCode: EXIT.FAILURE,
      params: { name: pkg.name, key, detail },
    })
  if (typeof declared !== 'string' || declared.trim() === '') throw fail('expected a relative path')
  const unsafe = (): CliError =>
    new CliError('UNSAFE_CONTRIBUTION', {
      exitCode: EXIT.FAILURE,
      params: { name: pkg.name, key, path: declared },
    })
  if (isAbsolute(declared) || /^[a-zA-Z]:/.test(declared) || declared.includes('\0')) throw unsafe()

  const target = join(pkg.dir, declared)
  if (!existsSync(target) || !statSync(target).isFile()) throw fail(`${declared} does not exist`)
  const packageDir = realpathSync(pkg.dir)
  const real = realpathSync(target)
  if (!isInNodeModules(packageDir) || !isInside(packageDir, real)) throw unsafe()
  return real
}

/**
 * Whether a real path lies inside a `node_modules` folder. Not necessarily the project's own: in a
 * pnpm or npm workspace, a project's dependencies are symlinks into the workspace root's
 * `node_modules`, which is still installed code, never the user's sources.
 */
export function isInNodeModules(realPath: string): boolean {
  return realPath.split(/[\\/]/).includes('node_modules')
}

/** Import a module by absolute path (file URLs keep Windows drive letters working). */
export async function importFile(path: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(pathToFileURL(path).href)
  return module as Record<string, unknown>
}

/** The result of a `strutvane.compat` check. */
export type CompatResult = { readonly ok: true } | { readonly ok: false; readonly range: string }

/** Check a package's declared `strutvane.compat` range against the CLI version. */
export function checkCompat(pkg: InstalledPackage, cliVersion: string): CompatResult {
  const range = strutvaneField(pkg.manifest)?.['compat']
  if (range === undefined) return { ok: true }
  if (typeof range !== 'string') return { ok: false, range: String(range) }
  return satisfies(cliVersion, range, { includePrerelease: true })
    ? { ok: true }
    : { ok: false, range }
}

/** Throw `INCOMPATIBLE_PACKAGE` (exit 7) unless the package accepts this CLI version. */
export function assertCompatible(pkg: InstalledPackage, cliVersion: string): void {
  const result = checkCompat(pkg, cliVersion)
  if (!result.ok) {
    throw new CliError('INCOMPATIBLE_PACKAGE', {
      exitCode: EXIT.INCOMPATIBLE,
      params: { name: pkg.name, version: pkg.version, range: result.range, cli: cliVersion },
    })
  }
}

/** The module's `default` export, or the named export `name`, or the module itself. */
export function pickExport(module: Record<string, unknown>, name: string): unknown {
  if (module['default'] !== undefined) return module['default']
  if (module[name] !== undefined) return module[name]
  return module
}
