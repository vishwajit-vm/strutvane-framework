/**
 * The process entry point's logic, separate from `bin.ts` so it can be tested: wires Ctrl+C to an
 * AbortSignal (exit 130), runs the CLI with the built-in commands, and returns the exit code.
 *
 * @module
 */
import { BUILTIN_COMMANDS } from './commands/builtins.ts'
import { EXIT } from './framework/exit-codes.ts'
import { type RunOptions, runCli } from './framework/run.ts'
import { createNodeServices } from './framework/services.ts'

/** Write resolved variables into this process's environment (see `RunOptions.applyEnv`). */
function applyToProcessEnv(vars: ReadonlyMap<string, string>): void {
  for (const [key, value] of vars) process.env[key] = value
}

/** Run the CLI for this process. Options other than `argv` are for tests. */
export async function main(
  argv: readonly string[],
  options: Omit<RunOptions, 'argv' | 'builtins'> & { readonly signalTarget?: NodeJS.Process } = {},
): Promise<number> {
  const target = options.signalTarget ?? process
  const controller = new AbortController()
  let interrupted = false
  const onSigint = (): void => {
    // First Ctrl+C: let long-running commands (registry:watch) stop cleanly. Second: give up.
    if (interrupted) process.exit(EXIT.INTERRUPTED)
    interrupted = true
    controller.abort()
  }
  target.on('SIGINT', onSigint)
  try {
    const code = await runCli({
      ...options,
      argv,
      builtins: BUILTIN_COMMANDS,
      applyEnv: options.applyEnv ?? applyToProcessEnv,
      services: { ...createNodeServices(controller.signal), ...options.services },
    })
    // Ctrl+C always reports 130 (shell convention), even when the command stopped cleanly.
    return interrupted ? EXIT.INTERRUPTED : code
  } finally {
    target.off('SIGINT', onSigint)
  }
}
