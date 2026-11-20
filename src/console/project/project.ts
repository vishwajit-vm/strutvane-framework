/**
 * Facts about the user's project: where its root is, what it depends on, which package manager
 * it uses, and what is installed in `node_modules`.
 *
 * Everything here only reads files. Nothing in a project is executed to answer these questions
 * (contributed code is loaded separately, in `contributions.ts`, with path checks).
 *
 * @module
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  detectPackageManager as detectProjectPackageManager,
  type PackageManager,
} from '../../core/package-manager.ts'
import type { Project } from '../framework/command.ts'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { printable } from '../framework/printable.ts'
import {
  type BoundaryFacts,
  declaresCli,
  isForbiddenProjectDir,
  isOwnedByCurrentUser,
  processBoundary,
  readManifest,
} from './boundary.ts'

/** The file that marks a Strutvane project root (docs/09 §1.1). */
export const PROJECT_MARKER = 'strutvane.config.ts'

/** Files that mark an application root (`bootstrap/app.ts`, its built form, or `strut.js`). */
export const APP_MARKERS: readonly string[] = Object.freeze([
  join('bootstrap', 'app.ts'),
  join('bootstrap', 'app.mts'),
  join('bootstrap', 'app.js'),
  join('bootstrap', 'app.mjs'),
  'strut.js',
])

/**
 * `true` when `dir` holds an application (`bootstrap/app.ts` or `strut.js`).
 *
 * @example
 * isAppRoot('/srv/blog') // true
 */
export function isAppRoot(dir: string): boolean {
  return APP_MARKERS.some((marker) => existsSync(join(dir, marker)))
}

/**
 * `true` when `dir` holds an application and no v1 `strutvane.config.ts`: commands with a v1
 * (registry) and a v2 (application) form pick the v2 one.
 *
 * @example
 * isApplicationRoot('/srv/northwind') // true for an app made by create-strutvane 0.2
 */
export function isApplicationRoot(dir: string): boolean {
  return isAppRoot(dir) && !existsSync(join(dir, PROJECT_MARKER))
}

/**
 * Find the project root for `start`: the nearest directory that contains `strutvane.config.ts`,
 * an application (`bootstrap/app.ts` or `strut.js`, so `.env`'s `APP_ENV` reaches the production
 * guard) or whose package.json declares `@strutvane/cli`, under the boundary rules of `boundary.ts`
 * (never a drive or file-system root, the OS temp directory or a folder above home; on POSIX,
 * owned by the current user). The search stops at the first folder that breaks those rules, and at
 * the first project folder (one owned by someone else ends the search with no project). Returns
 * `undefined` when there is no acceptable project.
 */
export function findProjectRoot(
  start: string,
  facts: BoundaryFacts = processBoundary(),
): string | undefined {
  let dir = resolve(start)
  for (;;) {
    if (isForbiddenProjectDir(dir, facts)) return undefined
    const isProject =
      existsSync(join(dir, PROJECT_MARKER)) || isAppRoot(dir) || declaresCli(readManifest(dir))
    if (isProject) return isOwnedByCurrentUser(dir, facts) ? dir : undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Read and parse a JSON object file. Throws `invalid_package_json` (exit 3) when it is not one. */
export function readJsonObject(path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(readFileSync(path, 'utf8')))
  } catch (error) {
    throw new CliError('invalid_package_json', {
      exitCode: EXIT.VALIDATION,
      params: { path, detail: error instanceof Error ? error.message : String(error) },
      cause: error,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError('invalid_package_json', {
      exitCode: EXIT.VALIDATION,
      params: { path, detail: 'expected a JSON object' },
    })
  }
  return parsed as Record<string, unknown>
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Load the project at `root`. */
export function loadProject(root: string): Project {
  const manifest = join(root, 'package.json')
  // An application without a package.json yet (a fresh skeleton, a test folder) is still a project.
  if (!existsSync(manifest) && isAppRoot(root)) return { root, packageJson: {} }
  return { root, packageJson: readJsonObject(manifest) }
}

/** Names of every dependency the project declares (prod, dev, optional, peer), sorted. */
export function dependencyNames(packageJson: Readonly<Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const deps = packageJson[field]
    if (typeof deps === 'object' && deps !== null)
      for (const name of Object.keys(deps)) names.add(name)
  }
  return [...names].sort()
}

/** The version range the project declares for `name`, if any. */
export function declaredRange(
  packageJson: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = packageJson[field]
    if (typeof deps === 'object' && deps !== null) {
      const value = (deps as Record<string, unknown>)[name]
      if (typeof value === 'string') return value
    }
  }
  return undefined
}

/** Package managers the CLI knows how to drive (one detection rule, shared with the runtime). */
export type { PackageManager }

/** Detect the package manager: `packageManager` field first, then the lockfile, else npm. */
export function detectPackageManager(project: Project): PackageManager {
  return detectProjectPackageManager(project.root, project.packageJson)
}

/** The command line that adds (or removes) packages with a package manager. */
export function packageManagerCommand(
  pm: PackageManager,
  action: 'add' | 'remove',
  packages: readonly string[],
  options: { readonly dev?: boolean } = {},
): { command: string; args: string[] } {
  const dev = options.dev === true
  switch (pm) {
    case 'npm':
      return action === 'add'
        ? { command: 'npm', args: ['install', ...(dev ? ['--save-dev'] : []), ...packages] }
        : { command: 'npm', args: ['uninstall', ...packages] }
    case 'yarn':
      return {
        command: 'yarn',
        args: [action, ...(dev && action === 'add' ? ['--dev'] : []), ...packages],
      }
    case 'bun':
      return {
        command: 'bun',
        args: [action, ...(dev && action === 'add' ? ['--dev'] : []), ...packages],
      }
    default:
      return {
        command: 'pnpm',
        args: [action, ...(dev && action === 'add' ? ['--save-dev'] : []), ...packages],
      }
  }
}

/**
 * npm package names (lowercase, optional scope). Anything else, including paths, URLs, git specs
 * and `file:`/`link:` specs, is refused before it reaches a package manager or the file system.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/

/** Whether `name` is a plain registry package name (no traversal, no specs). */
export function isValidPackageName(name: string): boolean {
  return name.length <= 214 && PACKAGE_NAME.test(name) && !name.split('/').includes('..')
}

/** A package installed in the project's `node_modules`. */
export interface InstalledPackage {
  readonly name: string
  readonly version: string
  /** Directory of the package inside `node_modules` (may be a symlink, e.g. with pnpm). */
  readonly dir: string
  readonly manifest: Readonly<Record<string, unknown>>
}

/** Read an installed package's manifest, or `undefined` when it is not installed. */
export function readInstalledPackage(root: string, name: string): InstalledPackage | undefined {
  if (!isValidPackageName(name)) return undefined
  const dir = join(root, 'node_modules', ...name.split('/'))
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) return undefined
  const manifest = readJsonObject(manifestPath)
  // Printed in messages and `doctor`: never let a manifest put control characters on screen.
  const version =
    typeof manifest['version'] === 'string' ? printable(manifest['version'], 64) : '0.0.0'
  return { name, version, dir, manifest }
}

/** The `strutvane` field of a package manifest (an object), if present. */
export function strutvaneField(
  manifest: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const field = manifest['strutvane']
  return typeof field === 'object' && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined
}

/** Strutvane packages and plugins whose contributions (commands, installers, templates) are loaded. */
const CONTRIBUTOR =
  /^(?:@strutvane\/[a-z0-9-]+|strutvane-plugin-[a-z0-9-]+|@[a-z0-9][a-z0-9-._~]*\/strutvane-plugin-[a-z0-9-]+)$/

/** Whether a dependency may contribute commands, installers or templates. */
export function isContributorName(name: string): boolean {
  return CONTRIBUTOR.test(name) && name !== '@strutvane/cli'
}

/** `auth` → `@strutvane/auth`; full names are kept. */
export function expandPackageName(name: string): string {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.startsWith('strutvane-plugin-')
    ? `@strutvane/${name}`
    : name
}
