/**
 * The runner: one command line in, one exit code out.
 *
 * `runCli` never calls `process.exit` and never writes to the real terminal directly: streams and
 * services are injected. `bin.ts` is the only place that touches the process. This keeps every
 * path (help, unknown commands, failures, `--json`) testable in-process, and makes the CLI safe
 * to embed (for example in `create-strutvane`).
 *
 * Order of operations:
 * 1. scan the line for the command words and output-mode flags;
 * 2. resolve the command among built-ins, then (only if needed) contributed commands;
 * 3. parse flags/arguments strictly against the command's declaration;
 * 4. check project requirements and the production guard;
 * 5. run, then render the result or the failure in text or JSON.
 *
 * @module
 */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Logger } from '../../contracts/index.ts'
import { createLogger, type ErrorParams } from '../../core/index.ts'
import {
  envFileOverlay,
  isSafeAppEnv,
  type ResolvedAppEnv,
  resolveAppEnv,
} from '../project/app-env.ts'
import { isValidEnvName } from '../project/env-check.ts'
import { packageMigrations } from '../project/package-migrations.ts'
import {
  type ContributedCommand,
  loadPluginCommands,
  mergeCommands,
  type PluginCommands,
} from '../project/plugin-commands.ts'
import { findProjectRoot, isAppRoot, loadProject } from '../project/project.ts'
import { CLI_PACKAGE, CLI_VERSION } from '../version.ts'
import type { AnyCommand, CommandContext, Project } from './command.ts'
import { CliError, type CliFailure, type CliIssue, toFailure, usageError } from './errors.ts'
import { EXIT } from './exit-codes.ts'
import { scanCommandLine } from './globals.ts'
import { renderCommandHelp, renderGlobalHelp, renderGroupHelp, summarize } from './help.ts'
import { createCliMessages } from './messages.ts'
import { createOutput, type Output, type OutputStreams, shouldUseColor } from './output.ts'
import { parseCommandLine } from './parse.ts'
import { printable } from './printable.ts'
import {
  createInteractivePrompter,
  createNonInteractivePrompter,
  type Prompter,
} from './prompter.ts'
import { createCommandTable, resolveCommand } from './router.ts'
import { type CliServices, createNodeServices } from './services.ts'

/** Version of the `--json` envelope. Bumped only on breaking changes to its shape. */
export const JSON_SCHEMA_VERSION = 1

/** The `--json` document every command prints (exactly one per run). */
export interface JsonEnvelope {
  readonly schemaVersion: typeof JSON_SCHEMA_VERSION
  readonly ok: boolean
  /** Canonical command name, or `null` when no command was resolved. */
  readonly command: string | null
  readonly exitCode: number
  readonly data: unknown
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly hint?: string
    readonly issues?: readonly CliIssue[]
  }
  readonly warnings: readonly string[]
}

/** Options for {@link runCli}. */
export interface RunOptions {
  /** Arguments after the executable, e.g. `['make:model', 'Invoice']`. */
  readonly argv: readonly string[]
  /** Base working directory. Default `process.cwd()`. */
  readonly cwd?: string
  /** Default: the process's stdout/stderr. */
  readonly streams?: OutputStreams
  /** Override individual services (tests: fake spawner, fixed clock, TTY on/off). */
  readonly services?: Partial<CliServices>
  /** The built-in command set. Default: every built-in command. */
  readonly builtins: readonly AnyCommand[]
  /** Force a prompter (tests). By default chosen from TTY and flags. */
  readonly prompter?: Prompter
  /** Version shown and checked against `strutvane.compat`. Default: the installed version. */
  readonly version?: string
  /**
   * Applies variables the runner resolved for the command (the normalised `APP_ENV`, plus
   * `.env.<name>` with `--env`) to the real process environment, so code a command loads
   * in-process reads the same values as the guard. `main()` passes a `process.env` writer; the
   * default does nothing (in-process callers and tests keep their environment untouched).
   */
  readonly applyEnv?: (vars: ReadonlyMap<string, string>) => void
  /**
   * The console commands an application registered (`Application.configure().withCommands([…])`),
   * for a project that is an app (`bootstrap/app.ts`). Loaded only when a command line is not an
   * exact built-in, so `node strut migrate` never imports the app. Default: import
   * `bootstrap/app.ts` and read `app.commands`.
   */
  readonly appCommands?: (root: string) => Promise<readonly AnyCommand[]>
}

/** The default {@link RunOptions.appCommands}: the app's own commands, without booting it. */
async function loadAppCommands(root: string): Promise<readonly AnyCommand[]> {
  const { loadApplication } = await import('../../foundation/load.ts')
  return (await loadApplication(root)).commands
}

const processStreams: OutputStreams = {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

interface RunState {
  out: Output
  command: string | null
  verbose: boolean
}

/** Run one command line and return the exit code. Never throws. */
export async function runCli(options: RunOptions): Promise<number> {
  const streams = options.streams ?? processStreams
  const services: CliServices = {
    ...createNodeServices(new AbortController().signal),
    ...options.services,
  }
  const version = options.version ?? CLI_VERSION
  const scan = scanCommandLine(options.argv)
  const color = shouldUseColor({ flag: scan.color, env: services.env, isTTY: services.isTTY })
  const state: RunState = {
    out: createOutput({ json: scan.json, color, quiet: scan.quiet, streams }),
    command: null,
    verbose: scan.verbose,
  }
  try {
    return await execute(options, services, version, scan, state, streams)
  } catch (error) {
    return renderFailure(toFailure(error), state, streams)
  }
}

async function execute(
  options: RunOptions,
  services: CliServices,
  version: string,
  scan: ReturnType<typeof scanCommandLine>,
  state: RunState,
  streams: OutputStreams,
): Promise<number> {
  const { out } = state
  const base = options.cwd ?? process.cwd()
  const cwd = scan.cwd === undefined ? base : resolve(base, scan.cwd)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw usageError('cwd_not_found', { cwd })
  }
  const root = findProjectRoot(cwd)
  const project = root === undefined ? undefined : loadProject(root)

  let plugins: PluginCommands | undefined
  let ownCommands: readonly ContributedCommand[] | undefined
  // The app's own commands (withCommands). An app that can't even be imported must not take the
  // CLI down: its commands are missing, with a warning saying why.
  const appCommandsOf = async (projectRoot: string): Promise<readonly ContributedCommand[]> => {
    if (ownCommands !== undefined) return ownCommands
    ownCommands = []
    if (!isAppRoot(projectRoot)) return ownCommands
    try {
      const commands = await (options.appCommands ?? loadAppCommands)(projectRoot)
      ownCommands = commands.map((command) => ({ command, source: 'bootstrap/app.ts' }))
    } catch (error) {
      out.warn(
        `The app's own commands were not loaded: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return ownCommands
  }
  const allCommands = async (): Promise<{
    commands: readonly AnyCommand[]
    sources: ReadonlyMap<string, string>
  }> => {
    plugins ??=
      project === undefined
        ? { commands: [], problems: [] }
        : await loadPluginCommands(project, version)
    const own = project === undefined ? [] : await appCommandsOf(project.root)
    const merged = mergeCommands(options.builtins, [...plugins.commands, ...own])
    for (const collision of merged.collisions) out.warn(collision)
    return merged
  }

  const words = scan.words
  if (scan.version && words.length === 0) {
    out.line(`strutvane ${version}`)
    return finish(state, streams, { version }, EXIT.OK)
  }

  // `node strut`, `node strut list`, `node strut help <command>`, `node strut --help`. `list` is
  // the command and `help` its alias, as in Laravel (CONSISTENCY #13).
  if (words.length === 0 || words[0] === 'list' || words[0] === 'help') {
    const target = words.slice(1)
    const { commands, sources } = await allCommands()
    if (target.length === 0) {
      out.raw(renderGlobalHelp(commands, version, out.style))
      return finish(state, streams, { version, commands: summarize(commands, sources) }, EXIT.OK)
    }
    const resolution = resolveCommand(createCommandTable(commands), target)
    if (resolution.kind === 'found') {
      const source = sources.get(resolution.command.name)
      out.raw(renderCommandHelp(resolution.command, out.style, source))
      return finish(state, streams, describe(resolution.command, source), EXIT.OK)
    }
    if (resolution.kind === 'group') {
      out.raw(renderGroupHelp(resolution.group, resolution.commands, out.style))
      return finish(
        state,
        streams,
        { group: resolution.group, commands: summarize(resolution.commands, sources) },
        EXIT.OK,
      )
    }
    throw unresolved(resolution, plugins)
  }

  // Built-ins first (fast path: no plugin code is loaded), then the merged set. Only an exact
  // built-in name (or alias) takes the fast path: an abbreviation such as `make:mod` could also be
  // the exact name of a contributed command, or match one, which only the merged set can tell.
  const builtinTable = createCommandTable(options.builtins.filter((c) => c.placeholder !== true))
  let resolution = resolveCommand(builtinTable, words)
  const exactBuiltin =
    resolution.kind === 'found' &&
    builtinTable.get(words.slice(0, resolution.consumed).join(':')) !== undefined
  let sources: ReadonlyMap<string, string> = new Map()
  if (!exactBuiltin) {
    const merged = await allCommands()
    sources = merged.sources
    resolution = resolveCommand(createCommandTable(merged.commands), words)
  }
  if (resolution.kind === 'group') {
    out.raw(renderGroupHelp(resolution.group, resolution.commands, out.style))
    return finish(
      state,
      streams,
      { group: resolution.group, commands: summarize(resolution.commands, sources) },
      EXIT.OK,
    )
  }
  if (resolution.kind !== 'found') throw unresolved(resolution, plugins)

  const command = resolution.command
  state.command = command.name
  const consumed = new Set(scan.wordIndexes.slice(0, resolution.consumed))
  const rest = options.argv.filter((_, i) => !consumed.has(i))

  if (scan.help) {
    const source = sources.get(command.name)
    out.raw(renderCommandHelp(command, out.style, source))
    return finish(state, streams, describe(command, source), EXIT.OK)
  }

  const parsed = parseCommandLine(command, rest)
  const { globals } = parsed
  if (command.requiresProject !== false && project === undefined) {
    throw usageError('project_not_found', { cwd })
  }
  if (globals.env !== undefined && !isValidEnvName(globals.env)) {
    throw usageError('invalid_argument', {
      detail: `--env "${globals.env}" must be a plain name like "test".`,
    })
  }
  // Resolve APP_ENV once, as the runtime will, and give the command exactly that value.
  const appEnv = resolveAppEnv({
    processEnv: services.env,
    root: project?.root,
    envName: globals.env,
  })
  const confirmed = globals.force && parsed.iUnderstand
  const guard = (): void => guardProduction(command.name, appEnv, confirmed)
  if (command.destructive === true) guard()
  const exported = new Map<string, string>(
    project === undefined || globals.env === undefined
      ? []
      : envFileOverlay(project.root, globals.env, services.env),
  )
  if (appEnv.value !== undefined) exported.set('APP_ENV', appEnv.value)
  if (exported.size > 0) options.applyEnv?.(exported)
  const commandServices: CliServices =
    exported.size === 0
      ? services
      : { ...services, env: { ...services.env, ...Object.fromEntries(exported) } }

  const interactive = services.isTTY && globals.interactive && !globals.yes && !globals.json
  const prompt =
    options.prompter ??
    (interactive ? createInteractivePrompter() : createNonInteractivePrompter({ yes: globals.yes }))
  const log: Logger = createLogger({
    level: globals.verbose ? 'debug' : 'warn',
    sink: (line) => streams.stderr(`${line}\n`),
    bindings: { command: command.name },
  })

  const ctx: CommandContext = {
    command: command.name,
    // The values were parsed from this command's own declarations, so they match its types.
    args: parsed.args as CommandContext['args'],
    flags: parsed.flags as CommandContext['flags'],
    extraFlags: parsed.extraFlags,
    globals,
    cwd,
    project,
    requireProject(): Project {
      if (project === undefined) throw usageError('project_not_found', { cwd })
      return project
    },
    out,
    prompt,
    log,
    services: commandServices,
    version,
    appEnv: appEnv.value,
    guardDestructive: guard,
    packageMigrations: () =>
      project === undefined ? [] : packageMigrations(project, version).dirs,
  }
  const outcome = (await command.run(ctx)) ?? {}
  return finish(state, streams, outcome.data, outcome.exitCode ?? EXIT.OK)
}

/** Metadata for `node strut help <command> --json`. */
function describe(command: AnyCommand, source: string | undefined): unknown {
  return {
    name: command.name,
    description: command.description,
    aliases: command.aliases ?? [],
    args: command.args ?? {},
    flags: command.flags ?? {},
    examples: command.examples ?? [],
    source: source ?? CLI_PACKAGE,
  }
}

/** Turn a failed resolution into the right error. */
function unresolved(
  resolution: ReturnType<typeof resolveCommand>,
  plugins: PluginCommands | undefined,
): CliError {
  if (resolution.kind === 'ambiguous') {
    return usageError('ambiguous_command', {
      name: resolution.input,
      matches: resolution.matches.join(', '),
    })
  }
  const input = resolution.kind === 'unknown' ? resolution.input : ''
  const incompatible = (plugins?.problems ?? []).filter((p) => p.kind === 'incompatible')
  if (incompatible.length > 0) {
    return new CliError('incompatible_plugins', {
      exitCode: EXIT.INCOMPATIBLE,
      params: {
        name: input,
        plugins: incompatible
          .map((p) =>
            p.kind === 'incompatible' && p.missing === true
              ? `${p.name} (declares no strutvane.compat)`
              : `${p.name} (needs ${p.kind === 'incompatible' ? p.range : ''})`,
          )
          .join(', '),
      },
    })
  }
  const suggestions = resolution.kind === 'unknown' ? resolution.suggestions : []
  return new CliError('unknown_command', {
    exitCode: EXIT.USAGE,
    params: { name: input },
    issues: suggestions.map((s) => ({ path: [], code: 'suggestion', message: s })),
  })
}

/**
 * Refuse a destructive command unless the resolved `APP_ENV` is one of `SAFE_APP_ENVS` or both
 * `--force` and `--i-understand` are given (docs/09 §4). Fails closed: an unset `APP_ENV` (which
 * the runtime treats as production) is refused too.
 */
function guardProduction(command: string, appEnv: ResolvedAppEnv, confirmed: boolean): void {
  if (isSafeAppEnv(appEnv.value) || confirmed) return
  const env =
    appEnv.value === undefined
      ? 'not set'
      : `"${printable(appEnv.value, 40)}" (from ${appEnv.source === 'process' ? 'the environment' : appEnv.source})`
  throw usageError('production_guard', { command, env })
}

function finish(state: RunState, streams: OutputStreams, data: unknown, exitCode: number): number {
  if (state.out.json) {
    const envelope: JsonEnvelope = {
      schemaVersion: JSON_SCHEMA_VERSION,
      ok: exitCode === EXIT.OK,
      command: state.command,
      exitCode,
      data: data ?? null,
      warnings: [...state.out.warnings],
    }
    streams.stdout(`${JSON.stringify(envelope, null, 2)}\n`)
  }
  return exitCode
}

const messages = createCliMessages()

/** Render the message and hint of a failure from the catalog. */
export function renderMessages(failure: CliFailure): { message: string; hint?: string } {
  const params: ErrorParams = failure.params
  const key = `cli.error.${failure.code}`
  const message = messages.has(key)
    ? messages.format(key, params)
    : String(params['detail'] ?? failure.code)
  const hintKey = `cli.hint.${failure.code}`
  return messages.has(hintKey) ? { message, hint: messages.format(hintKey, params) } : { message }
}

function issueText(issue: CliIssue): string {
  if (issue.code === 'suggestion') return `Did you mean \`node strut ${issue.message}\`?`
  const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
  return `${where}${issue.message}`
}

function renderFailure(failure: CliFailure, state: RunState, streams: OutputStreams): number {
  const { message, hint } = renderMessages(failure)
  if (state.out.json) {
    const envelope: JsonEnvelope = {
      schemaVersion: JSON_SCHEMA_VERSION,
      ok: false,
      command: state.command,
      exitCode: failure.exitCode,
      data: failure.data ?? null,
      error: {
        code: failure.code,
        message,
        ...(hint === undefined ? {} : { hint }),
        ...(failure.issues.length === 0 ? {} : { issues: failure.issues }),
      },
      warnings: [...state.out.warnings],
    }
    streams.stdout(`${JSON.stringify(envelope, null, 2)}\n`)
    return failure.exitCode
  }
  const { style } = state.out
  const lines = [`${style.red('error')} ${message}`]
  for (const issue of failure.issues) lines.push(`  - ${issueText(issue)}`)
  if (hint !== undefined) lines.push(`${style.dim('hint:')} ${hint}`)
  if (state.verbose && failure.error instanceof Error && failure.error.stack !== undefined) {
    lines.push(style.dim(failure.error.stack))
  }
  streams.stderr(`${lines.join('\n')}\n`)
  return failure.exitCode
}
