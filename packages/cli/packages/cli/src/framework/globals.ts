/**
 * Universal flags (docs/09 §1.3) and the early scan of the command line.
 *
 * The command name has to be found before its flags are known, but global flags may appear
 * anywhere (`sv --json routes`, `sv routes --json`). {@link scanCommandLine} therefore splits the
 * line into the leading command words and everything else, skipping over the values of global
 * string flags (`--cwd ./app`) so they are never mistaken for a command.
 *
 * @module
 */
import type { FlagDefinition } from './command.ts'

/** Flags every command accepts. Names must not be redeclared by commands. */
export const GLOBAL_FLAGS: Readonly<
  Record<string, FlagDefinition & { readonly description: string }>
> = {
  json: { type: 'boolean', description: 'Machine-readable output (one JSON document)' },
  'dry-run': { type: 'boolean', description: 'Show what would happen; write nothing' },
  diff: { type: 'boolean', description: 'Show a unified diff of file changes' },
  yes: { type: 'boolean', short: 'y', description: 'Accept all defaults; never prompt' },
  interactive: {
    type: 'boolean',
    description: 'Prompt for missing input (--no-interactive fails instead)',
  },
  force: { type: 'boolean', description: 'Overwrite generated files that are not owned' },
  cwd: { type: 'string', valueName: '<path>', description: 'Run as if in another directory' },
  env: { type: 'string', valueName: '<name>', description: 'Load .env.<name> over .env' },
  verbose: { type: 'boolean', short: 'v', description: 'Debug logging and stack traces' },
  quiet: { type: 'boolean', short: 'q', description: 'Only print results and errors' },
  color: { type: 'boolean', description: 'Colored output (--no-color for plain text)' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
}

/** Names of global flags that take a value. */
const GLOBAL_STRING_FLAGS = new Set(
  Object.entries(GLOBAL_FLAGS)
    .filter(([, def]) => def.type === 'string')
    .map(([name]) => name),
)

/** The command line, split for command lookup. */
export interface ScannedLine {
  /** Leading positional words (candidates for the command name), up to the first flag. */
  readonly words: readonly string[]
  /** Index in argv of each word, so the consumed ones can be removed. */
  readonly wordIndexes: readonly number[]
  readonly help: boolean
  readonly version: boolean
  readonly json: boolean
  readonly verbose: boolean
  readonly quiet: boolean
  /** `--color` / `--no-color` if passed. */
  readonly color: boolean | undefined
  readonly cwd: string | undefined
}

/**
 * Scan argv for the command words and the flags needed before full parsing (help, version, output
 * mode, `--cwd`). Words are collected until the first flag that is not a global string flag's
 * value, matching the documented "positionals first, then flags" order.
 */
export function scanCommandLine(argv: readonly string[]): ScannedLine {
  const words: string[] = []
  const wordIndexes: number[] = []
  let help = false
  let version = false
  let json = false
  let verbose = false
  let quiet = false
  let color: boolean | undefined
  let cwd: string | undefined
  let collecting = true

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (token === '--') break
    if (!token.startsWith('-') || token === '-') {
      if (collecting) {
        words.push(token)
        wordIndexes.push(i)
      }
      continue
    }
    const [flag = '', inline] = token.split(/=(.*)/s, 2)
    const name = flag.replace(/^--?/, '')
    if (flag === '--help' || flag === '-h') help = true
    else if (flag === '--version' || flag === '-V') version = true
    else if (flag === '--json') json = true
    else if (flag === '--verbose' || flag === '-v') verbose = true
    else if (flag === '--quiet' || flag === '-q') quiet = true
    else if (flag === '--color') color = true
    else if (flag === '--no-color') color = false
    if (flag.startsWith('--') && GLOBAL_STRING_FLAGS.has(name)) {
      const value = inline ?? argv[i + 1]
      if (name === 'cwd') cwd = value
      if (inline === undefined) i++ // skip the value: it is not a command word
      continue
    }
    // Any other flag ends the command words (positionals come first, then flags).
    if (words.length > 0) collecting = false
  }
  return { words, wordIndexes, help, version, json, verbose, quiet, color, cwd }
}
