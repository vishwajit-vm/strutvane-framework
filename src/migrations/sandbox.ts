/**
 * The migration replay sandbox (security review F-06, a release blocker).
 *
 * Replaying migrations **executes** them: `node strut migrate`, `types`, `dev` and `migrate:status`
 * all import every file in `database/migrations`, also right after `git pull` or a PR checkout. A
 * hostile or careless migration must not be able to read secrets, touch the network, write files
 * or start programs while that happens. So the replay runs like this:
 *
 * 1. **Files first.** Each migration must be a real file (no symlink) whose real path stays inside
 *    the migrations folder (`lstat` + `realpath`), checked before anything runs.
 * 2. **Static gate** (oxc-parser), before import: imports only from `@strutvane/framework/schema`
 *    and relative `.ts` files inside the folder (checked the same way, recursively); no dynamic
 *    `import()`, `import.meta`, and no `process`, `globalThis`, `global`, `eval`, `Function`,
 *    `fetch` or `require`. Every finding names `file:line:col`.
 * 3. **A child process** (`node --permission`): it may read only the migrations folder and the
 *    framework's own files; it may not write files, start processes or workers, or load native
 *    addons; code generation from strings (`eval`, `new Function`) is off; its environment is
 *    empty apart from what Node needs on Windows (`SystemRoot`), so no `.env` value, token or
 *    `NODE_OPTIONS` reaches it. A resolve hook refuses every import except the schema entry and
 *    files in the folder, and the network globals are removed. Node 24 has no `--allow-net`, so the
 *    network is closed by the hook, the gate, the removed globals and the permission model together.
 * 4. **A timeout** (default {@link DEFAULT_SANDBOX_TIMEOUT_MS}) kills a child that hangs.
 * 5. **Plain JSON out.** The child sends only the recorded operations over IPC; the parent
 *    re-validates and re-folds them with `replayRecorded`, so nothing from the child is trusted.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { discoverMigrations, type Replay, replayRecorded } from '../schema/replay.ts'
import { SCHEMA_SPECIFIER, type WorkerMessage } from './replay-protocol.ts'

/** How long a replay may take before the child is killed (ms). */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 10_000

/** Stable codes of {@link SandboxError} (lowercase snake_case, decision #68). */
export type SandboxErrorCode =
  | 'migration_symlink'
  | 'migration_outside_folder'
  | 'migration_forbidden_import'
  | 'migration_forbidden_code'
  | 'migration_syntax'
  | 'replay_timeout'
  | 'replay_failed'

/**
 * The sandbox refused a migration, or the replay failed inside it.
 *
 * @example
 * try { await replayInSandbox(dir) } catch (error) {
 *   if (error instanceof SandboxError) report(`${error.location ?? error.migration}: ${error.message}`, error.hint)
 * }
 */
export class SandboxError extends Error {
  override readonly name = 'SandboxError'
  /** A stable code tools can match on. */
  readonly code: SandboxErrorCode
  /** How to fix it. */
  readonly hint: string
  /** The migration file concerned, when known. */
  readonly migration: string | undefined
  /** `file:line:col` of a static-gate finding. */
  readonly location: string | undefined

  constructor(
    code: SandboxErrorCode,
    message: string,
    hint: string,
    details: { readonly migration?: string; readonly location?: string } = {},
  ) {
    super(message)
    this.code = code
    this.hint = hint
    this.migration = details.migration
    this.location = details.location
  }
}

/**
 * Options for {@link replayInSandbox}.
 *
 * @example
 * await replayInSandbox(dir, { timeoutMs: 20_000 })
 */
export interface SandboxOptions {
  /** Kill the replay after this many ms. Default {@link DEFAULT_SANDBOX_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** Identifiers a migration may never mention. */
const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  'process',
  'globalThis',
  'global',
  'eval',
  'Function',
  'fetch',
  'require',
])

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Replay the migrations in `migrationsDir` inside the sandbox and return the validated replay.
 *
 * @example
 * const replay = await replayInSandbox(join(root, 'database', 'migrations'))
 * await migrate(connection, replay)
 */
export async function replayInSandbox(
  migrationsDir: string,
  options: SandboxOptions = {},
): Promise<Replay> {
  const folder = realpathSync(migrationsDir)
  const files = discoverMigrations(folder)
  for (const file of files) checkFile(folder, file.path, `${file.name}.ts`)
  const checked = new Set<string>()
  for (const file of files) gate(folder, file.path, checked)
  if (files.length === 0) return replayRecorded([])
  const message = await runWorker(
    folder,
    files.map((file) => `${file.name}.ts`),
    options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
  )
  if (!message.ok) {
    const migration = message.error.migration
    throw new SandboxError(
      'replay_failed',
      `${migration === undefined ? 'Replaying the migrations' : migration} failed: ${message.error.message}`,
      message.error.hint ?? 'Fix the migration and run the command again.',
      migration === undefined ? {} : { migration },
    )
  }
  return replayRecorded(message.migrations)
}

/** A migration (or a file it imports) must be a plain file inside the folder. */
function checkFile(folder: string, path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink())
    throw new SandboxError(
      'migration_symlink',
      `${label} is a symbolic link. Migrations must be real files in database/migrations.`,
      'Replace the link with the file itself.',
      { migration: label },
    )
  if (!isInside(folder, realpathSync(path)))
    throw new SandboxError(
      'migration_outside_folder',
      `${label} resolves to a file outside database/migrations.`,
      'Keep migrations and the helpers they import inside database/migrations.',
      { migration: label },
    )
}

/** Line and column (1-based) of an offset. */
function position(source: string, offset: number): string {
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - before.lastIndexOf('\n')
  return `${line}:${column}`
}

type AstNode = { readonly type: string; readonly start: number } & Readonly<Record<string, unknown>>

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string' &&
  typeof (value as { start?: unknown }).start === 'number'

/** The static gate for one file and, recursively, the relative files it imports. */
function gate(folder: string, path: string, checked: Set<string>): void {
  if (checked.has(path)) return
  checked.add(path)
  const label = relative(folder, path).replaceAll('\\', '/')
  const source = readFileSync(path, 'utf8')
  const parsed = parseSync(path, source, { sourceType: 'module' })
  const where = (node: AstNode): string => `${label}:${position(source, node.start)}`
  const firstError = parsed.errors[0]
  if (firstError !== undefined)
    throw new SandboxError(
      'migration_syntax',
      `${label} has a syntax error: ${firstError.message}`,
      'Fix the syntax error and run the command again.',
      { migration: label },
    )
  const refuse = (node: AstNode, what: string): never => {
    throw new SandboxError(
      'migration_forbidden_code',
      `${where(node)}: migrations may not use ${what}.`,
      'Migrations describe the schema with the schema builder only. Reading the environment, the network or files belongs in seeders or app code.',
      { migration: label, location: where(node) },
    )
  }
  const importFrom = (node: AstNode, specifier: unknown): void => {
    if (specifier === SCHEMA_SPECIFIER) return
    if (
      typeof specifier === 'string' &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      const target = resolve(dirname(path), specifier)
      if (extname(target) === '.ts' && isInside(folder, target) && existsSync(target)) {
        checkFile(folder, target, relative(folder, target).replaceAll('\\', '/'))
        gate(folder, target, checked)
        return
      }
    }
    throw new SandboxError(
      'migration_forbidden_import',
      `${where(node)}: migrations may not import "${String(specifier)}".`,
      `Import only ${SCHEMA_SPECIFIER} and .ts files inside database/migrations (with their .ts extension).`,
      { migration: label, location: where(node) },
    )
  }
  const visit = (node: AstNode, parent: AstNode | undefined, key: string): void => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const source = node['source']
        const typeOnly = node['importKind'] === 'type' || node['exportKind'] === 'type'
        if (isNode(source) && !typeOnly) importFrom(node, source['value'])
        break
      }
      case 'ImportExpression':
        refuse(node, 'dynamic import()')
        break
      case 'MetaProperty':
        refuse(node, 'import.meta')
        break
      case 'Identifier': {
        const name = node['name']
        const isPropertyName =
          parent !== undefined &&
          parent['computed'] !== true &&
          ((parent.type === 'MemberExpression' && key === 'property') ||
            ((parent.type === 'Property' ||
              parent.type === 'MethodDefinition' ||
              parent.type === 'PropertyDefinition') &&
              key === 'key'))
        if (typeof name === 'string' && !isPropertyName && FORBIDDEN_IDENTIFIERS.has(name))
          refuse(node, `\`${name}\``)
        break
      }
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, node, childKey)
      } else if (isNode(value)) visit(value, node, childKey)
    }
  }
  visit(parsed.program as unknown as AstNode, undefined, '')
}

/** The worker script beside this module (`.ts` from the sources, `.mjs` when built). */
function workerPath(): string {
  const own = fileURLToPath(import.meta.url)
  if (own.endsWith('.ts')) return join(dirname(own), 'replay-worker.ts')
  return join(dirname(own), 'replay-worker.mjs')
}

/** The environment the child gets: nothing but what Node needs on Windows. */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT']
    if (root !== undefined) env['SystemRoot'] = root
  }
  return env
}

const STDERR_LIMIT = 4_000

function runWorker(
  folder: string,
  files: readonly string[],
  timeoutMs: number,
): Promise<WorkerMessage> {
  const worker = workerPath()
  const frameworkFiles = worker.endsWith('.ts') ? resolve(dirname(worker), '..') : dirname(worker)
  const args = [
    '--permission',
    `--allow-fs-read=${folder}`,
    `--allow-fs-read=${frameworkFiles}`,
    '--disallow-code-generation-from-strings',
    '--disable-warning=ExperimentalWarning',
    worker,
    folder,
    ...files,
  ]
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      env: childEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    })
    let stderr = ''
    let settled = false
    let message: WorkerMessage | undefined
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() =>
        reject(
          new SandboxError(
            'replay_timeout',
            `Replaying the migrations took longer than ${timeoutMs} ms, so it was stopped.`,
            'A migration probably loops forever or waits for something at the top level. Migrations must only call the schema builder.',
          ),
        ),
      )
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('message', (received: unknown) => {
      if (message === undefined && isWorkerMessage(received)) message = received
    })
    child.on('error', (error) =>
      finish(() =>
        reject(
          new SandboxError(
            'replay_failed',
            `The replay process could not start: ${error.message}`,
            'Check that Node 24.3 or newer is installed.',
          ),
        ),
      ),
    )
    child.on('exit', (code) => {
      const received = message
      if (received !== undefined) {
        finish(() => resolvePromise(received))
        return
      }
      const detail = stderr.trim().split('\n').slice(0, 6).join('\n')
      finish(() =>
        reject(
          new SandboxError(
            'replay_failed',
            `The replay process stopped (exit code ${String(code)}) without a result.${detail === '' ? '' : `\n${detail}`}`,
            'A migration crashed the replay. Check the migration named above, or run node strut migrate:status for details.',
          ),
        ),
      )
    })
  })
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record['ok'] === true) return Array.isArray(record['migrations'])
  if (record['ok'] !== false) return false
  const error = record['error']
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as Record<string, unknown>)['message'] === 'string'
  )
}
