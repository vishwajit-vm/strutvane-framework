/**
 * The child side of the migration replay sandbox (security review F-06). Never imported by app
 * code: `replayInSandbox()` starts it as `node --permission … replay-worker` and writes a
 * {@link ReplayManifest} to its stdin.
 *
 * The parent's static gate is the first barrier. This file is the second one, and it is built to
 * hold **on its own**, as if the gate had let everything through:
 *
 * 1. **Confinement self-check.** Before reading a single migration it asks Node's permission model
 *    what it may do; unless file writes, reads outside the folder, child processes, workers,
 *    addons, WASI and the inspector are all denied, it refuses to run (fail closed).
 * 2. **Only approved bytes run.** A resolve hook maps `@strutvane/framework/schema` to the
 *    framework's own entry and resolves relative imports with the parent's own
 *    {@link resolveMigrationImport}; a load hook then serves only the files the parent approved,
 *    after checking each one's SHA-256 against the manifest, and **always as an ES module**, so no
 *    `package.json` (`"type": "commonjs"` at any ancestor) and no extension can turn a migration
 *    into CommonJS with `require`, `module` and a sloppy-mode `this`. Everything else is refused:
 *    `node:` modules, packages, files elsewhere, `data:` URLs, dynamic `import()`.
 * 3. **An empty global scope.** Every global outside a short allowlist of language built-ins and
 *    harmless web APIs is removed (`process`, `Buffer`, `fetch`, `WebSocket`, `navigator`,
 *    `performance`, `MessageChannel`, `WebAssembly`, …), `console` is replaced by one that cannot
 *    hand out its streams, and the `process` object itself loses `getBuiltinModule`, `binding`,
 *    `_linkedBinding` and `dlopen`. Intrinsics are frozen (`--frozen-intrinsics`), so a migration
 *    can't plant a getter on `Object.prototype` to catch the worker's own objects later.
 * 4. **Plain JSON out** on stdout, capped by the parent, which re-validates and re-folds it.
 *
 * Node 24 has no `--allow-net`; on Node versions that have it, the permission model also denies
 * the network, and the self-check reports which of the two applies.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { join, parse } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatWithOptions } from 'node:util'
import { SchemaError } from '../schema/errors.ts'
import { assertMigration } from '../schema/migration.ts'
import { type LoadedMigration, replayMigrations } from '../schema/replay.ts'
import {
  isInside,
  type ReplayManifest,
  resolveMigrationImport,
  SCHEMA_SPECIFIER,
  type WorkerMessage,
} from './replay-protocol.ts'

export { SCHEMA_SPECIFIER, type WorkerMessage } from './replay-protocol.ts'

/**
 * The globals a migration keeps: the ECMAScript built-ins and a few web APIs without any I/O.
 * Everything else is deleted before the first migration is imported (an allowlist, so a global a
 * future Node adds is removed by default).
 */
export const SAFE_GLOBALS: ReadonlySet<string> = new Set([
  // ECMAScript
  'Object',
  'Function',
  'Array',
  'Number',
  'parseFloat',
  'parseInt',
  'Infinity',
  'NaN',
  'undefined',
  'Boolean',
  'String',
  'Symbol',
  'Date',
  'Promise',
  'RegExp',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'SuppressedError',
  'globalThis',
  'JSON',
  'Math',
  'Intl',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'Atomics',
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigUint64Array',
  'BigInt64Array',
  'Uint8ClampedArray',
  'DataView',
  'Map',
  'BigInt',
  'Set',
  'Iterator',
  'WeakMap',
  'WeakSet',
  'Proxy',
  'Reflect',
  'FinalizationRegistry',
  'WeakRef',
  'DisposableStack',
  'AsyncDisposableStack',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
  'eval',
  'isFinite',
  'isNaN',
  // Web APIs without I/O
  'console',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'structuredClone',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'atob',
  'btoa',
  'AbortController',
  'AbortSignal',
  'Event',
  'EventTarget',
  'DOMException',
])

/** `process` methods that reach native code or built-in modules; replaced by refusals. */
export const SEALED_PROCESS_METHODS: readonly string[] = [
  'getBuiltinModule',
  'binding',
  '_linkedBinding',
  'dlopen',
]

/**
 * What the worker allows, built from the manifest.
 *
 * @example
 * const rules = sandboxRules(manifest, import.meta.url)
 */
export interface SandboxRules {
  readonly migrationsDir: string
  /** The framework's own files (`src/` from the sources, `dist/` when built). */
  readonly frameworkDir: string
  readonly schemaUrl: string
  /** `file:` URL of every approved file → the SHA-256 the gate saw. */
  readonly approved: ReadonlyMap<string, string>
  /**
   * Set once the global scope is locked down. From then on only the schema entry (already loaded)
   * and approved files resolve or load: no `node:` module and no other framework file, whoever
   * asks, so a migration that tampers with a web API can't steer the worker's own imports.
   */
  locked: boolean
}

/**
 * The framework's own schema entry, next to this worker: `src/entries/schema.ts` when running from
 * the sources, `schema.mjs` beside the built `replay-worker.mjs`.
 *
 * @example
 * schemaEntryUrl('file:///app/node_modules/@strutvane/framework/dist/replay-worker.mjs')
 * // 'file:///app/node_modules/@strutvane/framework/dist/schema.mjs'
 */
export function schemaEntryUrl(workerUrl: string): string {
  return workerUrl.endsWith('.ts')
    ? new URL('../entries/schema.ts', workerUrl).href
    : new URL('./schema.mjs', workerUrl).href
}

/**
 * Turn the parent's manifest into {@link SandboxRules} for a worker at `workerUrl`.
 *
 * @example
 * sandboxRules({ folder, entries, approved }, import.meta.url)
 */
export function sandboxRules(manifest: ReplayManifest, workerUrl: string): SandboxRules {
  const approved = new Map<string, string>()
  for (const [path, hash] of Object.entries(manifest.approved))
    approved.set(pathToFileURL(path).href, hash)
  return {
    migrationsDir: manifest.folder,
    frameworkDir: fileURLToPath(new URL(workerUrl.endsWith('.ts') ? '..' : '.', workerUrl)),
    schemaUrl: schemaEntryUrl(workerUrl),
    approved,
    locked: false,
  }
}

const refuse = (what: string): never => {
  throw new SchemaError(
    'invalid_migration',
    `A migration tried to load ${what}, which migrations may not use.`,
    `Migrations may only import ${SCHEMA_SPECIFIER} and .ts files inside database/migrations. Put data changes that need other modules in a seeder.`,
  )
}

const filePath = (url: string): string | undefined =>
  url.startsWith('file:') ? fileURLToPath(url) : undefined

/** A framework file (and not something inside the migrations folder)? */
const isFrameworkFile = (path: string | undefined, rules: SandboxRules): boolean =>
  path !== undefined && isInside(rules.frameworkDir, path) && !isInside(rules.migrationsDir, path)

/**
 * Decide one import inside the sandbox (the resolve hook): the mapped schema entry, an approved
 * file a migration imports, `'next'` for the framework's own imports, or a refusal (thrown as a
 * {@link SchemaError}). A `'next'` result still goes through {@link checkResolved}.
 *
 * @example
 * sandboxResolve('@strutvane/framework/schema', parentUrl, rules) // { url: '…/schema.mjs' }
 */
export function sandboxResolve(
  specifier: string,
  parentUrl: string | undefined,
  rules: SandboxRules,
): { readonly url: string } | 'next' {
  if (specifier === SCHEMA_SPECIFIER) return { url: rules.schemaUrl }
  if (parentUrl !== undefined && rules.approved.has(parentUrl)) {
    const parentPath = filePath(parentUrl)
    const target =
      parentPath === undefined
        ? undefined
        : resolveMigrationImport(specifier, parentPath, rules.migrationsDir)
    const url = target === undefined ? undefined : pathToFileURL(target).href
    if (url !== undefined && rules.approved.has(url)) return { url }
    return refuse(`"${specifier}"`)
  }
  const fromFramework = parentUrl !== undefined && isFrameworkFile(filePath(parentUrl), rules)
  // The worker imports each migration by its exact, approved URL.
  if (fromFramework && rules.approved.has(specifier)) return { url: specifier }
  // Before the lockdown the framework's own modules (the schema entry and what it imports)
  // resolve normally; after it, nothing else does.
  if (fromFramework && !rules.locked) return 'next'
  return refuse(`"${specifier}"`)
}

/**
 * Check what Node resolved for a framework import: it may be a built-in, a framework file, or
 * exactly an approved migration URL (no query string, no other spelling); anything else is refused.
 *
 * @example
 * checkResolved('file:///app/database/migrations/2026_…_x.ts', rules) // ok when approved
 */
export function checkResolved(url: string, rules: SandboxRules): void {
  if (rules.approved.has(url)) return
  if (rules.locked) refuse(`"${url}"`)
  if (url.startsWith('node:')) return
  if (isFrameworkFile(filePath(url), rules)) return
  refuse(`"${url}"`)
}

/**
 * Decide one load inside the sandbox (the load hook). An approved file is read, checked against
 * its SHA-256 and returned as **ES module TypeScript**, whatever any `package.json` says; built-ins
 * and framework files load normally; everything else is refused.
 *
 * @example
 * sandboxLoad(url, rules, (path) => readFileSync(path)) // { source: '…' } | 'next'
 */
export function sandboxLoad(
  url: string,
  rules: SandboxRules,
  read: (path: string) => Uint8Array,
): { readonly source: string } | 'next' {
  const expected = rules.approved.get(url)
  const path = filePath(url)
  if (expected !== undefined && path !== undefined) {
    const bytes = read(path)
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new SchemaError(
        'invalid_migration',
        `${path} changed while the migrations were being replayed.`,
        'Run the command again once nothing is editing the migrations.',
      )
    return { source: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  }
  if (!rules.locked && (url.startsWith('node:') || isFrameworkFile(path, rules))) return 'next'
  return refuse(`"${url}"`)
}

/** The part of `process.permission` the self-check uses. */
export interface PermissionProbe {
  has(scope: string, reference?: string): boolean
}

/**
 * The confinement self-check: refuse to replay anything unless Node's permission model is on and
 * denies everything the sandbox promises to deny. Returns whether the network is denied too
 * (`--allow-net` exists only on newer Node versions).
 *
 * @example
 * assertConfined(process.permission, rules, process.allowedNodeEnvironmentFlags)
 */
export function assertConfined(
  permission: PermissionProbe | undefined,
  rules: Pick<SandboxRules, 'migrationsDir' | 'frameworkDir'>,
  flags: ReadonlySet<string>,
): { readonly networkDenied: boolean } {
  const fail = (what: string): never => {
    throw new SchemaError(
      'invalid_migration',
      `The replay sandbox is not confined (${what}), so no migration was run.`,
      'Run Strutvane with Node 24.3 or newer and without NODE_OPTIONS that change permissions.',
    )
  }
  if (permission === undefined) return fail('the permission model is off')
  const outside = join(parse(rules.migrationsDir).root, 'strutvane-sandbox-probe')
  const denied: readonly (readonly [string, string?])[] = [
    ['fs.write'],
    ['fs.write', rules.migrationsDir],
    ['fs.read', outside],
    ['fs.read', join(rules.migrationsDir, '..')],
    ['child'],
    ['worker'],
    ['addon'],
    ['wasi'],
    ['inspector'],
  ]
  for (const [scope, reference] of denied) {
    const granted =
      reference === undefined ? permission.has(scope) : permission.has(scope, reference)
    if (granted) fail(`${scope}${reference === undefined ? '' : ` ${reference}`} is allowed`)
  }
  if (!permission.has('fs.read', rules.migrationsDir)) fail('the migrations folder is unreadable')
  const networkDenied = flags.has('--allow-net')
  if (networkDenied && permission.has('net')) fail('net is allowed')
  return { networkDenied }
}

/**
 * Empty the global scope down to {@link SAFE_GLOBALS}, replace `console` and seal the dangerous
 * `process` methods. Throws (fail closed) if a global can't be removed.
 *
 * @example
 * lockDown(globalThis, process, (text) => process.stderr.write(text))
 */
export function lockDown(
  scope: object,
  proc: object,
  writeError: (text: string) => void,
): readonly string[] {
  const removed: string[] = []
  for (const key of Reflect.ownKeys(scope)) {
    if (typeof key === 'string' && SAFE_GLOBALS.has(key)) continue
    if (!Reflect.deleteProperty(scope, key))
      throw new SchemaError(
        'invalid_migration',
        `The replay sandbox could not remove the global ${String(key)}, so no migration was run.`,
        'Report this with your Node version: the sandbox needs a newer Strutvane release.',
      )
    if (typeof key === 'string') removed.push(key)
  }
  const print = (...args: unknown[]): void => {
    writeError(`${formatWithOptions({ customInspect: false, colors: false }, ...args)}\n`)
  }
  const quiet = (): void => {}
  Object.defineProperty(scope, 'console', {
    value: Object.freeze({
      log: print,
      info: print,
      warn: print,
      error: print,
      debug: print,
      trace: print,
      dir: print,
      table: print,
      assert: quiet,
      count: quiet,
      countReset: quiet,
      group: quiet,
      groupCollapsed: quiet,
      groupEnd: quiet,
      time: quiet,
      timeEnd: quiet,
      timeLog: quiet,
    }),
    configurable: false,
    writable: false,
    enumerable: false,
  })
  // What is left is frozen too: `--frozen-intrinsics` covers the language built-ins, not the web
  // APIs (URL, TextDecoder, EventTarget, timers…), whose prototypes a migration could otherwise
  // rewrite to steer code that runs after it.
  for (const key of Reflect.ownKeys(scope)) freezeDeep(Reflect.get(scope, key))
  for (const name of SEALED_PROCESS_METHODS) {
    Object.defineProperty(proc, name, {
      value: () => refuse(`process.${name}`),
      configurable: false,
      writable: false,
    })
  }
  return removed
}

/**
 * Freeze a value and, for a class, its prototype. Prototype chains end in other globals (frozen by
 * their own entry) or in language intrinsics (frozen by `--frozen-intrinsics`).
 *
 * @example
 * freezeDeep(URL) // URL and URL.prototype can no longer change
 */
export function freezeDeep(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return
  if (value === globalThis) return
  Object.freeze(value)
  if (typeof value === 'function') {
    const prototype: unknown = Reflect.get(value, 'prototype')
    if (typeof prototype === 'object' && prototype !== null) Object.freeze(prototype)
  }
}

/**
 * Import and replay the given migration files, and turn the outcome into the message the parent
 * reads: the recorded operations, or the error (message, code, hint and the migration's file).
 * Runs inside the sandboxed child after {@link main} has locked imports and globals down.
 *
 * @example
 * const message = await recordMigrations(folder, ['2026_01_01_000000_create_tags_table.ts'])
 */
export async function recordMigrations(
  migrationsDir: string,
  files: readonly string[],
): Promise<WorkerMessage> {
  try {
    // Every URL is a plain string computed before the first migration runs: nothing a migration
    // does to URL or path helpers can change which file the next import names.
    const targets = files.map((file) => ({
      file,
      name: file.slice(0, -'.ts'.length),
      url: pathToFileURL(join(migrationsDir, file)).href,
    }))
    const loaded: LoadedMigration[] = []
    for (const { file, name, url } of targets) {
      try {
        const module: unknown = await import(url)
        const exported =
          typeof module === 'object' && module !== null && 'default' in module
            ? module.default
            : undefined
        loaded.push({ name, migration: assertMigration(exported, file) })
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          migration: file,
        })
      }
    }
    const replay = replayMigrations(loaded)
    return {
      ok: true,
      migrations: replay.migrations.map((step) => ({
        name: step.name,
        up: step.up,
        down: step.down,
      })),
    }
  } catch (error) {
    return failure(error)
  }
}

const MESSAGE_LIMIT = 2_000

/** An error as the plain message the parent reads (strings only, each one capped). */
function failure(error: unknown): WorkerMessage {
  const fields = error instanceof Error ? (error as Error & Record<string, unknown>) : undefined
  const text = (key: string): string | undefined => {
    const value = fields?.[key]
    return typeof value === 'string' ? value.slice(0, MESSAGE_LIMIT) : undefined
  }
  const code = text('code')
  const hint = text('hint')
  const migration = text('migration')
  return {
    ok: false,
    error: {
      message: (error instanceof Error ? error.message : String(error)).slice(0, MESSAGE_LIMIT),
      ...(code === undefined ? {} : { code }),
      ...(hint === undefined ? {} : { hint }),
      ...(migration === undefined ? {} : { migration }),
    },
  }
}

/**
 * Check the manifest's shape (it comes from the parent, but nothing crosses a process boundary
 * unchecked).
 *
 * @example
 * parseManifest('{"folder":"/m","entries":[],"approved":{}}')
 */
export function parseManifest(text: string): ReplayManifest {
  const value: unknown = JSON.parse(text)
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const { folder, entries, approved } = record
  const isStrings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === 'string')
  const isHashes = (map: unknown): map is Record<string, string> =>
    typeof map === 'object' &&
    map !== null &&
    Object.values(map).every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))
  if (typeof folder !== 'string' || !isStrings(entries) || !isHashes(approved))
    throw new SchemaError(
      'invalid_migration',
      'The replay sandbox received an invalid manifest.',
      'This is a bug in Strutvane: report it with the command you ran.',
    )
  return { folder, entries, approved }
}

async function readAll(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) if (chunk instanceof Uint8Array) chunks.push(chunk)
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** The sandboxed child: check confinement, lock imports and globals down, replay, answer, exit. */
async function main(): Promise<void> {
  const proc = process
  const stdout = proc.stdout
  const stderr = proc.stderr
  let message: WorkerMessage
  try {
    const manifest = parseManifest(await readAll(proc.stdin))
    const rules = sandboxRules(manifest, import.meta.url)
    assertConfined(proc.permission, rules, proc.allowedNodeEnvironmentFlags)
    // Warm the TypeScript stripper while the globals it may need still exist.
    stripTypeScriptTypes('const warm: number = 1')
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const decision = sandboxResolve(specifier, context.parentURL, rules)
        if (decision !== 'next') return { url: decision.url, shortCircuit: true }
        const resolved = nextResolve(specifier, context)
        checkResolved(resolved.url, rules)
        return resolved
      },
      load(url, context, nextLoad) {
        const decision = sandboxLoad(url, rules, (path) => readFileSync(path))
        if (decision === 'next') return nextLoad(url, context)
        return { format: 'module-typescript', source: decision.source, shortCircuit: true }
      },
    })
    // Load the schema entry (and everything it imports) while the framework may still resolve
    // normally; migrations then get it from the module cache.
    await import(rules.schemaUrl)
    lockDown(globalThis, proc, (text) => {
      stderr.write(text)
    })
    // Timer handles are objects a migration can get (setTimeout's return value): freeze their
    // prototypes as well.
    const timeout = setTimeout(() => {}, 0)
    clearTimeout(timeout)
    const immediate = setImmediate(() => {})
    clearImmediate(immediate)
    for (const handle of [timeout, immediate]) freezeDeep(Object.getPrototypeOf(handle))
    rules.locked = true
    message = await recordMigrations(manifest.folder, manifest.entries)
  } catch (error) {
    message = failure(error)
  }
  stdout.write(JSON.stringify(message), () => proc.exit(0))
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
