/**
 * Optional formatter step that reduces merge noise.
 *
 * Templates are emitted in Strutvane's style; users usually run their own formatter on ejected
 * files, which reflows lines. Reflow makes every reformatted line look changed and turns harmless
 * template updates into conflicts. Formatting `base` and `theirs` with the USER's formatter and
 * config before merging puts all three inputs in the same style.
 *
 * Formatting only reduces noise; correctness never depends on it. So every failure (formatter
 * missing, syntax error, timeout) falls back to the unformatted text, with a note.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

/** A pluggable formatter. Implementations must be deterministic and idempotent. */
export interface Formatter {
  readonly name: string
  /** Format `text` as if it lived at `filePath` (relative to the project root). */
  format(text: string, filePath: string): Promise<string>
}

/** The result of a fail-soft formatting attempt. */
export interface FormatOutcome {
  readonly text: string
  readonly formatted: boolean
  readonly note?: string
}

/** Run a formatter, falling back to the original text on any failure. */
export async function tryFormat(
  formatter: Formatter,
  text: string,
  filePath: string,
): Promise<FormatOutcome> {
  try {
    return { text: await formatter.format(text, filePath), formatted: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return {
      text,
      formatted: false,
      note: `${formatter.name} could not format ${filePath}: ${reason}`,
    }
  }
}

/**
 * Biome via its CLI (`biome format --stdin-file-path`), run in the user's project directory.
 *
 * Why the CLI and not `@biomejs/js-api`: the CLI discovers and applies the user's own `biome.json`
 * (including `extends`, overrides and ignore rules) exactly as their editor and CI do. The JS API
 * needs the configuration passed in by hand, which risks formatting with different settings than
 * the user's, which is precisely the noise this step exists to remove.
 */
export function createBiomeCliFormatter(options: {
  readonly cwd: string
  readonly timeoutMs?: number
  /** Path to Biome's JS entry point. Default: resolved from the project's own `node_modules`. */
  readonly biomeBin?: string
}): Formatter {
  const timeoutMs = options.timeoutMs ?? 15_000
  return {
    name: 'biome',
    format: (text, filePath) =>
      new Promise((resolve, reject) => {
        let bin: string
        try {
          bin = options.biomeBin ?? resolveBiomeBin(options.cwd)
        } catch (error) {
          reject(error)
          return
        }
        const child = spawn(process.execPath, [bin, 'format', `--stdin-file-path=${filePath}`], {
          cwd: options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        // On timeout, kill the process and settle only once it has exited, so no child process
        // outlives the call (on Windows a live child also keeps its working directory locked).
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, timeoutMs)
        child.stdout.on('data', (c: Buffer) => stdout.push(c))
        child.stderr.on('data', (c: Buffer) => stderr.push(c))
        child.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (timedOut) reject(new Error(`timed out after ${timeoutMs} ms`))
          else if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
          else
            reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `exit code ${code}`))
        })
        child.stdin.end(text, 'utf8')
      }),
  }
}

/** Find the Biome CLI entry point installed in the project (never a global install). */
function resolveBiomeBin(cwd: string): string {
  const require = createRequire(`${cwd.replace(/[\\/]$/, '')}/package.json`)
  return require.resolve('@biomejs/biome/bin/biome')
}
