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
import type { Clock } from '@strutvane/core'
import { systemClock } from '@strutvane/core'
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
  return platform === 'win32' && command !== execPath && !/\.exe$/i.test(command)
}

/** Create the real spawner. Arguments are never interpolated into a shell string unchecked. */
export function createNodeSpawner(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): Spawner {
  return (command, args, options) => {
    const shell = needsShell(command, platform, execPath)
    if (shell) {
      for (const value of [command, ...args]) {
        if (!SHELL_SAFE.test(value)) {
          return Promise.reject(
            new CliError('UNSAFE_ARGUMENT', { exitCode: EXIT.USAGE, params: { value } }),
          )
        }
      }
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
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
