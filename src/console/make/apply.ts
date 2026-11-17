/**
 * Running a generator for a command: the behaviour every `make:*` shares (docs/09 §3).
 *
 * - `--dry-run` stages everything and writes nothing (devkit discards the stage);
 * - `--diff` prints a unified diff; without `--dry-run` it asks before writing;
 * - existing files are never overwritten unless `--force`, and files tracked in
 *   `.strutvane/lock.json` (ejected, owned code) are never overwritten at all: they are merged by
 *   `node strut upgrade`;
 * - a second run with the same input changes nothing (identical files are not changes), so
 *   generators are idempotent;
 * - after writing, the registry is rebuilt so new models, resources and policies are wired up
 *   without manual steps.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type FileChange,
  type GeneratedFile,
  type Generator,
  nodeIo,
  readLock,
  runGenerator,
} from '../../devkit/index.ts'
import type { CommandContext } from '../framework/command.ts'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { RegistryCompiler } from '../registry/compiler.ts'
import { formatDiagnostic } from '../registry/errors.ts'

/** One file a generator produced, and what happened to it. */
export interface GeneratedFileResult {
  readonly path: string
  readonly action: 'create' | 'update' | 'unchanged'
}

/** The `data` of a generator command's result. */
export interface GenerateData {
  readonly generator: string
  readonly dryRun: boolean
  readonly files: readonly GeneratedFileResult[]
  /** Unified diff, included with `--diff`. */
  readonly diff?: string
  /** Whether `.strutvane/registry.gen.ts` was rewritten. */
  readonly registryUpdated: boolean
}

/** Paths in `.strutvane/lock.json` (owned files). */
async function ownedPaths(projectRoot: string): Promise<Set<string>> {
  const lock = await readLock(nodeIo, projectRoot)
  return new Set(lock.status === 'ok' ? Object.keys(lock.lock.files) : [])
}

/** Rebuild the registry after generation; diagnostics become warnings (keep-last-good). */
export function refreshRegistry(ctx: CommandContext, projectRoot: string): boolean {
  if (!existsSync(join(projectRoot, 'app')) && !existsSync(join(projectRoot, 'web'))) return false
  const { result, written } = new RegistryCompiler(projectRoot).write()
  for (const d of result.diagnostics) {
    if (d.severity === 'error' || ctx.globals.verbose) ctx.out.warn(formatDiagnostic(d))
  }
  return written
}

/**
 * Run `generator` with `input` for the current project, honouring the universal flags. `next`
 * is printed after a successful write (the follow-up command).
 *
 * `extra` files are edits of existing project files the command computed itself (e.g. the seeder
 * registration in `database.seeder.ts`). They are part of the same transaction, preview and diff
 * as the generated files, and always replace the current content (they were derived from it).
 */
export async function applyGenerator<Input>(
  ctx: CommandContext,
  generator: Generator<Input>,
  input: Input,
  next?: string,
  extra: readonly GeneratedFile[] = [],
): Promise<GenerateData> {
  const projectRoot = ctx.requireProject().root
  const force = ctx.globals.force
  const owned = force ? await ownedPaths(projectRoot) : new Set<string>()
  let produced: GeneratedFile[] = []
  const wrapped: Generator<Input> = {
    ...generator,
    async files(validated) {
      const generated = await generator.files(validated)
      produced = [...generated, ...extra]
      return [
        ...generated.map((file) => {
          if (force && owned.has(file.path) && existsSync(join(projectRoot, file.path))) {
            throw new CliError('owned_file', {
              exitCode: EXIT.CONFLICT,
              params: { path: file.path },
            })
          }
          return force ? { ...file, overwrite: true } : file
        }),
        ...extra.map((file) => ({ ...file, overwrite: true })),
      ]
    },
  }

  const preview = await runGenerator(wrapped, input, { projectRoot, dryRun: true })
  const showDiff = ctx.globals.diff && preview.changes.length > 0
  if (showDiff) ctx.out.raw(preview.diff)

  let changes: readonly FileChange[] = preview.changes
  const dryRun = ctx.globals.dryRun
  if (!dryRun && preview.changes.length > 0) {
    if (
      ctx.globals.diff &&
      !(await ctx.prompt.confirm('Write these changes?', { default: true }))
    ) {
      throw new CliError('interrupted', { exitCode: EXIT.INTERRUPTED })
    }
    changes = (await runGenerator(wrapped, input, { projectRoot, dryRun: false })).changes
  }

  const byPath = new Map(changes.map((c) => [c.path, c.kind]))
  const files: GeneratedFileResult[] = produced.map((file) => {
    const kind = byPath.get(file.path)
    return { path: file.path, action: kind === 'create' || kind === 'update' ? kind : 'unchanged' }
  })

  const verb = dryRun ? 'would ' : ''
  for (const file of files) {
    if (file.action === 'unchanged')
      ctx.out.line(`  ${ctx.out.style.dim('unchanged')} ${file.path}`)
    else {
      const label = file.action === 'create' ? `${verb}create` : `${verb}update`
      ctx.out.line(`  ${ctx.out.style.green(label.padEnd(9))} ${file.path}`)
    }
  }

  let registryUpdated = false
  if (changes.length === 0) {
    ctx.out.success('Nothing to do: every file is already up to date.')
  } else if (dryRun) {
    ctx.out.info('Dry run: nothing was written.')
  } else {
    registryUpdated = refreshRegistry(ctx, projectRoot)
    ctx.out.success(`${generator.name}: ${changes.length} file(s) written.`)
    if (next !== undefined) ctx.out.line(`Next: ${next}`)
  }

  return {
    generator: generator.name,
    dryRun,
    files,
    ...(ctx.globals.diff ? { diff: preview.diff } : {}),
    registryUpdated,
  }
}
