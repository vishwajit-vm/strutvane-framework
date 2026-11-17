/**
 * The migration replay sandbox (security review F-06, a release blocker).
 *
 * Replaying migrations **executes** them: `node strut migrate`, `types`, `dev` and `migrate:status`
 * all import every file in `database/migrations`, also right after `git pull` or a PR checkout. A
 * hostile or careless migration must not be able to read secrets, touch the network, write files
 * or start programs while that happens. So the replay runs like this:
 *
 * 1. **Files first.** Each migration must be a real file (no symlink) whose real path stays inside
 *    the migrations folder (`lstat` + `realpath`), checked before anything runs. The folder may
 *    not contain a `package.json` or `node_modules`, which would change how files load.
 * 2. **Static gate** (oxc-parser), before import: imports only from `@strutvane/framework/schema`
 *    and relative `.ts` files inside the folder (resolved by {@link resolveMigrationImport}, the
 *    same function the child's import hook uses, and checked the same way, recursively); no
 *    dynamic `import()`, `import.meta`, `import x = require()`, `export =`, and no `process`,
 *    `globalThis`, `global`, `eval`, `Function`, `fetch`, `require`, `module`, `exports`,
 *    `__dirname` or `__filename`. Every finding names `file:line:col`. Every file it approves is
 *    pinned by the SHA-256 of the bytes it checked.
 * 3. **A child process** (`node --permission`) that holds even if the gate were bypassed (see
 *    `replay-worker.ts`): it may read only the migrations folder and the framework's own files; it
 *    may not write files, start processes or workers, or load native addons; code generation from
 *    strings is off, intrinsics are frozen and `__proto__` throws; memory is capped; its
 *    environment is empty apart from what Node needs on Windows (`SystemRoot`), so no `.env`
 *    value, token or `NODE_OPTIONS` reaches it. It checks its own confinement before running
 *    anything, loads only the approved bytes (always as ES modules) and empties its global scope.
 * 4. **A timeout** (default {@link DEFAULT_SANDBOX_TIMEOUT_MS}) kills a child that hangs.
 * 5. **Plain JSON out**, capped in size. The parent re-validates and re-folds it with
 *    `replayRecorded`, so nothing from the child is trusted.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { discoverMigrations, type Replay, replayRecorded } from '../schema/replay.ts'
import {
  isInside,
  RESULT_LIMIT_BYTES,
  type ReplayManifest,
  resolveMigrationImport,
  SCHEMA_SPECIFIER,
  type WorkerMessage,
} from './replay-protocol.ts'

/** How long a replay may take before the child is killed (ms). */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 10_000

/** The child's heap limit (MB): far above what replaying schema operations needs. */
const CHILD_HEAP_MB = 512

/** Stable codes of {@link SandboxError} (lowercase snake_case, decision #68). */
export type SandboxErrorCode =
  | 'migration_symlink'
  | 'migration_outside_folder'
  | 'migration_forbidden_import'
  | 'migration_forbidden_code'
  | 'migration_forbidden_file'
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

/** Identifiers a migration may never mention (also the CommonJS ones, whatever the file's format). */
const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  'process',
  'globalThis',
  'global',
  'eval',
  'Function',
  'fetch',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
])

/** TypeScript forms that only make sense in CommonJS. */
const FORBIDDEN_NODES: Readonly<Record<string, string>> = {
  TSImportEqualsDeclaration: '`import x = require()`',
  TSExportAssignment: '`export =`',
  TSExternalModuleReference: '`require()` imports',
}

/** Files that change how Node loads the files around them; never allowed in the folder. */
const MODULE_SCOPE_FILES: ReadonlySet<string> = new Set(['package.json', 'node_modules'])

/** How deep (and how wide) the folder scan goes before giving up, fail closed. */
const SCAN_DEPTH = 16
const SCAN_ENTRIES = 10_000

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
  const manifest = approveMigrations(migrationsDir)
  if (manifest.entries.length === 0) return replayRecorded([])
  const message = await runReplayWorker(manifest, options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)
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

/**
 * Run every check that happens before anything executes (files, folder, static gate) and return
 * the manifest the child gets: the migrations in order and every approved file with its SHA-256.
 *
 * @example
 * const manifest = approveMigrations(join(root, 'database', 'migrations'))
 */
export function approveMigrations(migrationsDir: string): ReplayManifest {
  const folder = realpathSync(migrationsDir)
  scanFolder(folder)
  const files = discoverMigrations(folder)
  for (const file of files) checkFile(folder, file.path, `${file.name}.ts`)
  const approved: Record<string, string> = {}
  for (const file of files) gate(folder, file.path, approved)
  return { folder, entries: files.map((file) => `${file.name}.ts`), approved }
}

/** Refuse a `package.json` or `node_modules` anywhere in the folder (links are not followed). */
function scanFolder(folder: string): void {
  let seen = 0
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      seen += 1
      const label = relative(folder, join(dir, entry.name)).replaceAll('\\', '/')
      if (MODULE_SCOPE_FILES.has(entry.name.toLowerCase()))
        throw new SandboxError(
          'migration_forbidden_file',
          `${label} is inside database/migrations. It would change how the migrations are loaded.`,
          'Remove it: migrations are always ES modules that import only the schema builder and each other.',
          { migration: label },
        )
      if (seen > SCAN_ENTRIES || depth > SCAN_DEPTH)
        throw new SandboxError(
          'migration_forbidden_file',
          'database/migrations is too large or too deeply nested to check.',
          'Keep only migrations and their helpers in the folder.',
        )
      if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(folder, 0)
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
  if (!lstatSync(path).isFile())
    throw new SandboxError(
      'migration_forbidden_file',
      `${label} is not a regular file.`,
      'Migrations and their helpers must be plain .ts files.',
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

/** Read a file once: its exact bytes' SHA-256 and the text (refusing what isn't UTF-8). */
function readChecked(
  path: string,
  label: string,
): { readonly hash: string; readonly source: string } {
  const bytes = readFileSync(path)
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SandboxError(
      'migration_syntax',
      `${label} is not valid UTF-8 text.`,
      'Save the file as UTF-8.',
      { migration: label },
    )
  }
  return { hash: createHash('sha256').update(bytes).digest('hex'), source }
}

/** The static gate for one file and, recursively, the relative files it imports. */
function gate(folder: string, path: string, approved: Record<string, string>): void {
  if (approved[path] !== undefined) return
  const label = relative(folder, path).replaceAll('\\', '/')
  const { hash, source } = readChecked(path, label)
  // Approve before descending, so import cycles end; a refusal below aborts the whole replay.
  approved[path] = hash
  const parsed = parseSync(path, source, { sourceType: 'module', lang: 'ts' })
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
    const target =
      typeof specifier === 'string' ? resolveMigrationImport(specifier, path, folder) : undefined
    if (target !== undefined && existsSync(target)) {
      checkFile(folder, target, relative(folder, target).replaceAll('\\', '/'))
      gate(folder, target, approved)
      return
    }
    throw new SandboxError(
      'migration_forbidden_import',
      `${where(node)}: migrations may not import "${String(specifier)}".`,
      `Import only ${SCHEMA_SPECIFIER} and .ts files inside database/migrations, as ./path/file.ts (letters, digits, _, - and dots only).`,
      { migration: label, location: where(node) },
    )
  }
  const visit = (node: AstNode, parent: AstNode | undefined, key: string): void => {
    const forbiddenNode = FORBIDDEN_NODES[node.type]
    if (forbiddenNode !== undefined) refuse(node, forbiddenNode)
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

/**
 * The flags the child runs with. Exported so tests can prove each barrier is present.
 *
 * @example
 * childArguments('/app/database/migrations', '/fw/dist/replay-worker.mjs')
 */
export function childArguments(folder: string, worker: string): string[] {
  const frameworkFiles = worker.endsWith('.ts') ? resolve(dirname(worker), '..') : dirname(worker)
  return [
    '--permission',
    `--allow-fs-read=${folder}`,
    `--allow-fs-read=${frameworkFiles}`,
    '--disallow-code-generation-from-strings',
    '--frozen-intrinsics',
    '--disable-proto=throw',
    '--no-addons',
    `--max-old-space-size=${CHILD_HEAP_MB}`,
    '--disable-warning=ExperimentalWarning',
    worker,
  ]
}

const STDERR_LIMIT = 4_000

/**
 * Start the sandboxed child with a manifest and wait for its answer. Exported for the sandbox's
 * own tests, which feed it files the static gate would refuse to prove the child holds alone; app
 * code calls {@link replayInSandbox}.
 *
 * @example
 * const message = await runReplayWorker(approveMigrations(dir), 10_000)
 */
export function runReplayWorker(
  manifest: ReplayManifest,
  timeoutMs: number,
): Promise<WorkerMessage> {
  const args = childArguments(manifest.folder, workerPath())
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const fail = (code: SandboxErrorCode, message: string, hint: string): void => {
      child.kill('SIGKILL')
      finish(() => reject(new SandboxError(code, message, hint)))
    }
    const timer = setTimeout(
      () =>
        fail(
          'replay_timeout',
          `Replaying the migrations took longer than ${timeoutMs} ms, so it was stopped.`,
          'A migration probably loops forever or waits for something at the top level. Migrations must only call the schema builder.',
        ),
      timeoutMs,
    )
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > RESULT_LIMIT_BYTES) {
        fail(
          'replay_failed',
          `The replay process answered with more than ${RESULT_LIMIT_BYTES} bytes, so it was stopped.`,
          'A migration produced an unreasonable amount of schema operations. Check the newest migrations.',
        )
        return
      }
      stdout.push(chunk)
    })
    // The child may exit before reading its stdin (a crash at start); that is reported on exit.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(manifest))
    child.on('error', (error) =>
      fail(
        'replay_failed',
        `The replay process could not start: ${error.message}`,
        'Check that Node 24.3 or newer is installed.',
      ),
    )
    child.on('close', (code) => {
      const received = parseAnswer(Buffer.concat(stdout).toString('utf8'))
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

function parseAnswer(text: string): WorkerMessage | undefined {
  if (text === '') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isWorkerMessage(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record['ok'] === true) return Array.isArray(record['migrations'])
  if (record['ok'] !== false) return false
  const error = record['error']
  if (typeof error !== 'object' || error === null) return false
  const fields = error as Record<string, unknown>
  return (
    typeof fields['message'] === 'string' &&
    ['code', 'hint', 'migration'].every(
      (key) => fields[key] === undefined || typeof fields[key] === 'string',
    )
  )
}
