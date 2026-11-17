/**
 * `node strut registry:build` and `node strut registry:watch`: the typed registry compiler (ADR-0010).
 *
 * The compiler reads convention files statically (never runs app code) and writes the
 * deterministic `.strutvane/registry.gen.ts`. On any error nothing is written (keep last good).
 *
 * @module
 */
import { relative } from 'node:path'
import { type AnyCommand, defineCommand } from '../framework/command.ts'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import type { Output } from '../framework/output.ts'
import type { CompileResult, WriteResult } from '../registry/compiler.ts'
import { RegistryCompiler } from '../registry/compiler.ts'
import { OUTPUT_FILE } from '../registry/conventions.ts'
import { type Diagnostic, formatDiagnostic } from '../registry/errors.ts'
import { watchProject } from '../registry/watch.ts'

/** Summary of a compile for `--json`. */
export function compileSummary(result: CompileResult): {
  ok: boolean
  diagnostics: readonly Diagnostic[]
  stats: CompileResult['stats']
  counts: Record<string, number> | null
} {
  const r = result.registry
  return {
    ok: result.output !== undefined,
    diagnostics: result.diagnostics,
    stats: { ...result.stats, ms: Math.round(result.stats.ms * 10) / 10 },
    counts:
      r === undefined
        ? null
        : {
            models: r.models.length,
            resources: r.resources.length,
            policies: r.policies.length,
            routes: r.routes.length,
            jobs: r.jobs.length,
            listeners: r.listeners.length,
            commands: r.commands.length,
            pages: r.pages.length,
            permissions: r.permissions.length,
          },
  }
}

function printDiagnostics(out: Output, diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    const text = formatDiagnostic(d)
    if (d.severity === 'error') out.line(`${out.style.red('✖')} ${text}`)
    else out.warn(text)
  }
}

function errorCount(result: CompileResult): number {
  return result.diagnostics.filter((d) => d.severity === 'error').length
}

export const registryBuildCommand: AnyCommand = defineCommand({
  name: 'registry:build',
  description: 'Compile app conventions into the typed .strutvane/registry.gen.ts',
  details: [
    'Reads app/models, app/resources, app/policies, app/http/routes, app/jobs, app/listeners,',
    'app/commands and web/pages without running them. With --check nothing is written and the',
    'command exits 6 when the file is stale (for CI).',
  ].join('\n'),
  flags: {
    check: {
      type: 'boolean',
      description: 'Fail (exit 6) if the registry is out of date; write nothing',
    },
  },
  examples: ['node strut registry:build', 'node strut registry:build --check'],
  run(ctx) {
    const root = ctx.requireProject().root
    const compiler = new RegistryCompiler(root)
    const check = ctx.flags.check === true || ctx.globals.dryRun
    const outcome = check ? { result: compiler.compile(), written: false } : compiler.write()
    const { result } = outcome
    printDiagnostics(ctx.out, result.diagnostics)
    const summary = compileSummary(result)
    if (result.output === undefined) {
      throw new CliError('registry_errors', {
        exitCode: EXIT.VALIDATION,
        params: { count: errorCount(result) },
        data: summary,
      })
    }
    if (check) {
      const stale = !compiler.isCurrent(result)
      if (stale && ctx.flags.check === true) {
        throw new CliError('registry_stale', {
          exitCode: EXIT.PENDING,
          params: { path: OUTPUT_FILE },
          data: { ...summary, stale },
        })
      }
      ctx.out.success(
        stale ? `${OUTPUT_FILE} would be updated (dry run).` : `${OUTPUT_FILE} is up to date.`,
      )
      return { data: { ...summary, stale, written: false } }
    }
    const written = outcome.written
    ctx.out.success(
      `${written ? 'Wrote' : 'Up to date:'} ${relative(root, compiler.outputPath).replaceAll('\\', '/')} ` +
        `(${result.stats.files} files, ${summary.stats.ms} ms)`,
    )
    return { data: { ...summary, written } }
  },
})

export const registryWatchCommand: AnyCommand = defineCommand({
  name: 'registry:watch',
  description: 'Rebuild the registry whenever app/ or web/ changes (Ctrl+C to stop)',
  flags: {
    debounce: {
      type: 'string',
      valueName: '<ms>',
      default: '25',
      description: 'Quiet period before a rebuild',
    },
  },
  examples: ['node strut registry:watch'],
  async run(ctx) {
    const root = ctx.requireProject().root
    const debounceMs = Number(ctx.flags.debounce)
    if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 10_000) {
      throw new CliError('invalid_flag_value', {
        exitCode: EXIT.USAGE,
        params: { detail: '--debounce must be between 0 and 10000 ms.', command: ctx.command },
      })
    }
    let builds = 0
    const report = ({ result, written }: WriteResult): void => {
      builds++
      printDiagnostics(ctx.out, result.diagnostics)
      if (result.output === undefined) {
        ctx.out.line(
          `${ctx.out.style.red('✖')} ${errorCount(result)} error(s); keeping the last good registry`,
        )
      } else if (written) {
        ctx.out.success(`registry updated (${result.stats.files} files)`)
      }
    }
    const signal = ctx.services.signal
    await new Promise<void>((resolve) => {
      const handle = watchProject(root, {
        debounceMs,
        onResult: report,
        onError: (error) =>
          ctx.out.warn(`rebuild failed: ${error instanceof Error ? error.message : String(error)}`),
      })
      ctx.out.info(`Watching ${root} (Ctrl+C to stop)`)
      const stop = (): void => {
        handle.close()
        resolve()
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    })
    return { data: { builds } }
  },
})
