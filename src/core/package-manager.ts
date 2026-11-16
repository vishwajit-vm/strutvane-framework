/**
 * Which package manager a project uses, so every hint the framework or the CLI prints names the
 * command the user actually runs (`npm install`, `pnpm install`…), never a hard-coded one.
 *
 * One rule for both layers: the `packageManager` field of `package.json` first, then the
 * lockfile in the project root, else npm (the blueprint's default, docs/18 §7).
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Package managers the CLI knows how to drive. */
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

const isPackageManager = (name: unknown): name is PackageManager =>
  name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun'

/**
 * Detect the package manager of the project at `root`. `packageJson` may be passed when the
 * caller already read it; otherwise `root/package.json` is read (a missing or unreadable file
 * just means "no field").
 *
 * @example
 * detectPackageManager('/work/acme') // 'npm'
 */
export function detectPackageManager(
  root: string,
  packageJson?: Readonly<Record<string, unknown>>,
): PackageManager {
  const manifest = packageJson ?? readManifest(root)
  const field = manifest?.['packageManager']
  if (typeof field === 'string') {
    const name = field.split('@')[0]
    if (isPackageManager(name)) return name
  }
  for (const [file, pm] of LOCKFILES) if (existsSync(join(root, file))) return pm
  return 'npm'
}

/**
 * The command that installs a project's dependencies with `pm`.
 *
 * @example
 * installCommand('pnpm') // 'pnpm install'
 */
export function installCommand(pm: PackageManager): string {
  return `${pm} install`
}

function readManifest(root: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
