/**
 * `sv upgrade`: bump Strutvane packages, then three-way merge owned (ejected) files (ADR-0012).
 *
 * 1. With `--to <version>` or `--channel <tag>`, every `@strutvane/*` dependency (and the
 *    `strutvane` launcher) is bumped through the project's package manager.
 * 2. Each installed package may export the new versions of its templates from
 *    `strutvane.templates` (a module whose default export is a list of `TemplateOutput`, or a
 *    function returning one). devkit plans the merge against the bases recorded in
 *    `.strutvane/lock.json`, previews it, and applies it as one transaction.
 * 3. Conflicts are written with markers and exit 4; then the project's own `tsc --noEmit` runs
 *    (if TypeScript is installed) so a broken upgrade is caught immediately.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyUpgrade,
  planUpgrade,
  renderUpgradePreview,
  type TemplateOutput,
} from '../../devkit/index.ts'
import {
  type AnyCommand,
  type CommandContext,
  defineCommand,
  type Project,
} from '../framework/command.ts'
import { CliError, usageError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import {
  assertCompatible,
  importFile,
  pickExport,
  resolveContribution,
} from '../project/contributions.ts'
import {
  dependencyNames,
  detectPackageManager,
  isContributorName,
  loadProject,
  packageManagerCommand,
  readInstalledPackage,
} from '../project/project.ts'

const TAG = /^[a-z][a-z0-9-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function isTemplateOutput(value: unknown): value is TemplateOutput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return ['path', 'template', 'version', 'content'].every((k) => typeof v[k] === 'string')
}

/** Collect the new template outputs from every contributing package. */
export async function collectTemplates(
  project: Project,
  cliVersion: string,
): Promise<TemplateOutput[]> {
  const outputs: TemplateOutput[] = []
  for (const name of dependencyNames(project.packageJson).filter(isContributorName)) {
    const pkg = readInstalledPackage(project.root, name)
    if (pkg === undefined) continue
    const path = resolveContribution(pkg, 'templates')
    if (path === undefined) continue
    assertCompatible(pkg, cliVersion)
    let exported = pickExport(await importFile(path), 'templates')
    if (typeof exported === 'function') exported = await exported({ projectRoot: project.root })
    if (!Array.isArray(exported) || !exported.every(isTemplateOutput)) {
      throw new CliError('invalid_contribution', {
        exitCode: EXIT.FAILURE,
        params: {
          name,
          key: 'templates',
          detail: 'expected a list of { path, template, version, content }',
        },
      })
    }
    outputs.push(...exported)
  }
  return outputs
}

/** Bump Strutvane dependencies to `spec` (a version or dist-tag). */
async function bump(ctx: CommandContext, project: Project, spec: string): Promise<string[]> {
  const targets = dependencyNames(project.packageJson).filter(
    (n) => n.startsWith('@strutvane/') || n === 'strutvane',
  )
  if (targets.length === 0) return []
  const pm = detectPackageManager(project)
  const { command, args } = packageManagerCommand(
    pm,
    'add',
    targets.map((t) => `${t}@${spec}`),
  )
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
  return targets
}

/** Run the project's TypeScript compiler, if installed. Returns `undefined` when skipped. */
async function typecheck(ctx: CommandContext, root: string): Promise<boolean | undefined> {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) return undefined
  ctx.out.info('$ tsc --noEmit')
  const result = await ctx.services.spawn(ctx.services.execPath, [tsc, '--noEmit'], {
    cwd: root,
    stdio: ctx.globals.json ? 'pipe' : 'inherit',
  })
  return result.code === 0
}

export const upgradeCommand: AnyCommand = defineCommand({
  name: 'upgrade',
  description: 'Bump Strutvane packages and three-way merge owned files',
  flags: {
    to: {
      type: 'string',
      valueName: '<version>',
      description: 'Target version for every Strutvane package',
    },
    channel: {
      type: 'string',
      valueName: '<tag>',
      description: 'Target dist-tag instead: next, canary…',
    },
    typecheck: {
      type: 'boolean',
      default: true,
      description: 'Run tsc --noEmit afterwards (--no-typecheck to skip)',
    },
  },
  examples: ['sv upgrade --dry-run', 'sv upgrade --to 0.2.0', 'sv upgrade --channel next'],
  async run(ctx) {
    let project = ctx.requireProject()
    const { to, channel } = ctx.flags
    if (to !== undefined && channel !== undefined) {
      throw usageError('invalid_argument', { detail: 'Pass either --to or --channel, not both.' })
    }
    if (to !== undefined && !VERSION.test(to)) {
      throw usageError('invalid_argument', { detail: `--to "${to}" is not a version like 0.2.0.` })
    }
    if (channel !== undefined && !TAG.test(channel)) {
      throw usageError('invalid_argument', { detail: `--channel "${channel}" is not a dist-tag.` })
    }
    const spec = to ?? channel
    let bumped: string[] = []
    if (spec !== undefined) {
      if (ctx.globals.dryRun) ctx.out.line(`  would update Strutvane packages to ${spec}`)
      else {
        bumped = await bump(ctx, project, spec)
        project = loadProject(project.root)
      }
    }

    const templates = await collectTemplates(project, ctx.version)
    const plan = await planUpgrade({ projectRoot: project.root, templates })
    const items = plan.items.map((i) => ({
      path: i.path,
      action: i.action,
      conflicts: i.conflicts.length,
    }))
    if (ctx.globals.dryRun || ctx.globals.diff) ctx.out.raw(renderUpgradePreview(plan))
    else for (const note of plan.notes) ctx.out.info(note)
    const changing = plan.items.filter((i) => i.after !== undefined)
    for (const blocked of plan.items.filter((i) => i.action === 'blocked')) {
      ctx.out.warn(`${blocked.path} was not upgraded: ${blocked.notes.join(' ')}`)
    }
    const base = { bumped, templates: templates.length, items, notes: plan.notes }
    if (ctx.globals.dryRun) {
      ctx.out.info('Dry run: nothing was written.')
      return { data: { ...base, dryRun: true, written: [], conflicted: [] } }
    }
    if (changing.length === 0 && plan.items.length === 0) {
      ctx.out.success(
        templates.length === 0 ? 'No owned files to upgrade.' : 'Owned files are up to date.',
      )
    }
    const applied =
      plan.items.length === 0
        ? { written: [], conflicted: [] }
        : await applyUpgrade({ projectRoot: project.root, plan })
    const data = {
      ...base,
      dryRun: false,
      written: applied.written,
      conflicted: applied.conflicted,
    }
    if (applied.conflicted.length > 0) {
      throw new CliError('merge_conflicts', {
        exitCode: EXIT.CONFLICT,
        params: { count: applied.conflicted.length, files: applied.conflicted.join(', ') },
        data,
      })
    }
    if (applied.written.length > 0)
      ctx.out.success(`Upgraded ${applied.written.length} owned file(s).`)
    if (ctx.flags.typecheck && (bumped.length > 0 || applied.written.length > 0)) {
      const passed = await typecheck(ctx, project.root)
      if (passed === false) {
        throw new CliError('typecheck_failed', {
          exitCode: EXIT.FAILURE,
          data: { ...data, typecheck: false },
        })
      }
      return { data: { ...data, typecheck: passed ?? null } }
    }
    return { data: { ...data, typecheck: null } }
  },
})
