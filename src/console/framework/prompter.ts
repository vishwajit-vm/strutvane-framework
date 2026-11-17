/**
 * Prompting, with one rule everywhere: **never block a non-interactive run.**
 *
 * A prompt is shown only when stdin/stdout are terminals and none of `--yes`, `--no-interactive`
 * or `--json` was passed. Otherwise:
 * - with `--yes`, the default answer is used (confirmations are accepted);
 * - without it, a question that has a default uses it, and one that has none fails with
 *   `input_required` (exit 2) naming what to pass on the command line.
 * A CI job therefore either succeeds deterministically or fails fast; it never hangs.
 *
 * The interactive implementation uses `@clack/prompts`, chosen for its small size (no
 * dependencies beyond its own core), accessible defaults and clean cancel handling.
 *
 * @module
 */
import * as clack from '@clack/prompts'
import { CliError, usageError } from './errors.ts'
import { EXIT } from './exit-codes.ts'

/** One choice of a select prompt. */
export interface SelectOption {
  readonly value: string
  readonly label?: string
  readonly hint?: string
}

/** Asks the user questions (or answers them from defaults when it may not ask). */
export interface Prompter {
  /** Whether questions are actually shown to a person. */
  readonly interactive: boolean
  confirm(message: string, options?: { readonly default?: boolean }): Promise<boolean>
  text(
    message: string,
    options?: {
      readonly default?: string
      readonly placeholder?: string
      /** Return an error message to reject the input, or `undefined` to accept it. */
      readonly validate?: (value: string) => string | undefined
    },
  ): Promise<string>
  select(
    message: string,
    choices: readonly SelectOption[],
    options?: { readonly default?: string },
  ): Promise<string>
}

/** A prompter that never asks: `yes` accepts defaults (and confirmations). */
export function createNonInteractivePrompter(options: { readonly yes: boolean }): Prompter {
  const required = (message: string): CliError => usageError('input_required', { detail: message })
  return {
    interactive: false,
    async confirm(message, opts = {}) {
      if (options.yes) return true
      if (opts.default !== undefined) return opts.default
      throw required(message)
    },
    async text(message, opts = {}) {
      if (opts.default !== undefined) return opts.default
      throw required(message)
    },
    async select(message, _choices, opts = {}) {
      if (opts.default !== undefined) return opts.default
      throw required(message)
    },
  }
}

/** The subset of `@clack/prompts` the CLI uses (injectable for tests). */
export interface ClackApi {
  confirm: typeof clack.confirm
  text: typeof clack.text
  select: typeof clack.select
  isCancel: typeof clack.isCancel
}

/** Turn a cancelled prompt (Ctrl+C / Esc) into the documented interrupt exit code. */
function unwrap<T>(api: ClackApi, value: T): Exclude<T, symbol> {
  if (api.isCancel(value) || typeof value === 'symbol') {
    throw new CliError('interrupted', { exitCode: EXIT.INTERRUPTED })
  }
  return value as Exclude<T, symbol>
}

/** A prompter that asks in the terminal. */
export function createInteractivePrompter(api: ClackApi = clack): Prompter {
  return {
    interactive: true,
    async confirm(message, opts = {}) {
      return unwrap(
        api,
        await api.confirm({
          message,
          ...(opts.default === undefined ? {} : { initialValue: opts.default }),
        }),
      )
    },
    async text(message, opts = {}) {
      const validate = opts.validate
      const value = unwrap(
        api,
        await api.text({
          message,
          ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
          ...(opts.default === undefined ? {} : { defaultValue: opts.default }),
          ...(validate === undefined
            ? {}
            : { validate: (v: string | undefined) => validate(v ?? '') }),
        }),
      )
      return value
    },
    async select(message, choices, opts = {}) {
      const value = unwrap(
        api,
        await api.select({
          message,
          options: choices.map((c) => ({
            value: c.value,
            label: c.label ?? c.value,
            ...(c.hint === undefined ? {} : { hint: c.hint }),
          })),
          ...(opts.default === undefined ? {} : { initialValue: opts.default }),
        }),
      )
      return String(value)
    },
  }
}
