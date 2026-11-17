/**
 * Which packages may contribute database migrations (`"strutvane": { "migrations": "./migrations" }`
 * in their package.json), for the framework's `node strut migrate` / `migrate:status`.
 *
 * **Threat model.** These SQL files run with the database OWNER role, so a contribution is accepted
 * only when the package passes the same gate as contributed code (contributions.ts), plus one
 * more condition:
 * 1. it is a direct dependency of the app (its own package.json) with a contributor name
 *    (`@strutvane/*` or a `strutvane-plugin-*` package): transitive dependencies never count;
 * 2. the app ENABLED it: `strutvane.config.ts` imports from the package (registering its provider,
 *    which is what `node strut add` writes). Installing a package is not enough;
 * 3. a third-party (non-`@strutvane`) package declares a `strutvane.compat` range this CLI
 *    satisfies (exit 7 otherwise);
 * 4. the folder resolves, after following symlinks, inside the package's own directory under
 *    `node_modules` (`unsafe_contribution` otherwise).
 * A dependency that declares migrations but is not enabled is ignored (and `node strut doctor` says so).
 *
 * @module
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseSync } from 'oxc-parser'
import type { Project } from '../framework/command.ts'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { collectImports, isNode } from '../registry/ast.ts'
import { assertCompatible, isInNodeModules, isInside } from './contributions.ts'
import {
  dependencyNames,
  isContributorName,
  readInstalledPackage,
  strutvaneField,
} from './project.ts'

/** A vetted migrations folder of one package. */
export interface PackageMigrationDir {
  /** The package name, shown next to its migrations (`--pretend`, `migrate:status`). */
  readonly package: string
  /** Real absolute path of the declared folder (dialect sub-folders live below it). */
  readonly dir: string
}

/** What {@link packageMigrations} found. */
export interface PackageMigrationScan {
  readonly dirs: readonly PackageMigrationDir[]
  /** Direct dependencies that declare migrations but are not enabled in strutvane.config.ts. */
  readonly ignored: readonly string[]
}

/** `@strutvane/auth/provider` → `@strutvane/auth`; `./app/x.ts`, `node:fs` → `undefined`. */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':'))
    return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Packages `strutvane.config.ts` imports values from (static `import … from '…'` declarations;
 * `import type` does not count), i.e. the packages whose providers the app registers.
 */
export function enabledPackages(root: string): ReadonlySet<string> {
  const file = join(root, 'strutvane.config.ts')
  if (!existsSync(file)) return new Set()
  const source = readFileSync(file, 'utf8')
  // Parsed, not pattern-matched: an import inside a block comment or a template string is not
  // an import, and must not enable a package's migrations. A file that does not parse enables
  // nothing (fail closed); loading the config reports the syntax error itself.
  const parsed = parseSync('strutvane.config.ts', source, { sourceType: 'module' })
  const program: unknown = parsed.program
  if (parsed.errors.length > 0 || !isNode(program)) return new Set()
  const out = new Set<string>()
  for (const binding of collectImports(program).values()) {
    const name = packageOfSpecifier(binding.source)
    if (name) out.add(name)
  }
  return out
}

/** Vet every package migration contribution of the project (see the module docs). */
export function packageMigrations(project: Project, cliVersion: string): PackageMigrationScan {
  const enabled = enabledPackages(project.root)
  const dirs: PackageMigrationDir[] = []
  const ignored: string[] = []
  for (const name of dependencyNames(project.packageJson)) {
    const pkg = readInstalledPackage(project.root, name)
    if (!pkg) continue
    const declared = strutvaneField(pkg.manifest)?.['migrations']
    if (declared === undefined) continue
    if (!isContributorName(name) || !enabled.has(name)) {
      ignored.push(name)
      continue
    }
    assertCompatible(pkg, cliVersion)
    const unsafe = (): CliError =>
      new CliError('unsafe_contribution', {
        exitCode: EXIT.FAILURE,
        params: { name, key: 'migrations', path: String(declared) },
      })
    if (
      typeof declared !== 'string' ||
      declared.trim() === '' ||
      isAbsolute(declared) ||
      /^[a-zA-Z]:/.test(declared) ||
      declared.includes('\0')
    )
      throw unsafe()
    const target = join(pkg.dir, declared)
    if (!existsSync(target) || !statSync(target).isDirectory()) continue
    const packageDir = realpathSync(pkg.dir)
    const real = realpathSync(target)
    if (!isInNodeModules(packageDir) || !isInside(packageDir, real)) throw unsafe()
    dirs.push({ package: name, dir: real })
  }
  return { dirs, ignored }
}
