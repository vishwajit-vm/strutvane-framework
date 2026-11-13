/**
 * The `strutvane` launcher (docs/09 §1.1).
 *
 * Installed globally or run through `npx strutvane`, it finds the project-local
 * `@strutvane/cli` and hands every command to it, so generators and runtime always match the
 * versions pinned in the project's package.json. **Local always wins over global.**
 *
 * Search: from the working directory (or `--cwd`) upwards, each directory is checked for
 * `node_modules/@strutvane/cli`. The search stops at the project root (a directory containing
 * `strutvane.config.ts`) or the file-system root.
 *
 * Without a local CLI only project-less commands run: `--version`, `help`, `new <name>` (via
 * `create-strutvane`) and `doctor --global` (via `@strutvane/cli` matching this launcher).
 *
 * The launcher has zero dependencies and does no parsing beyond what delegation needs; it is
 * deliberately tiny so it never has to change when the CLI does.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Environment variable carrying the delegation depth (guards against delegation loops). */
export const DEPTH_ENV = 'STRUTVANE_LAUNCHER_DEPTH'
/** Overrides the project starter command (a JSON array), e.g. for tests or mirrors. */
export const CREATE_ENV = 'STRUTVANE_CREATE_COMMAND'
/** Set to `1` to silence the version-mismatch notice. */
export const NO_NOTICE_ENV = 'STRUTVANE_NO_UPDATE_NOTICE'

/** A project-local CLI the launcher can delegate to. */
export interface LocalCli {
  readonly packageDir: string
  readonly version: string
  /** Absolute path of the CLI's executable script. */
  readonly bin: string
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The executable declared by a CLI manifest, if it resolves inside the package. */
function binOf(packageDir: string, manifest: Record<string, unknown>): string | undefined {
  const bin = manifest['bin']
  const rel =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null
        ? ((bin as Record<string, unknown>)['strutvane-cli'] ?? Object.values(bin)[0])
        : undefined
  if (typeof rel !== 'string') return undefined
  const path = resolve(packageDir, rel)
  if (!existsSync(path)) return undefined
  const realDir = realpathSync(packageDir)
  const inner = relative(realDir, realpathSync(path))
  return inner.startsWith('..') || isAbsolute(inner) ? undefined : path
}

/** Find the nearest project-local `@strutvane/cli`, searching upwards from `start`. */
export function findLocalCli(start: string): LocalCli | undefined {
  let dir = resolve(start)
  for (;;) {
    const packageDir = join(dir, 'node_modules', '@strutvane', 'cli')
    const manifest = readJson(join(packageDir, 'package.json'))
    if (manifest !== undefined) {
      const bin = binOf(packageDir, manifest)
      if (bin !== undefined) {
        const version = typeof manifest['version'] === 'string' ? manifest['version'] : '0.0.0'
        return { packageDir, version, bin }
      }
    }
    if (existsSync(join(dir, 'strutvane.config.ts'))) return undefined // project root: stop
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The `--cwd` value from argv, if any (`--cwd x` or `--cwd=x`). */
export function cwdFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (token === '--') return undefined
    if (token === '--cwd') return argv[i + 1]
    if (token.startsWith('--cwd=')) return token.slice('--cwd='.length)
  }
  return undefined
}

/** Runs a child process with inherited stdio and resolves with its exit code. */
export type LaunchSpawner = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly shell: boolean },
) => Promise<number>

const SIGNAL_CODES: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

/** The real spawner: inherits stdio and ignores Ctrl+C itself so the child decides. */
export const nodeLaunchSpawner: LaunchSpawner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const ignore = (): void => {}
    process.on('SIGINT', ignore)
    const child = spawn(command, [...args], {
      stdio: 'inherit',
      env: options.env,
      shell: options.shell,
    })
    child.on('error', (error) => {
      process.off('SIGINT', ignore)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      process.off('SIGINT', ignore)
      resolvePromise(code ?? (signal === null ? 1 : (SIGNAL_CODES[signal] ?? 1)))
    })
  })

/** Process facts the launcher needs (injectable for tests). */
export interface LauncherEnvironment {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly execPath: string
  readonly platform: NodeJS.Platform
  readonly version: string
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly spawn: LaunchSpawner
}

/** Characters allowed in arguments that pass through a Windows shell (npx is a .cmd shim). */
const SHELL_SAFE = /^[A-Za-z0-9@._/:=+,-]+$/

function help(version: string): string {
  return [
    `strutvane ${version}: the Strutvane command line launcher`,
    '',
    'No project-local @strutvane/cli was found, so only these commands are available:',
    '  strutvane new <name> [flags]   Create a project (runs create-strutvane)',
    '  strutvane doctor --global      Check this machine (Node.js version, package managers)',
    '  strutvane --version            Print the launcher version',
    '  strutvane help                 Show this help',
    '',
    'Inside a project, every command (sv make:model, sv add, sv upgrade…) is handled by the',
    "project's own @strutvane/cli, so it always matches the versions in package.json.",
    '',
  ].join('\n')
}

/** Run a project-less command through npx (or the override in `STRUTVANE_CREATE_COMMAND`). */
async function viaNpx(
  env: LauncherEnvironment,
  pkg: string,
  args: readonly string[],
): Promise<number> {
  const override = env.env[CREATE_ENV]
  if (override !== undefined && pkg.startsWith('create-strutvane')) {
    const parsed: unknown = JSON.parse(override)
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((p) => typeof p === 'string')
    ) {
      env.stderr(`strutvane: ${CREATE_ENV} must be a JSON array of strings.\n`)
      return 2
    }
    const [command = '', ...rest] = parsed as string[]
    return env.spawn(command, [...rest, ...args], { env: env.env, shell: false })
  }
  const windows = env.platform === 'win32'
  const npxArgs = ['--yes', pkg, ...args]
  if (windows) {
    const unsafe = npxArgs.find((a) => !SHELL_SAFE.test(a))
    if (unsafe !== undefined) {
      env.stderr(`strutvane: refusing to pass "${unsafe}" to a shell. Use plain names and flags.\n`)
      return 2
    }
  }
  return env.spawn(windows ? 'npx.cmd' : 'npx', npxArgs, { env: env.env, shell: windows })
}

/** Run the launcher. Returns the exit code (the delegated CLI's, when delegating). */
export async function runLauncher(
  argv: readonly string[],
  env: LauncherEnvironment,
): Promise<number> {
  const depth = Number(env.env[DEPTH_ENV] ?? '0')
  const flag = cwdFlag(argv)
  const start = flag === undefined ? env.cwd : resolve(env.cwd, flag)
  const local = depth >= 1 ? undefined : findLocalCli(start)

  if (local !== undefined) {
    const quiet = argv.includes('--json') || argv.includes('--quiet') || argv.includes('-q')
    if (local.version !== env.version && !quiet && env.env[NO_NOTICE_ENV] !== '1') {
      env.stderr(
        `strutvane: using the project's @strutvane/cli ${local.version} (launcher ${env.version}).\n`,
      )
    }
    return env.spawn(env.execPath, [local.bin, ...argv], {
      env: { ...env.env, [DEPTH_ENV]: String(depth + 1) },
      shell: false,
    })
  }

  const [first, ...rest] = argv
  if (first === '--version' || first === '-V') {
    env.stdout(`strutvane ${env.version}\n`)
    return 0
  }
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    env.stdout(help(env.version))
    return 0
  }
  if (first === 'new' || first === 'create') {
    return viaNpx(env, 'create-strutvane@latest', rest)
  }
  if (first === 'doctor' && rest.includes('--global')) {
    return viaNpx(env, `@strutvane/cli@${env.version}`, argv)
  }
  env.stderr(
    [
      `strutvane: "${first}" needs a Strutvane project, but no project-local @strutvane/cli was found`,
      `  (searched from ${start} upwards).`,
      '  Run it inside a project, or add the CLI to this one: pnpm add -D @strutvane/cli',
      '  Create a new project with: strutvane new <name>',
      '',
    ].join('\n'),
  )
  return 2
}
