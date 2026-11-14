/**
 * Helpers for CLI tests: temporary projects, fake installed packages, and an in-process runner
 * that captures output and exit codes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { BUILTIN_COMMANDS } from '../../src/console/commands/builtins.ts'
import type { AnyCommand } from '../../src/console/framework/command.ts'
import type { Prompter } from '../../src/console/framework/prompter.ts'
import { type JsonEnvelope, runCli } from '../../src/console/framework/run.ts'
import type { Spawner, SpawnOptions, SpawnResult } from '../../src/console/framework/services.ts'
import { createTestClock } from '../../src/core/index.ts'
import { tempDir, writeFiles } from './registry/helpers.ts'

export {
  cleanupTempDirs,
  copyFixture,
  FIXTURE_DIR,
  tempDir,
  writeFiles,
} from './registry/helpers.ts'

/** A fixed instant for deterministic output (2026-11-14T09:30:00Z). */
export const FIXED_NOW: number = Date.UTC(2026, 10, 14, 9, 30, 0)

/** Create a temp project (package.json + strutvane.config.ts) with extra files. */
export function makeProject(
  files: Readonly<Record<string, string>> = {},
  packageJson: Readonly<Record<string, unknown>> = {},
): string {
  const root = tempDir('sv-cli-')
  writeFiles(root, {
    'package.json': `${JSON.stringify({ name: 'demo-app', private: true, type: 'module', ...packageJson }, null, 2)}\n`,
    'strutvane.config.ts': 'export default {}\n',
    ...files,
  })
  return root
}

/** Options for a fake installed package. */
export interface FakePackage {
  readonly version?: string
  readonly strutvane?: Readonly<Record<string, unknown>>
  /** Files inside the package (relative path → content). */
  readonly files?: Readonly<Record<string, string>>
  readonly bin?: unknown
}

/** Write a package into `<root>/node_modules/<name>`. */
export function installFakePackage(root: string, name: string, pkg: FakePackage = {}): string {
  const dir = join(root, 'node_modules', ...name.split('/'))
  writeFiles(dir, {
    'package.json': JSON.stringify({
      name,
      version: pkg.version ?? '0.1.0',
      type: 'module',
      ...(pkg.bin === undefined ? {} : { bin: pkg.bin }),
      ...(pkg.strutvane === undefined ? {} : { strutvane: pkg.strutvane }),
    }),
    ...pkg.files,
  })
  return dir
}

/** Add dependencies to a project's package.json. */
export function addDependencies(root: string, deps: Readonly<Record<string, string>>): void {
  const path = join(root, 'package.json')
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  json['dependencies'] = {
    ...(json['dependencies'] as Record<string, string> | undefined),
    ...deps,
  }
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
}

/** A recorded spawn call. */
export interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
}

/** A fake spawner that records calls and answers with `respond`. */
export function fakeSpawner(
  respond: (call: SpawnCall) => Partial<SpawnResult> | undefined = () => undefined,
): Spawner & { calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawner = (async (command: string, args: readonly string[], options: SpawnOptions) => {
    const call = { command, args, options }
    calls.push(call)
    const result = respond(call)
    return { code: result?.code ?? 0, stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' }
  }) as Spawner & { calls: SpawnCall[] }
  spawner.calls = calls
  return spawner
}

/** Options for {@link cli}. */
export interface CliTestOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly isTTY?: boolean
  readonly spawn?: Spawner
  readonly prompter?: Prompter
  readonly now?: number
  readonly signal?: AbortSignal
  readonly builtins?: readonly AnyCommand[]
  readonly version?: string
}

/** The captured result of one CLI run. */
export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** Parse stdout as the `--json` envelope. */
  json(): JsonEnvelope
}

/** Run the CLI in-process with captured streams and deterministic services. */
export async function cli(argv: readonly string[], options: CliTestOptions): Promise<CliResult> {
  let stdout = ''
  let stderr = ''
  const code = await runCli({
    argv,
    cwd: options.cwd,
    builtins: options.builtins ?? BUILTIN_COMMANDS,
    streams: {
      stdout: (t) => {
        stdout += t
      },
      stderr: (t) => {
        stderr += t
      },
    },
    services: {
      env: options.env ?? {},
      isTTY: options.isTTY ?? false,
      spawn: options.spawn ?? fakeSpawner(() => ({ code: 99 })),
      clock: createTestClock(options.now ?? FIXED_NOW),
      signal: options.signal ?? new AbortController().signal,
    },
    ...(options.prompter === undefined ? {} : { prompter: options.prompter }),
    ...(options.version === undefined ? {} : { version: options.version }),
  })
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as JsonEnvelope }
}

/** Every file under `root` (POSIX relative paths), excluding node_modules. */
export function listFiles(root: string, dir: string = root): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) out.push(...listFiles(root, abs))
    else out.push(relative(root, abs).replaceAll('\\', '/'))
  }
  return out.sort()
}

/** Snapshot of every file's content under `root` (to prove "zero writes"). */
export function snapshotTree(root: string): Record<string, string> {
  return Object.fromEntries(listFiles(root).map((f) => [f, readFileSync(join(root, f), 'utf8')]))
}

/** Read a project file. */
export function read(root: string, rel: string): string {
  return readFileSync(join(root, ...rel.split('/')), 'utf8')
}

/** Write one file (creating folders). */
export function write(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** A scripted prompter: answers are consumed in order; records the questions asked. */
export function scriptedPrompter(
  answers: readonly (string | boolean)[],
): Prompter & { asked: string[] } {
  const queue = [...answers]
  const asked: string[] = []
  const next = (message: string): string | boolean => {
    asked.push(message)
    if (queue.length === 0) throw new Error(`no scripted answer for: ${message}`)
    return queue.shift() as string | boolean
  }
  return {
    interactive: true,
    asked,
    async confirm(message) {
      return next(message) === true
    },
    async text(message, opts = {}) {
      const answer = String(next(message))
      const problem = opts.validate?.(answer)
      if (problem !== undefined) throw new Error(`validation failed: ${problem}`)
      return answer
    },
    async select(message) {
      return String(next(message))
    },
  }
}
