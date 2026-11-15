/**
 * `sv about`: versions of the CLI, Node and every installed Strutvane package (docs/09 §2).
 *
 * The first thing to paste into a bug report, so it works outside a project too.
 *
 * @module
 */
import { type AnyCommand, defineCommand } from '../framework/command.ts'
import {
  declaredRange,
  dependencyNames,
  detectPackageManager,
  readInstalledPackage,
} from '../project/project.ts'
import { CLI_PACKAGE } from '../version.ts'

/** One Strutvane package in the project. */
export interface AboutPackage {
  readonly name: string
  /** The range in package.json. */
  readonly declared: string | undefined
  /** The installed version, or `null` if it is declared but not installed. */
  readonly installed: string | null
}

/** Strutvane-owned package names (scope plus the unscoped launcher and starter). */
export function isStrutvanePackage(name: string): boolean {
  return name.startsWith('@strutvane/') || name === 'strutvane' || name === 'create-strutvane'
}

export const aboutCommand: AnyCommand = defineCommand({
  name: 'about',
  description: 'Show versions of the CLI, Node.js and installed Strutvane packages',
  requiresProject: false,
  examples: ['sv about', 'sv about --json'],
  run(ctx) {
    const { project, out } = ctx
    const packages: AboutPackage[] =
      project === undefined
        ? []
        : dependencyNames(project.packageJson)
            .filter(isStrutvanePackage)
            .map((name) => ({
              name,
              declared: declaredRange(project.packageJson, name),
              installed: readInstalledPackage(project.root, name)?.version ?? null,
            }))
    const data = {
      cli: ctx.version,
      node: process.versions.node,
      platform: `${ctx.services.platform} ${process.arch}`,
      project:
        project === undefined
          ? null
          : {
              name:
                typeof project.packageJson['name'] === 'string'
                  ? project.packageJson['name']
                  : null,
              root: project.root,
              packageManager: detectPackageManager(project),
            },
      packages,
    }
    out.table(
      ['', ''],
      [
        [CLI_PACKAGE, data.cli],
        ['Node.js', data.node],
        ['Platform', data.platform],
        ...(data.project === null
          ? [['Project', out.style.dim('none (not inside a project)')]]
          : [
              ['Project', `${data.project.name ?? '(unnamed)'} (${data.project.root})`],
              ['Package manager', data.project.packageManager],
            ]),
      ],
    )
    if (packages.length > 0) {
      out.line()
      out.table(
        ['Package', 'Declared', 'Installed'],
        packages.map((p) => [
          p.name,
          p.declared ?? '',
          p.installed ?? out.style.yellow('not installed'),
        ]),
      )
    }
    return { data }
  },
})
