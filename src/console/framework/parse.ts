/**
 * Flag and argument parsing for one resolved command, built on `node:util.parseArgs`.
 *
 * Why `parseArgs` instead of commander/yargs/citty: the router already owns command lookup
 * (colon names, space alias, prefixes), so all that is left is flag parsing, which Node does
 * natively and strictly, including `--no-<flag>` negation (`allowNegative`). That keeps the CLI's
 * startup fast and its dependency tree small, which matters for a tool run through `npx`.
 *
 * Errors are usage errors (exit 2) with the parser's precise message.
 *
 * @module
 */
import { parseArgs } from 'node:util'
import type { AnyCommand, FlagDefinition, FlagMap, GlobalOptions } from './command.ts'
import { CliError, usageError } from './errors.ts'
import { EXIT } from './exit-codes.ts'
import { GLOBAL_FLAGS } from './globals.ts'

/** The parsed command line of one command. */
export interface ParsedCommandLine {
  readonly args: Record<string, string | string[] | undefined>
  readonly flags: Record<string, string | boolean | string[] | undefined>
  readonly extraFlags: Record<string, string | boolean>
  readonly globals: GlobalOptions
  readonly help: boolean
  /** `--i-understand`, the second key for destructive commands in production. */
  readonly iUnderstand: boolean
}

type ParseArgsOption = {
  type: 'boolean' | 'string'
  short?: string
  multiple?: boolean
  default?: string | boolean | string[]
}

function toParseArgsOption(def: FlagDefinition): ParseArgsOption {
  const option: ParseArgsOption = { type: def.type }
  if (def.short !== undefined) option.short = def.short
  if (def.multiple === true && def.type === 'string') option.multiple = true
  return option
}

/** Usage line for help and errors: `sv make:model <name> [fields...] [flags]`. */
export function usageLine(command: AnyCommand): string {
  const args = Object.entries(
    (command.args ?? {}) as Record<string, { required?: boolean; variadic?: boolean }>,
  )
    .map(([name, def]) => {
      const inner = def.variadic === true ? `${name}...` : name
      return def.required === true ? `<${inner}>` : `[${inner}]`
    })
    .join(' ')
  return [
    'node strut',
    command.name,
    args,
    Object.keys(command.flags ?? {}).length > 0 ? '[flags]' : '',
  ]
    .filter((part) => part !== '')
    .join(' ')
}

/** Map a `parseArgs` error to a usage error. */
function parseError(error: unknown, command: string): CliError {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : ''
  const detail = error instanceof Error ? error.message : String(error)
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return usageError('unknown_flag', { detail: firstSentence(detail), command })
  }
  return usageError('invalid_flag_value', { detail: firstSentence(detail), command })
}

/** parseArgs messages can include advice for `--` positionals; keep the first sentence. */
function firstSentence(message: string): string {
  const end = message.indexOf('. ')
  return end < 0 ? message : message.slice(0, end + 1)
}

/**
 * Parse `argv` (with the command words already removed) against a command's declarations plus the
 * global flags.
 */
export function parseCommandLine(command: AnyCommand, argv: readonly string[]): ParsedCommandLine {
  const declared: FlagMap = command.flags ?? {}
  const options: Record<string, ParseArgsOption> = {}
  for (const [name, def] of Object.entries(GLOBAL_FLAGS)) options[name] = toParseArgsOption(def)
  options['i-understand'] = { type: 'boolean' }
  for (const [name, def] of Object.entries(declared)) options[name] = toParseArgsOption(def)

  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        options,
        strict: command.allowUnknownFlags !== true,
        allowPositionals: true,
        allowNegative: true,
        tokens: true,
      })
    } catch (error) {
      throw parseError(error, command.name)
    }
  })()

  const values = parsed.values as Record<
    string,
    string | boolean | (string | boolean)[] | undefined
  >
  const known = new Set(Object.keys(options))
  const extraFlags: Record<string, string | boolean> = {}
  let positionals = [...parsed.positionals]

  if (command.allowUnknownFlags === true) {
    // In non-strict mode parseArgs treats `--methods email` as a boolean plus a positional. Undeclared
    // flags followed by a plain word take that word as their value (positionals come first, so a
    // word after a flag can only be its value).
    const consumed = new Set<number>()
    const tokens = parsed.tokens
    tokens.forEach((token, i) => {
      if (token.kind !== 'option' || known.has(token.name)) return
      const raw = token.rawName.replace(/^--?/, '')
      if (token.value !== undefined) {
        extraFlags[camelCase(raw)] = token.value
        return
      }
      const next = tokens[i + 1]
      if (next?.kind === 'positional') {
        extraFlags[camelCase(raw)] = next.value
        consumed.add(next.index)
      } else if (raw.startsWith('no-')) {
        extraFlags[camelCase(raw.slice(3))] = false
      } else {
        extraFlags[camelCase(raw)] = true
      }
    })
    const positionalTokens = tokens.filter((t) => t.kind === 'positional')
    positionals = positionalTokens.filter((t) => !consumed.has(t.index)).map((t) => t.value)
  }

  const flags: Record<string, string | boolean | string[] | undefined> = {}
  for (const [name, def] of Object.entries(declared)) {
    const raw = values[name]
    let value: string | boolean | string[] | undefined
    if (Array.isArray(raw)) value = raw.map(String)
    else value = raw
    if (value === undefined && def.default !== undefined) value = def.default
    if (value === undefined && def.multiple === true) value = []
    if (def.choices !== undefined && typeof value === 'string' && !def.choices.includes(value)) {
      throw new CliError('invalid_choice', {
        exitCode: EXIT.USAGE,
        params: { flag: name, choices: def.choices.join(', '), value },
      })
    }
    flags[name] = value
  }

  const args = assignPositionals(command, positionals)
  const bool = (name: string): boolean | undefined => {
    const v = values[name]
    return typeof v === 'boolean' ? v : undefined
  }
  const str = (name: string): string | undefined => {
    const v = values[name]
    return typeof v === 'string' ? v : undefined
  }
  const json = bool('json') ?? false
  const globals: GlobalOptions = {
    json,
    dryRun: bool('dry-run') ?? false,
    diff: bool('diff') ?? false,
    yes: bool('yes') ?? false,
    interactive: bool('interactive') ?? true,
    force: bool('force') ?? false,
    verbose: bool('verbose') ?? false,
    quiet: bool('quiet') ?? false,
    color: bool('color') ?? true,
    env: str('env'),
    cwd: str('cwd'),
  }
  return {
    args,
    flags,
    extraFlags,
    globals,
    help: bool('help') ?? false,
    iUnderstand: bool('i-understand') ?? false,
  }
}

/** `keep-data` → `keepData`: installer answers use the JavaScript spelling of flag names. */
export function camelCase(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** Assign positionals to declared arguments, checking required and surplus ones. */
function assignPositionals(
  command: AnyCommand,
  positionals: readonly string[],
): Record<string, string | string[] | undefined> {
  const declared = Object.entries(
    (command.args ?? {}) as Record<string, { required?: boolean; variadic?: boolean }>,
  )
  const args: Record<string, string | string[] | undefined> = {}
  let i = 0
  for (const [name, def] of declared) {
    if (def.variadic === true) {
      args[name] = positionals.slice(i)
      i = positionals.length
      if (def.required === true && (args[name] as string[]).length === 0) {
        throw usageError('missing_argument', { arg: name, usage: usageLine(command) })
      }
      continue
    }
    const value = positionals[i]
    if (value === undefined && def.required === true) {
      throw usageError('missing_argument', { arg: name, usage: usageLine(command) })
    }
    args[name] = value
    if (value !== undefined) i++
  }
  if (i < positionals.length) {
    throw usageError('too_many_arguments', {
      value: positionals[i] ?? '',
      usage: usageLine(command),
    })
  }
  return args
}
