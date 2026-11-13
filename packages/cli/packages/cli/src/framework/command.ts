/**
 * The command API: how built-in commands and package/plugin commands are declared.
 *
 * A command is a plain object (name, description, args, flags, `run`). The runner owns parsing,
 * validation, prompting rules, output mode and error rendering, so a command only implements its
 * behaviour and returns data. The same shape is used by contributed commands (docs/09 §11), which
 * means a plugin command gets `--json`, `--dry-run`, exit codes and help for free.
 *
 * Flag and argument types are inferred from the declaration, so `ctx.flags['soft-deletes']` is a
 * `boolean` and a misspelled flag fails to compile.
 *
 * @module
 */
import type { Logger } from '@strutvane/contracts'
import type { ExitCode } from './exit-codes.ts'
import type { Output } from './output.ts'
import type { Prompter } from './prompter.ts'
import type { CliServices } from './services.ts'

/** A positional argument. Arguments are matched in declaration order. */
export interface ArgDefinition {
  readonly description?: string
  /** A missing required argument is a usage error (exit 2). */
  readonly required?: boolean
  /** Collects every remaining positional (only valid on the last argument). */
  readonly variadic?: boolean
}

/** A flag (`--name`). Boolean flags also accept `--no-<name>`. */
export interface FlagDefinition {
  readonly type: 'boolean' | 'string'
  /** Single-letter alias, e.g. `m` for `-m`. */
  readonly short?: string
  readonly description?: string
  readonly default?: boolean | string
  /** String flags only: allowed values (anything else is a usage error). */
  readonly choices?: readonly string[]
  /** String flags only: the flag may be repeated; the value is a list. */
  readonly multiple?: boolean
  /** Placeholder shown in help, e.g. `<n>`. */
  readonly valueName?: string
}

/** Flag declarations keyed by flag name (kebab-case, as typed on the command line). */
export type FlagMap = Readonly<Record<string, FlagDefinition>>
/** Argument declarations keyed by argument name, in positional order. */
export type ArgMap = Readonly<Record<string, ArgDefinition>>

/** The parsed value type of one flag declaration. */
export type FlagValue<F extends FlagDefinition> = F['type'] extends 'boolean'
  ? F extends { readonly default: boolean }
    ? boolean
    : boolean | undefined
  : F extends { readonly multiple: true }
    ? string[]
    : F extends { readonly default: string }
      ? string
      : string | undefined

/** Parsed flag values, typed from the declarations. */
export type FlagValues<F extends FlagMap> = { readonly [K in keyof F]: FlagValue<F[K]> }

/** The parsed value type of one argument declaration. */
export type ArgValue<A extends ArgDefinition> = A extends { readonly variadic: true }
  ? string[]
  : A extends { readonly required: true }
    ? string
    : string | undefined

/** Parsed argument values, typed from the declarations. */
export type ArgValues<A extends ArgMap> = { readonly [K in keyof A]: ArgValue<A[K]> }

/** Universal flags (docs/09 §1.3), available to every command. */
export interface GlobalOptions {
  readonly json: boolean
  readonly dryRun: boolean
  readonly diff: boolean
  readonly yes: boolean
  /** `false` with `--no-interactive` (and whenever prompting is impossible). */
  readonly interactive: boolean
  readonly force: boolean
  readonly verbose: boolean
  readonly quiet: boolean
  readonly color: boolean
  /** `--env <name>`: load `.env.<name>` over `.env`. */
  readonly env: string | undefined
  /** The `--cwd` value as given (resolved into {@link CommandContext.cwd}). */
  readonly cwd: string | undefined
}

/** The project a command runs in. */
export interface Project {
  /** Absolute path of the project root. */
  readonly root: string
  /** Parsed `package.json` of the project. */
  readonly packageJson: Readonly<Record<string, unknown>>
}

/** Everything a command receives. */
export interface CommandContext<F extends FlagMap = FlagMap, A extends ArgMap = ArgMap> {
  /** The canonical command name, e.g. `make:model`. */
  readonly command: string
  readonly args: ArgValues<A>
  readonly flags: FlagValues<F>
  /** Flags the command did not declare (only when `allowUnknownFlags` is set), e.g. installer answers. */
  readonly extraFlags: Readonly<Record<string, string | boolean>>
  readonly globals: GlobalOptions
  /** Absolute working directory (after `--cwd`). */
  readonly cwd: string
  /** The project, when one was found. */
  readonly project: Project | undefined
  /** The project, or a `PROJECT_NOT_FOUND` usage error. */
  requireProject(): Project
  readonly out: Output
  readonly prompt: Prompter
  /** Diagnostic logging (stderr, JSON lines). Enabled at `debug` with `--verbose`. */
  readonly log: Logger
  readonly services: CliServices
  /** The `@strutvane/cli` version. */
  readonly version: string
}

/** What a command returns. */
export interface CommandOutcome {
  /** The command's result: the `data` of the `--json` envelope. */
  readonly data?: unknown
  /** Exit code when the command completed but needs attention (e.g. 3 for failed checks). */
  readonly exitCode?: ExitCode
}

/** A command declaration. */
export interface CommandDefinition<F extends FlagMap = FlagMap, A extends ArgMap = ArgMap> {
  /** Canonical colon-separated name, e.g. `make:model`. Lowercase, kebab-case segments. */
  readonly name: string
  /** One line, shown in `sv help`. */
  readonly description: string
  /** Longer help text (paragraphs), shown in `sv help <command>`. */
  readonly details?: string
  readonly aliases?: readonly string[]
  readonly args?: A
  readonly flags?: F
  readonly examples?: readonly string[]
  /** Default `true`. Commands that work anywhere (`about`, `help`) set `false`. */
  readonly requiresProject?: boolean
  /** Accept undeclared flags into {@link CommandContext.extraFlags} (e.g. installer answers). */
  readonly allowUnknownFlags?: boolean
  /**
   * Built-in stand-in for a command another package provides (e.g. `migrate` from
   * `@strutvane/framework`). A contributed command with the same name replaces it silently.
   */
  readonly placeholder?: boolean
  /** Destructive: refused when `APP_ENV=production` unless `--force --i-understand` is passed. */
  readonly destructive?: boolean
  /** Hidden from `sv help` listings (still runnable, still in `sv help <name>`). */
  readonly hidden?: boolean
  run(ctx: CommandContext<F, A>): CommandOutcome | undefined | Promise<CommandOutcome | undefined>
}

/** A command of any flag/arg shape, as stored in the registry. */
// biome-ignore lint/suspicious/noExplicitAny: the registry stores commands of every shape; `run` is called with a context built from the same declaration
export type AnyCommand = CommandDefinition<any, any>

/**
 * Declare a command with full type inference for its flags and arguments.
 *
 * @example
 * ```ts
 * export default defineCommand({
 *   name: 'reports:send',
 *   description: 'Send monthly reports',
 *   args: { month: { required: true } },
 *   flags: { 'dry-run-email': { type: 'boolean', default: false } },
 *   async run({ args, flags, out }) {
 *     out.success(`Sent reports for ${args.month}`)
 *     return { data: { month: args.month } }
 *   },
 * })
 * ```
 */
export function defineCommand<
  const F extends FlagMap = Record<never, never>,
  const A extends ArgMap = Record<never, never>,
>(definition: CommandDefinition<F, A>): CommandDefinition<F, A> {
  return definition
}

/** Valid command names: lowercase kebab-case segments joined by colons. */
export const COMMAND_NAME: RegExp = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/

/** Valid flag names: lowercase kebab-case. */
const FLAG_NAME = /^[a-z][a-z0-9-]*$/

/**
 * Check that an unknown value is a usable command declaration. Returns a list of problems (empty
 * when valid). Used for contributed commands, which come from code the CLI does not control.
 */
export function commandProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['a command must be an object']
  const problems: string[] = []
  const c = value as Record<string, unknown>
  if (typeof c['name'] !== 'string' || !COMMAND_NAME.test(c['name'])) {
    problems.push(`name ${JSON.stringify(c['name'])} must be colon-separated kebab-case`)
  }
  if (typeof c['description'] !== 'string' || c['description'].trim() === '') {
    problems.push('description must be a non-empty string')
  }
  if (typeof c['run'] !== 'function') problems.push('run must be a function')
  const flags = c['flags']
  if (flags !== undefined) {
    if (typeof flags !== 'object' || flags === null) problems.push('flags must be an object')
    else {
      for (const [name, def] of Object.entries(flags)) {
        if (!FLAG_NAME.test(name)) problems.push(`flag "${name}" must be kebab-case`)
        const type = typeof def === 'object' && def !== null ? (def as { type?: unknown }).type : ''
        if (type !== 'boolean' && type !== 'string') {
          problems.push(`flag "${name}" needs type "boolean" or "string"`)
        }
      }
    }
  }
  const args = c['args']
  if (args !== undefined) {
    if (typeof args !== 'object' || args === null) problems.push('args must be an object')
    else {
      const entries = Object.entries(args)
      entries.forEach(([name, def], i) => {
        const variadic =
          typeof def === 'object' && def !== null && 'variadic' in def && def.variadic
        if (variadic === true && i !== entries.length - 1) {
          problems.push(`argument "${name}" is variadic but not last`)
        }
      })
    }
  }
  return problems
}
