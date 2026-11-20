/**
 * `node strut design:use <name>`: switch the look of the React UI to another design package
 * (blueprint §5.1: `@strutvane/ui` is behaviour only; `@strutvane/design-crisp` (the default) and
 * `@strutvane/design-vivid` give it its look). The installer's summary and the skeleton's
 * `config/ui.ts` both tell people to run it (acceptance FW-14, INST-2).
 *
 * What it changes, and nothing else:
 * 1. installs `@strutvane/design-<name>` (on the CLI's release channel) unless it is installed;
 * 2. `config/ui.ts`: `design: '<old>'` → `design: '<name>'`;
 * 3. `resources/ui/main.tsx`: the design import and the `designs['<old>']` key;
 * 4. `strutvane.json`: the recorded design and package, when the installer wrote them;
 * 5. removes the old design package.
 *
 * Failure scenarios, named: an unknown or malformed name is refused before anything runs; an
 * install that fails changes no file; a file in a shape it does not recognise is left alone and
 * the line to change is printed (never a guess); a failing removal of the old package is a
 * warning with the command to run, since the switch itself is done. `theme.css` is the app's own
 * and is never touched, so overrides survive the switch. `--dry-run` writes and installs nothing.
 *
 * @module
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AnyCommand, type CommandContext, defineCommand } from '../framework/command.ts'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import {
  dependencyNames,
  detectPackageManager,
  packageManagerCommand,
  readInstalledPackage,
} from '../project/project.ts'
import { commandError } from './app/support.ts'
import { installSpec, runPackageManager } from './packages.ts'

/** The first-party designs (the catalogue; a new design package is added here). */
export const DESIGNS: readonly string[] = Object.freeze(['crisp', 'vivid'])

/** The package of a design. */
export function designPackage(name: string): string {
  return `@strutvane/design-${name}`
}

/** `design: 'crisp'` in config/ui.ts (single or double quotes). */
const CONFIG_DESIGN = /(\bdesign\s*:\s*)(['"])([a-z][a-z0-9-]*)\2/

/** One planned file change. */
interface Edit {
  readonly file: string
  readonly before: string
  readonly after: string
}

/** The design `config/ui.ts` names, or `undefined` when it names none in a known shape. */
export function currentDesign(root: string): string | undefined {
  const file = join(root, 'config', 'ui.ts')
  if (!existsSync(file)) return undefined
  return CONFIG_DESIGN.exec(readFileSync(file, 'utf8'))?.[3]
}

/**
 * The edits that switch `from` → `to`, and the files it could not edit safely (with the change
 * to make by hand).
 */
export function planDesignSwitch(
  root: string,
  from: string,
  to: string,
): { readonly edits: readonly Edit[]; readonly manual: readonly string[] } {
  const edits: Edit[] = []
  const manual: string[] = []
  const change = (relative: string, transform: (text: string) => string, hint: string): void => {
    const file = join(root, relative)
    if (!existsSync(file)) return
    const before = readFileSync(file, 'utf8')
    const after = transform(before)
    if (after !== before) edits.push({ file: relative, before, after })
    else manual.push(`${relative}: ${hint}`)
  }
  change(
    join('config', 'ui.ts'),
    (text) =>
      text.replace(CONFIG_DESIGN, (_, key: string, quote: string) => `${key}${quote}${to}${quote}`),
    `set design: '${to}'`,
  )
  change(
    join('resources', 'ui', 'main.tsx'),
    (text) =>
      text
        .replaceAll(`'${designPackage(from)}'`, `'${designPackage(to)}'`)
        .replaceAll(`"${designPackage(from)}"`, `"${designPackage(to)}"`)
        .replaceAll(`designs['${from}']`, `designs['${to}']`)
        .replaceAll(`designs["${from}"]`, `designs["${to}"]`),
    `import the design from '${designPackage(to)}' and use its '${to}' export`,
  )
  const record = join(root, 'strutvane.json')
  if (existsSync(record)) {
    const text = readFileSync(record, 'utf8')
    const after = text
      .replace(new RegExp(`("design"\\s*:\\s*)"${from}"`), `$1"${to}"`)
      .replaceAll(`"${designPackage(from)}"`, `"${designPackage(to)}"`)
    if (after !== text) edits.push({ file: 'strutvane.json', before: text, after })
  }
  return { edits, manual }
}

export const designUseCommand: AnyCommand = defineCommand({
  name: 'design:use',
  description: 'Switch the UI to another design package (crisp, vivid)',
  details:
    'Installs @strutvane/design-<name>, points config/ui.ts and resources/ui/main.tsx at it and removes the old design. resources/ui/theme.css (your overrides) is kept.',
  args: { name: { required: true, description: DESIGNS.join(', ') } },
  examples: ['node strut design:use vivid', 'node strut design:use crisp --dry-run'],
  async run(ctx) {
    const project = ctx.requireProject()
    const root = project.root
    const name = ctx.args.name.trim().toLowerCase()
    if (!DESIGNS.includes(name))
      throw commandError(
        'unknown_design',
        `There is no design called "${name.slice(0, 40)}".`,
        `Choose one of: ${DESIGNS.join(', ')}.`,
        EXIT.USAGE,
      )
    const from = currentDesign(root)
    if (from === undefined)
      throw commandError(
        'no_ui_design',
        'config/ui.ts is missing or names no design, so this app has no UI design to switch.',
        `Add the UI first (an app made with --ui admin has it), or set design: '${name}' in config/ui.ts yourself.`,
        EXIT.VALIDATION,
      )
    const target = designPackage(name)
    const installed = readInstalledPackage(root, target) !== undefined
    if (from === name && installed) {
      ctx.out.success(`The UI already uses the ${name} design.`)
      return { data: { design: name, changed: false } }
    }
    const plan = planDesignSwitch(root, from, name)
    if (ctx.globals.dryRun) {
      if (!installed) ctx.out.line(`  would install ${target}`)
      for (const edit of plan.edits) ctx.out.line(`  would update ${edit.file.replace(/\\/g, '/')}`)
      for (const line of plan.manual) ctx.out.warn(`Change by hand: ${line}`)
      return { data: { design: name, changed: false, dryRun: true } }
    }
    // Install first: if it fails, no file has changed and the app still builds.
    if (!installed) await runPackageManager(ctx, project, 'add', [installSpec(target, ctx.version)])
    for (const edit of plan.edits) writeFileSync(join(root, edit.file), edit.after)
    for (const line of plan.manual) ctx.out.warn(`Change by hand: ${line}`)
    await removeOldDesign(ctx, project, from, name)
    ctx.out.success(
      `The UI now uses the ${name} design. Restart node strut dev, or run node strut build for production.`,
    )
    return {
      data: { design: name, previous: from, changed: true, files: plan.edits.map((e) => e.file) },
    }
  },
})

/** Remove the previous design package; a failure is a warning (the switch itself is done). */
async function removeOldDesign(
  ctx: CommandContext,
  project: ReturnType<CommandContext['requireProject']>,
  from: string,
  to: string,
): Promise<void> {
  const old = designPackage(from)
  if (from === to || !dependencyNames(project.packageJson).includes(old)) return
  try {
    await runPackageManager(ctx, project, 'remove', [old])
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    const { command, args } = packageManagerCommand(detectPackageManager(project), 'remove', [old])
    ctx.out.warn(`${old} could not be removed; remove it yourself (${command} ${args.join(' ')}).`)
  }
}
