/**
 * Commands contributed by installed packages and plugins (`strutvane.commands`, docs/09 §11).
 *
 * Loading is best-effort per package: one broken or unsafe plugin is reported and skipped, and
 * never prevents the other commands (or the built-ins) from working. Packages whose
 * `strutvane.compat` range excludes this CLI version are refused before any of their code runs.
 *
 * @module
 */
import type { Project } from '../framework/command.ts'
import { type AnyCommand, commandProblems } from '../framework/command.ts'
import { checkCompat, importFile, resolveContribution } from './contributions.ts'
import { dependencyNames, isContributorName, readInstalledPackage } from './project.ts'

/** A contributed command, with the package it came from. */
export interface ContributedCommand {
  readonly command: AnyCommand
  readonly source: string
}

/** A package that was not loaded, and why. */
export type PluginProblem =
  | {
      readonly kind: 'incompatible'
      readonly name: string
      readonly version: string
      readonly range: string
    }
  | { readonly kind: 'error'; readonly name: string; readonly error: unknown }
  | { readonly kind: 'invalid-command'; readonly name: string; readonly detail: string }

/** Everything found while loading contributed commands. */
export interface PluginCommands {
  readonly commands: readonly ContributedCommand[]
  readonly problems: readonly PluginProblem[]
}

/** Normalise a module's export into a list of candidate commands. */
function candidates(module: Record<string, unknown>): unknown[] {
  const exported = module['default'] ?? module['commands']
  if (Array.isArray(exported)) return exported
  if (exported !== undefined) return [exported]
  return []
}

/** Load commands from every contributing dependency of `project`, in package-name order. */
export async function loadPluginCommands(
  project: Project,
  cliVersion: string,
): Promise<PluginCommands> {
  const commands: ContributedCommand[] = []
  const problems: PluginProblem[] = []
  for (const name of dependencyNames(project.packageJson).filter(isContributorName)) {
    try {
      const pkg = readInstalledPackage(project.root, name)
      if (pkg === undefined) continue
      const path = resolveContribution(pkg, 'commands')
      if (path === undefined) continue
      const compat = checkCompat(pkg, cliVersion)
      if (!compat.ok) {
        problems.push({ kind: 'incompatible', name, version: pkg.version, range: compat.range })
        continue
      }
      const module = await importFile(path)
      const list = candidates(module)
      if (list.length === 0) {
        problems.push({ kind: 'invalid-command', name, detail: 'the module exports no commands' })
      }
      for (const candidate of list) {
        const issues = commandProblems(candidate)
        if (issues.length > 0) {
          problems.push({ kind: 'invalid-command', name, detail: issues.join('; ') })
          continue
        }
        commands.push({ command: candidate as AnyCommand, source: name })
      }
    } catch (error) {
      problems.push({ kind: 'error', name, error })
    }
  }
  return { commands, problems }
}

/** The merged command list plus warnings about collisions. */
export interface MergedCommands {
  readonly commands: readonly AnyCommand[]
  /** Which package each contributed command came from. */
  readonly sources: ReadonlyMap<string, string>
  readonly collisions: readonly string[]
}

/**
 * Merge built-ins with contributed commands. A contributed command replaces a built-in
 * placeholder (that is what placeholders are for); it never replaces a real built-in, so a plugin
 * cannot hijack `sv add` or `sv upgrade`. Between two plugins, the first (by package name) wins.
 */
export function mergeCommands(
  builtins: readonly AnyCommand[],
  contributed: readonly ContributedCommand[],
): MergedCommands {
  const byName = new Map<string, AnyCommand>(builtins.map((c) => [c.name, c]))
  const sources = new Map<string, string>()
  const collisions: string[] = []
  for (const { command, source } of contributed) {
    const existing = byName.get(command.name)
    if (existing !== undefined && existing.placeholder !== true) {
      const owner = sources.get(command.name) ?? 'the CLI'
      collisions.push(`${source} also defines "${command.name}"; the one from ${owner} is used.`)
      continue
    }
    // A replaced placeholder keeps its safety flags: the production guard protects
    // `migrate:fresh` whichever package implements it.
    const inherited = existing?.destructive === true && command.destructive !== true
    byName.set(command.name, inherited ? { ...command, destructive: true } : command)
    sources.set(command.name, source)
  }
  return { commands: [...byName.values()], sources, collisions }
}
