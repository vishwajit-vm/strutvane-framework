/**
 * The `strutvane` launcher (docs/09 §1.1).
 *
 * Installed globally or run through `npx strutvane`, it finds the project-local
 * `@strutvane/cli` and hands project commands to it, so generators and runtime always match the
 * versions pinned in the project's package.json. **Local wins over global for project commands.**
 *
 * **Which folder counts as a project.** Running a `node_modules` folder means running its code, so
 * the search is deliberately narrow. From the working directory (or `--cwd`) upwards, a folder is
 * used only when:
 * - it is a project: its package.json declares `@strutvane/cli` (dependencies or devDependencies)
 *   or it contains `strutvane.config.ts`;
 * - it is not a file-system or drive root, not the OS temp directory itself and not a folder above
 *   the user's home directory (the search stops at any of these);
 * - on POSIX, it is owned by the current user.
 * A folder with `strutvane.config.ts` also ends the search. See {@link findLocalCli}.
 *
 * **Never delegated:** `--version`, `help` (and no command at all), `new` and `create`. These are
 * the commands people run outside projects, so the launcher always answers them itself.
 *
 * Without a local CLI only project-less commands run: `--version`, `help`, `new <name>` (via
 * `create-strutvane`) and `doctor --global` (via `@strutvane/cli` matching this launcher).
 *
 * The launcher has zero dependencies and does no parsing beyond what delegation needs; it is
 * deliberately tiny so it never has to change when the CLI does. The project boundary rules are
 * mirrored in `@strutvane/cli`'s `project/boundary.ts` (the launcher cannot import it); keep the
 * two in step.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'

/** Environment variable carrying the delegation depth (guards against delegation loops). */
export const DEPTH_ENV = 'STRUTVANE_LAUNCHER_DEPTH'
/** Overrides the project starter command (a JSON array), e.g. for tests or mirrors. */
export const CREATE_ENV = 'STRUTVANE_CREATE_COMMAND'
/** Set to `1` to silence the version-mismatch notice. */
export const NO_NOTICE_ENV = 'STRUTVANE_NO_UPDATE_NOTICE'

/** The file that marks a Strutvane project root. */
export const PROJECT_MARKER = 'strutvane.config.ts'

/** A project-local CLI the launcher can delegate to. */
export interface LocalCli {
  readonly packageDir: string
  /** The manifest's version, with control characters removed (safe to print). */
  readonly version: string
  /** Absolute path of the CLI's executable script. */
  readonly bin: string
}

/**
 * Facts the project boundary rules depend on. Injectable so tests can place "home" and "temp"
 * anywhere, and exercise the POSIX ownership rule on any OS.
 */
export interface BoundaryFacts {
  /** The user's home directory. */
  readonly home: string
  /** The OS temp directory. */
  readonly temp: string
  /** The current user's uid on POSIX; `undefined` where ownership is not checked (Windows). */
  readonly uid: number | undefined
}

/** The boundary facts of this process. */
export function processBoundary(): BoundaryFacts {
  return {
    home: homedir(),
    temp: tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Remove control characters (ANSI escapes, line breaks…) from text that came from a file the
 * launcher does not control, before it is printed to a terminal.
 */
export function printable(text: string): string {
  return text.replace(CONTROL, '')
}

/** Every spelling of a path worth comparing: as given and with symlinks resolved. */
function spellings(path: string): string[] {
  const out = [resolve(path)]
  try {
    out.push(realpathSync(path))
  } catch {
    // a path that does not exist has only its given spelling
  }
  return out
}

/** Path equality; case-insensitive on Windows and macOS, whose file systems usually are. */
function samePath(a: string, b: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin'
  const norm = (p: string): string => {
    const r = resolve(p)
    return fold ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** Whether `ancestor` is a strict ancestor of `path`. */
function isStrictAncestor(ancestor: string, path: string): boolean {
  const rel = relative(ancestor, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Whether `dir` may never be treated as a project: a file-system or drive root, the OS temp
 * directory itself, or a folder above the user's home directory. Anyone with write access to
 * those (other users, downloads, extracted archives) could otherwise plant a `node_modules` that
 * runs for every command typed below them.
 */
export function isForbiddenProjectDir(dir: string, facts: BoundaryFacts): boolean {
  for (const d of spellings(dir)) {
    if (dirname(d) === d) return true
    for (const temp of spellings(facts.temp)) if (samePath(d, temp)) return true
    for (const home of spellings(facts.home)) if (isStrictAncestor(d, home)) return true
  }
  return false
}

/** POSIX only: whether `dir` is owned by the current user. Always `true` without a uid. */
export function isOwnedByCurrentUser(dir: string, facts: BoundaryFacts): boolean {
  if (facts.uid === undefined) return true
  try {
    return statSync(dir).uid === facts.uid
  } catch {
    return false
  }
}

/** Whether a package.json declares `@strutvane/cli` as a dependency or devDependency. */
export function declaresCli(manifest: Readonly<Record<string, unknown>> | undefined): boolean {
  if (manifest === undefined) return false
  return ['dependencies', 'devDependencies'].some((field) => {
    const deps = manifest[field]
    return (
      typeof deps === 'object' &&
      deps !== null &&
      Object.hasOwn(deps, '@strutvane/cli') &&
      typeof (deps as Record<string, unknown>)['@strutvane/cli'] === 'string'
    )
  })
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

/**
 * Find the project-local `@strutvane/cli`, searching upwards from `start` under the boundary
 * rules in the module documentation. Returns `undefined` when there is none (or none that may be
 * trusted).
 */
export function findLocalCli(
  start: string,
  facts: BoundaryFacts = processBoundary(),
): LocalCli | undefined {
  let dir = resolve(start)
  for (;;) {
    if (isForbiddenProjectDir(dir, facts)) return undefined
    const hasMarker = existsSync(join(dir, PROJECT_MARKER))
    const isProject = hasMarker || declaresCli(readJson(join(dir, 'package.json')))
    if (isProject && isOwnedByCurrentUser(dir, facts)) {
      const packageDir = join(dir, 'node_modules', '@strutvane', 'cli')
      const manifest = readJson(join(packageDir, 'package.json'))
      if (manifest !== undefined) {
        const bin = binOf(packageDir, manifest)
        if (bin !== undefined) {
          const raw = typeof manifest['version'] === 'string' ? manifest['version'] : '0.0.0'
          return { packageDir, version: printable(raw).slice(0, 64), bin }
        }
      }
    }
    if (hasMarker) return undefined // project root: stop
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

/** The leading command word of argv (skipping flags and the `--cwd` value), if any. */
export function commandWord(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (token === '--') return undefined
    if (token === '--cwd') {
      i++
      continue
    }
    if (!token.startsWith('-')) return token
  }
  return undefined
}

/** Commands the launcher always answers itself, even inside a project. */
const LAUNCHER_COMMANDS: ReadonlySet<string> = new Set(['help', 'new', 'create'])

/**
 * Whether argv is a command the launcher answers itself and never delegates: no command word
 * (`strutvane`, `strutvane --version`, `strutvane --help`), `help`, `new` or `create`.
 */
export function isLauncherCommand(argv: readonly string[]): boolean {
  const word = commandWord(argv)
  return word === undefined || LAUNCHER_COMMANDS.has(word)
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
  /** Project boundary facts. Default: this process's ({@link processBoundary}). */
  readonly boundary?: BoundaryFacts
}

/** Characters allowed in arguments that pass through a Windows shell (the npx.cmd fallback). */
const SHELL_SAFE = /^[A-Za-z0-9@._/:=+,-]+$/
/** Characters allowed in an absolute shim path that is quoted for cmd.exe. */
const SHELL_SAFE_PATH = /^[^"%!^&|<>\r\n]+$/

/**
 * Environment for child processes. On Windows, `NoDefaultCurrentDirectoryInExePath` stops
 * cmd.exe (and the `.cmd` shims it runs) from finding programs in the working directory before
 * PATH, so a project folder can never shadow `node` or `npm`.
 */
export function childEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}),
    ...extra,
  }
}

/**
 * npm's `npx-cli.js` next to the running Node.js, so npx runs as `node npx-cli.js` with no shell
 * and no PATH lookup. Windows installs keep npm in `<node dir>/node_modules/npm`; POSIX installs
 * in `<prefix>/lib/node_modules/npm`.
 */
export function findNpxCli(execPath: string, platform: NodeJS.Platform): string | undefined {
  const p = platform === 'win32' ? win32 : { join, dirname }
  const dir = p.dirname(execPath)
  const candidates =
    platform === 'win32'
      ? [p.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')]
      : [
          p.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
          p.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
        ]
  return candidates.find((c) => existsSync(c))
}

/**
 * Windows only: the absolute path of `name` (e.g. `npx`) from PATH, trying each PATHEXT
 * extension. The working directory, relative PATH entries and empty entries are skipped, which is
 * exactly the lookup order cmd.exe would otherwise use to run a planted `npx.cmd` from the
 * project folder.
 */
export function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.startsWith('.'))
  const here = win32.resolve(cwd).toLowerCase()
  for (const entry of pathValue.split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '' || !win32.isAbsolute(dir) || win32.resolve(dir).toLowerCase() === here) continue
    for (const ext of exts) {
      const candidate = win32.join(dir, `${name}${ext.toLowerCase()}`)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

function help(version: string, local: LocalCli | undefined): string {
  const lines = [`strutvane ${version}: the Strutvane command line launcher`, '']
  if (local === undefined) {
    lines.push('No project-local @strutvane/cli was found, so only these commands are available:')
  } else {
    lines.push(
      `This project uses @strutvane/cli ${local.version}; it handles every project command`,
      '(e.g. strutvane make:model Invoice, strutvane migrate). To list them all, run:',
      '  pnpm exec strutvane-cli help     (or: npx strutvane-cli help)',
      '',
      'The launcher itself answers:',
    )
  }
  lines.push(
    '  strutvane new <name> [flags]   Create a project (runs create-strutvane)',
    '  strutvane doctor --global      Check this machine (Node.js version, package managers)',
    '  strutvane --version            Print the launcher version',
    '  strutvane help                 Show this help',
    '',
  )
  if (local === undefined) {
    lines.push(
      'Inside a project (a folder whose package.json lists @strutvane/cli, or with',
      "strutvane.config.ts), project commands are handled by the project's own @strutvane/cli,",
      'so they always match the versions in package.json.',
      '',
    )
  }
  return lines.join('\n')
}

/** Parse `STRUTVANE_CREATE_COMMAND`: a non-empty JSON array of strings, else `undefined`. */
function parseCommandOverride(value: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((p) => typeof p === 'string' && p !== '')
  ) {
    return undefined
  }
  return parsed as string[]
}

/** Run a project-less command through npx (or the override in `STRUTVANE_CREATE_COMMAND`). */
async function viaNpx(
  env: LauncherEnvironment,
  pkg: string,
  args: readonly string[],
): Promise<number> {
  const childEnvironment = childEnv(env.env, env.platform)
  const override = env.env[CREATE_ENV]
  if (override !== undefined && pkg.startsWith('create-strutvane')) {
    const parsed = parseCommandOverride(override)
    if (parsed === undefined) {
      env.stderr(`strutvane: ${CREATE_ENV} must be a JSON array of strings.\n`)
      return 2
    }
    const [command = '', ...rest] = parsed
    return env.spawn(command, [...rest, ...args], { env: childEnvironment, shell: false })
  }
  const npxArgs = ['--yes', pkg, ...args]
  // Preferred everywhere: `node npx-cli.js …` (no shell, no PATH lookup, any argument is safe).
  const npxCli = findNpxCli(env.execPath, env.platform)
  if (npxCli !== undefined) {
    return env.spawn(env.execPath, [npxCli, ...npxArgs], { env: childEnvironment, shell: false })
  }
  if (env.platform !== 'win32') {
    return env.spawn('npx', npxArgs, { env: childEnvironment, shell: false })
  }
  // Windows fallback: npx is a .cmd shim, which needs a shell. Resolve it from PATH (never the
  // working directory) and refuse arguments with shell meaning rather than escaping them.
  const shim = resolveWindowsExecutable('npx', env.env, env.cwd)
  if (shim === undefined || !SHELL_SAFE_PATH.test(shim)) {
    env.stderr('strutvane: could not find npx on PATH. Install Node.js with npm.\n')
    return 2
  }
  const unsafe = npxArgs.find((a) => !SHELL_SAFE.test(a))
  if (unsafe !== undefined) {
    env.stderr(
      `strutvane: refusing to pass "${printable(unsafe)}" to a shell. Use plain names and flags.\n`,
    )
    return 2
  }
  return env.spawn(`"${shim}"`, npxArgs, { env: childEnvironment, shell: true })
}

/** Run the launcher. Returns the exit code (the delegated CLI's, when delegating). */
export async function runLauncher(
  argv: readonly string[],
  env: LauncherEnvironment,
): Promise<number> {
  const depth = Number(env.env[DEPTH_ENV] ?? '0')
  const flag = cwdFlag(argv)
  const start = flag === undefined ? env.cwd : resolve(env.cwd, flag)
  const boundary = env.boundary ?? processBoundary()
  const local = depth >= 1 ? undefined : findLocalCli(start, boundary)

  if (local !== undefined && !isLauncherCommand(argv)) {
    const quiet = argv.includes('--json') || argv.includes('--quiet') || argv.includes('-q')
    if (local.version !== env.version && !quiet && env.env[NO_NOTICE_ENV] !== '1') {
      env.stderr(
        `strutvane: using the project's @strutvane/cli ${local.version} (launcher ${env.version}).\n`,
      )
    }
    return env.spawn(env.execPath, [local.bin, ...argv], {
      env: childEnv(env.env, env.platform, { [DEPTH_ENV]: String(depth + 1) }),
      shell: false,
    })
  }

  const word = commandWord(argv)
  if (word === undefined && (argv.includes('--version') || argv.includes('-V'))) {
    env.stdout(`strutvane ${env.version}\n`)
    if (local !== undefined) env.stdout(`project @strutvane/cli ${local.version}\n`)
    return 0
  }
  if (word === undefined || word === 'help') {
    env.stdout(help(env.version, local))
    return 0
  }
  const [first, ...rest] = argv
  if (first === 'new' || first === 'create') {
    return viaNpx(env, 'create-strutvane@latest', rest)
  }
  if (first === 'doctor' && rest.includes('--global')) {
    return viaNpx(env, `@strutvane/cli@${env.version}`, argv)
  }
  env.stderr(
    [
      `strutvane: "${printable(word)}" needs a Strutvane project, but no project-local @strutvane/cli was found`,
      `  (searched from ${start} upwards; only folders whose package.json lists @strutvane/cli`,
      '  or that contain strutvane.config.ts count, and never a drive root, the temp folder or a',
      '  folder above your home directory).',
      '  Run it inside a project, or add the CLI to this one: pnpm add -D @strutvane/cli',
      '  Create a new project with: strutvane new <name>',
      '',
    ].join('\n'),
  )
  return 2
}
