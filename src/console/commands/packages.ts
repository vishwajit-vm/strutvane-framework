/**
 * `node strut add <package>` and `node strut remove <package>` (docs/09 §2).
 *
 * `add` installs the package with the project's package manager (if needed), then runs its
 * installer through devkit: every file, `.env` entry, dependency and provider registration is
 * staged and committed as one transaction, previewable with `--dry-run --diff`. `remove` runs the
 * installer's `uninstall()` first (while the package is still present), then removes the
 * dependency. Undeclared flags are passed to the installer as answers (`--methods email`).
 *
 * First-party packages are installed from this CLI's release channel (`@strutvane/auth@next`
 * while the CLI is a `next` prerelease; the bare name on `latest`), because before 1.0 a bare
 * name resolves npm's `latest` tag, which is only the name placeholder. Third-party plugins are
 * installed by their bare name. See `project/channel.ts`.
 *
 * Security: package names are validated before anything runs (no paths, URLs or `file:`
 * specs), the installer module must resolve inside the package's directory in `node_modules`,
 * and a package whose `strutvane.compat` excludes this CLI is refused (exit 7).
 *
 * @module
 */
import {
  type DevkitInstaller,
  type FileChange,
  type InstallResult,
  runInstaller,
} from '../../devkit/index.ts'
import {
  type AnyCommand,
  type CommandContext,
  defineCommand,
  type Project,
} from '../framework/command.ts'
import { CliError, usageError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { refreshRegistry } from '../make/apply.ts'
import { channelSpec } from '../project/channel.ts'
import {
  assertCompatible,
  importFile,
  pickExport,
  resolveContribution,
} from '../project/contributions.ts'
import {
  dependencyNames,
  detectPackageManager,
  expandPackageName,
  isValidPackageName,
  loadProject,
  packageManagerCommand,
  readInstalledPackage,
} from '../project/project.ts'
import { isStrutvanePackage } from './about.ts'

/** Validate and expand a package argument (`auth` → `@strutvane/auth`). */
export function packageArgument(input: string): string {
  const name = expandPackageName(input.trim())
  if (!isValidPackageName(name)) throw usageError('invalid_package_name', { name: input })
  return name
}

/**
 * What to pass to the package manager to install `name`: first-party packages on the release
 * channel of `cliVersion` (see `project/channel.ts`), anything else by its bare name.
 */
export function installSpec(name: string, cliVersion: string): string {
  return isStrutvanePackage(name) ? channelSpec(name, cliVersion) : name
}

/** Run the package manager; a non-zero exit is a `command_failed` error. */
export async function runPackageManager(
  ctx: CommandContext,
  project: Project,
  action: 'add' | 'remove',
  packages: readonly string[],
): Promise<void> {
  const pm = detectPackageManager(project)
  const { command, args } = packageManagerCommand(pm, action, packages)
  ctx.out.info(`$ ${command} ${args.join(' ')}`)
  const result = await ctx.services.spawn(command, args, {
    cwd: project.root,
    stdio: ctx.globals.json ? 'pipe' : 'inherit',
  })
  if (result.code !== 0) {
    throw new CliError('command_failed', {
      exitCode: EXIT.FAILURE,
      params: { command: `${command} ${args.join(' ')}`, code: result.code },
    })
  }
}

/** Load a package's installer (`strutvane.installer`), validating its shape. */
async function loadInstaller(
  ctx: CommandContext,
  project: Project,
  name: string,
): Promise<DevkitInstaller | undefined> {
  const pkg = readInstalledPackage(project.root, name)
  if (pkg === undefined) {
    throw new CliError('package_not_installed', { exitCode: EXIT.FAILURE, params: { name } })
  }
  assertCompatible(pkg, ctx.version)
  const path = resolveContribution(pkg, 'installer')
  if (path === undefined) return undefined
  const installer = pickExport(await importFile(path), 'installer')
  if (
    typeof installer !== 'object' ||
    installer === null ||
    typeof (installer as { install?: unknown }).install !== 'function' ||
    typeof (installer as { name?: unknown }).name !== 'string'
  ) {
    throw new CliError('invalid_contribution', {
      exitCode: EXIT.FAILURE,
      params: { name, key: 'installer', detail: 'expected an object with a name and install()' },
    })
  }
  return installer as DevkitInstaller
}

/** Print an installer result (files, messages, optional diff). */
function report(ctx: CommandContext, result: InstallResult): void {
  const { out } = ctx
  const verb = (c: FileChange): string => `${result.dryRun ? 'would ' : ''}${c.kind}`
  for (const change of result.changes)
    out.line(`  ${out.style.green(verb(change).padEnd(12))} ${change.path}`)
  if (ctx.globals.diff && result.diff !== '') out.raw(result.diff)
}

/** The `--json` data of add/remove. */
function summary(name: string, installed: boolean, result: InstallResult | undefined): unknown {
  return {
    package: name,
    installedPackage: installed,
    installer: result?.installer ?? null,
    dryRun: result?.dryRun ?? false,
    changes: (result?.changes ?? []).map((c) => ({ path: c.path, kind: c.kind })),
    messages: result?.messages ?? [],
  }
}

export const addCommand: AnyCommand = defineCommand({
  name: 'add',
  description: 'Install a package and run its installer (config, env, routes, migrations…)',
  details:
    'Flags the CLI does not know are passed to the installer, e.g. `node strut add auth --methods email`.',
  args: {
    package: { required: true, description: 'auth, ui, @strutvane/files, strutvane-plugin-x…' },
  },
  allowUnknownFlags: true,
  examples: ['node strut add auth', 'node strut add auth --methods email,google --dry-run --diff'],
  async run(ctx) {
    const project = ctx.requireProject()
    const name = packageArgument(ctx.args.package)
    const alreadyInstalled = readInstalledPackage(project.root, name) !== undefined
    if (!alreadyInstalled) {
      if (ctx.globals.dryRun) {
        ctx.out.line(`  would install ${name} and run its installer`)
        ctx.out.info('Dry run: the installer can only be previewed once the package is installed.')
        return { data: summary(name, false, undefined) }
      }
      await runPackageManager(ctx, project, 'add', [installSpec(name, ctx.version)])
    }
    const fresh = loadProject(project.root)
    const installer = await loadInstaller(ctx, fresh, name)
    if (installer === undefined) {
      ctx.out.success(`${name} is installed (it has no installer, so there is nothing else to do).`)
      return { data: summary(name, true, undefined) }
    }
    const result = await runInstaller(installer, {
      projectRoot: project.root,
      answers: ctx.extraFlags,
      dryRun: ctx.globals.dryRun,
      installedPackages: dependencyNames(fresh.packageJson),
      mode: 'install',
      logger: { info: (m) => ctx.out.info(m), warn: (m) => ctx.out.warn(m) },
    })
    report(ctx, result)
    if (!result.dryRun && result.committed) refreshRegistry(ctx, project.root)
    ctx.out.success(
      result.dryRun
        ? `Dry run of ${installer.name}: ${result.changes.length} change(s), nothing written.`
        : `Added ${name} (${result.changes.length} file(s) changed).`,
    )
    return { data: summary(name, true, result) }
  },
})

export const removeCommand: AnyCommand = defineCommand({
  name: 'remove',
  description: "Reverse a package's installer, then uninstall it (edited files are kept)",
  args: { package: { required: true, description: 'Package to remove' } },
  flags: {
    'keep-data': { type: 'boolean', description: 'Keep database tables and stored data' },
    'keep-package': {
      type: 'boolean',
      description: 'Only reverse the installer; keep the dependency',
    },
  },
  allowUnknownFlags: true,
  examples: ['node strut remove auth --dry-run', 'node strut remove auth --keep-data'],
  async run(ctx) {
    const project = ctx.requireProject()
    const name = packageArgument(ctx.args.package)
    if (readInstalledPackage(project.root, name) === undefined) {
      throw new CliError('package_not_installed', { exitCode: EXIT.FAILURE, params: { name } })
    }
    const installer = await loadInstaller(ctx, project, name)
    let result: InstallResult | undefined
    if (installer !== undefined) {
      result = await runInstaller(installer, {
        projectRoot: project.root,
        answers: { ...ctx.extraFlags, keepData: ctx.flags['keep-data'] === true },
        dryRun: ctx.globals.dryRun,
        installedPackages: dependencyNames(project.packageJson),
        mode: 'uninstall',
        logger: { info: (m) => ctx.out.info(m), warn: (m) => ctx.out.warn(m) },
      })
      report(ctx, result)
    }
    if (ctx.globals.dryRun) {
      if (ctx.flags['keep-package'] !== true) ctx.out.line(`  would uninstall ${name}`)
      ctx.out.info('Dry run: nothing was written.')
      return { data: summary(name, true, result) }
    }
    if (ctx.flags['keep-package'] !== true) await runPackageManager(ctx, project, 'remove', [name])
    refreshRegistry(ctx, project.root)
    ctx.out.success(`Removed ${name}.`)
    return { data: summary(name, ctx.flags['keep-package'] === true, result) }
  },
})
