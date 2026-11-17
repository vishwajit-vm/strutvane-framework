/**
 * `node strut make:command`, `make:rule` and `make:observer`: app generators, like artisan's.
 *
 * They behave like every other `make:*` (devkit's staged writes): `--dry-run` writes nothing,
 * `--diff` shows the change, an existing file is never replaced without `--force`, and a second run
 * with the same input changes nothing. Unlike the model generators they don't rebuild the
 * `strutvane.config.ts` registry: these files are wired up by hand (`withCommands`, a form request,
 * a provider), as their comments say.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { defineGenerator, type Generator, runGenerator } from '../../../devkit/index.ts'
import { type AnyCommand, COMMAND_NAME, type CommandContext } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import { type Names, names } from '../../make/names.ts'
import { commandStub, observerStub, ruleStub } from './stubs.ts'
import { appRoot, commandError, defineAppCommand } from './support.ts'

const FileInput = z.object({ path: z.string(), content: z.string() })

/** One generator for every app stub: the command computed the file, devkit stages it. */
const appFileGenerator: Generator<z.infer<typeof FileInput>> = defineGenerator({
  name: 'app-file',
  inputs: FileInput,
  files: (input) => [{ path: input.path, content: input.content }],
})

/** Strip a trailing type word (`SendReportsCommand` → `SendReports`), then derive the names. */
function baseNames(input: string, suffix: string, what: string): Names {
  const trimmed =
    input.endsWith(suffix) && input !== suffix ? input.slice(0, -suffix.length) : input
  return names(trimmed, what)
}

/** Write one file with the universal flags (`--dry-run`, `--diff`, `--force`). */
async function writeAppFile(
  ctx: CommandContext,
  path: string,
  content: string,
  next: string,
): Promise<{ readonly path: string; readonly action: string; readonly dryRun: boolean }> {
  const root = appRoot(ctx)
  const input = { path, content }
  // --force replaces an existing file; without it devkit refuses (file_exists, exit 4).
  const generator: Generator<z.infer<typeof FileInput>> = ctx.globals.force
    ? { ...appFileGenerator, files: (file) => [{ ...file, overwrite: true }] }
    : appFileGenerator
  const preview = await runGenerator(generator, input, { projectRoot: root, dryRun: true })
  if (ctx.globals.diff && preview.changes.length > 0) ctx.out.raw(preview.diff)
  const dryRun = ctx.globals.dryRun
  const change = preview.changes[0]
  if (change === undefined) {
    ctx.out.success(`Nothing to do: ${path} is already up to date.`)
    return { path, action: 'unchanged', dryRun }
  }
  if (!dryRun) await runGenerator(generator, input, { projectRoot: root, dryRun: false })
  ctx.out.line(`  ${ctx.out.style.green(`${dryRun ? 'would ' : ''}${change.kind}`)} ${path}`)
  if (dryRun) ctx.out.info('Dry run: nothing was written.')
  else ctx.out.line(`Next: ${next}`)
  return { path, action: change.kind, dryRun }
}

/**
 * The `make:command`, `make:rule` and `make:observer` commands.
 *
 * @example
 * appMakeCommands()
 */
export function appMakeCommands(): readonly AnyCommand[] {
  return [
    defineAppCommand({
      name: 'make:command',
      description: 'Create a console command in app/console/commands',
      requiresProject: false,
      args: { name: { required: true, description: 'The command class name, e.g. SendReports' } },
      flags: {
        command: {
          type: 'string',
          valueName: '<name>',
          description: 'The name to run it by (default: app:<name>)',
        },
      },
      examples: [
        'node strut make:command SendReports',
        'node strut make:command SendReports --command=reports:send',
      ],
      async run(ctx) {
        const n = baseNames(ctx.args.name, 'Command', 'Command name')
        const command = ctx.flags.command ?? `app:${n.kebab}`
        if (!COMMAND_NAME.test(command))
          throw commandError(
            'invalid_command_name',
            `"${command}" is not a valid command name.`,
            'Use lowercase words joined by "-", in colon-separated groups, e.g. reports:send.',
            EXIT.USAGE,
          )
        const path = `app/console/commands/${n.kebab}.command.ts`
        const result = await writeAppFile(
          ctx,
          path,
          commandStub(n, command),
          `register it in bootstrap/app.ts with .withCommands([${n.camel}Command]), then run node strut ${command}`,
        )
        return { data: { ...result, command } }
      },
    }),
    defineAppCommand({
      name: 'make:rule',
      description: 'Create a validation rule in app/rules',
      requiresProject: false,
      args: { name: { required: true, description: 'The rule name, e.g. Uppercase' } },
      examples: ['node strut make:rule Uppercase'],
      async run(ctx) {
        const n = baseNames(ctx.args.name, 'Rule', 'Rule name')
        const path = `app/rules/${n.kebab}.rule.ts`
        const result = await writeAppFile(
          ctx,
          path,
          ruleStub(n),
          `use ${n.camel}Rule in a form request's rules()`,
        )
        return { data: result }
      },
    }),
    defineAppCommand({
      name: 'make:observer',
      description: 'Create a model observer in app/observers',
      requiresProject: false,
      args: { name: { required: true, description: 'The observer name, e.g. PostObserver' } },
      flags: {
        model: {
          type: 'string',
          valueName: '<Model>',
          description: 'The model it observes (default: from the name)',
        },
      },
      examples: [
        'node strut make:observer PostObserver',
        'node strut make:observer Audit --model=Post',
      ],
      async run(ctx) {
        const n = baseNames(ctx.args.name, 'Observer', 'Observer name')
        const model = names(ctx.flags.model ?? n.pascal, 'Model name')
        const root = appRoot(ctx)
        const modelFile = [`${model.kebab}.ts`, `${model.kebab}.model.ts`].find((file) =>
          existsSync(join(root, 'app', 'models', file)),
        )
        const path = `app/observers/${n.kebab}.observer.ts`
        const result = await writeAppFile(
          ctx,
          path,
          observerStub(n, model, modelFile === undefined ? undefined : `../models/${modelFile}`),
          `attach ${n.pascal}Observer to ${model.pascal} in a provider's boot()`,
        )
        return { data: { ...result, model: model.pascal, modelFound: modelFile !== undefined } }
      },
    }),
  ]
}
