/**
 * Side-effecting services commands use: processes, time, environment, terminal facts.
 *
 * They are injected (never imported directly by commands) so tests can run every command against
 * a fake package manager, a fixed clock and a scripted terminal, and so the real implementations
 * live in one audited place. Spawning in particular is security-sensitive: see
 * {@link createNodeSpawner}.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { Clock } from '../../core/index.ts'
import { systemClock } from '../../core/index.ts'
import { CliError } from './errors.ts'
import { EXIT } from './exit-codes.ts'

/** Options for one child process. */
export interface SpawnOptions {
  readonly cwd: string
  /** `inherit` streams output live to the terminal; `pipe` captures it. Default `pipe`. */
  readonly stdio?: 'inherit' | 'pipe'
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** The result of a finished child process. */
export interface SpawnResult {
  /** Exit code; signals are reported as 128 + signal number (e.g. 130 for SIGINT). */
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a program with arguments (never a shell string). */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<SpawnResult>

/** Services available to commands. */
export interface CliServices {
  readonly spawn: Spawner
  readonly clock: Clock
  /** Environment variables (a snapshot; commands never mutate `process.env`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether stdin and stdout are both terminals (prompting is possible). */
  readonly isTTY: boolean
  /** `process.platform`, injectable to test Windows behaviour anywhere. */
  readonly platform: NodeJS.Platform
  /** The Node.js executable, used to run project-local tools (`tsc`) without a shell. */
  readonly execPath: string
  /** Aborted on Ctrl+C. Long-running commands (`registry:watch`) stop when it fires. */
  readonly signal: AbortSignal
}

/**
 * Characters allowed in an argument that must pass through a Windows shell. Package names,
 * versions, dist-tags and simple flags fit; anything with shell meaning (`&|<>^%"` spaces…) is
 * refused rather than escaped, because cmd.exe escaping rules are notoriously error-prone.
 */
const SHELL_SAFE = /^[A-Za-z0-9@._/:=+-]+$/

const SIGNALS: Readonly<Record<string, number>> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }

/** Exit code for a child that ended by signal (shell convention: 128 + signal number). */
export function exitCodeForSignal(signal: string | null): number {
  return signal === null ? EXIT.FAILURE : 128 + (SIGNALS[signal] ?? 1)
}

/**
 * Whether running `command` needs a shell on this platform. On Windows, package managers are
 * `.cmd` shims, and Node refuses to spawn those without a shell (CVE-2024-27980). Executables
 * (`node.exe`) are always spawned directly.
 */
export function needsShell(command: string, platform: NodeJS.Platform, execPath: string): boolean {
  return platform === 'win32' && command !== execPath && !/\.(exe|com)$/i.test(command)
}

/**
 * Windows only: the absolute path of a program named on the command line (`pnpm`, `npm.cmd`…),
 * from PATH and PATHEXT. The working directory, relative PATH entries and empty entries are
 * skipped: Windows would otherwise look in the working directory (the project) first, so a
 * `pnpm.cmd` committed to a repository would run instead of the real one. Returns `undefined`
 * when the program is not on PATH. Commands that already are paths are returned unchanged.
 */
export function resolveWindowsCommand(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (win32.isAbsolute(command)) return command
  if (/[\\/]/.test(command)) return undefined // relative paths are never resolved
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.startsWith('.'))
  const named = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()))
  const here = win32.resolve(cwd).toLowerCase()
  for (const entry of pathValue.split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '' || !win32.isAbsolute(dir) || win32.resolve(dir).toLowerCase() === here) continue
    for (const ext of named ? [''] : exts) {
      const candidate = win32.join(dir, `${command}${ext.toLowerCase()}`)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * The environment of a child process. On Windows `NoDefaultCurrentDirectoryInExePath=1` makes
 * cmd.exe (and the `.cmd` shims it runs, which call `node`) skip the working directory when it
 * looks up programs.
 */
export function childEnvironment(
  platform: NodeJS.Platform,
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    ...base,
    ...extra,
    ...(platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}),
  }
}

/** Characters allowed in an absolute program path that is quoted for cmd.exe. */
const SHELL_SAFE_PATH = /^[^"%!^&|<>\r\n]+$/

/** Create the real spawner. Arguments are never interpolated into a shell string unchecked. */
export function createNodeSpawner(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): Spawner {
  return (command, args, options) => {
    const env = childEnvironment(platform, baseEnv, options.env)
    let program = command
    if (platform === 'win32' && command !== execPath) {
      const resolved = resolveWindowsCommand(command, env, options.cwd)
      if (resolved === undefined) {
        return Promise.reject(
          new CliError('COMMAND_NOT_FOUND', { exitCode: EXIT.FAILURE, params: { command } }),
        )
      }
      program = resolved
    }
    const shell = needsShell(program, platform, execPath)
    if (shell) {
      if (!SHELL_SAFE_PATH.test(program)) {
        return Promise.reject(
          new CliError('UNSAFE_ARGUMENT', { exitCode: EXIT.USAGE, params: { value: program } }),
        )
      }
      for (const value of args) {
        if (!SHELL_SAFE.test(value)) {
          return Promise.reject(
            new CliError('UNSAFE_ARGUMENT', { exitCode: EXIT.USAGE, params: { value } }),
          )
        }
      }
    }
    return new Promise((resolve, reject) => {
      // A quoted absolute path: cmd.exe runs exactly that file, whatever the working directory.
      const child = spawn(shell ? `"${program}"` : program, [...args], {
        cwd: options.cwd,
        stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        env,
        shell,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        resolve({ code: code ?? exitCodeForSignal(signal), stdout, stderr })
      })
    })
  }
}

/** The real services for a CLI process. */
export function createNodeServices(signal: AbortSignal): CliServices {
  return {
    spawn: createNodeSpawner(),
    clock: systemClock,
    env: { ...process.env },
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    platform: process.platform,
    execPath: process.execPath,
    signal,
  }
}
