/**
 * The replay sandbox's **second barrier**, tested as if the static gate didn't exist: hostile
 * migrations go straight to the child through {@link runReplayWorker} with a hand-made manifest,
 * so every escape below is stopped by the child alone (permission model, pinned ESM loading, the
 * emptied global scope, frozen intrinsics), never by the gate.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import fc from 'fast-check'
import { afterAll, describe, expect, test } from 'vitest'
import {
  isInside,
  MIGRATION_IMPORT,
  type ReplayManifest,
  resolveMigrationImport,
} from '../../../src/migrations/replay-protocol.ts'
import {
  assertConfined,
  checkResolved,
  lockDown,
  type PermissionProbe,
  parseManifest,
  SAFE_GLOBALS,
  SEALED_PROCESS_METHODS,
  sandboxLoad,
  sandboxResolve,
  sandboxRules,
  schemaEntryUrl,
} from '../../../src/migrations/replay-worker.ts'
import { childArguments, runReplayWorker } from '../../../src/migrations/sandbox.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const NAME = '2026_01_01_000000_create_tags_table.ts'
const HEADER = "import { migration } from '@strutvane/framework/schema'\n"
const VALID = `${HEADER}export default migration({
  up(schema) { schema.create('tags', (t) => { t.id(); t.string('name') }) },
  down(schema) { schema.dropIfExists('tags') },
})
`
const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * An app whose migrations folder holds `files`, with a `"type": "commonjs"` package.json both at
 * the app root and inside the folder. Every `.ts` file listed in `approve` is approved as-is
 * (default: all of them), as if the gate had passed it.
 */
function hostileApp(
  files: Readonly<Record<string, string>>,
  approve: readonly string[] = Object.keys(files).filter((name) => name.endsWith('.ts')),
): ReplayManifest {
  const root = mkdtempSync(join(tmpdir(), 'sv-worker-'))
  dirs.push(root)
  const folder = join(root, 'database', 'migrations')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}')
  writeFileSync(join(folder, 'package.json'), '{"type":"commonjs"}')
  writeFileSync(join(root, 'outside.ts'), 'export const STOLEN = 1\n')
  for (const [name, source] of Object.entries(files)) {
    const path = join(folder, ...name.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  const approved: Record<string, string> = {}
  for (const name of approve) {
    const path = join(folder, ...name.split('/'))
    approved[path] = sha256(path)
  }
  return { folder, entries: [NAME], approved }
}

/** Run probes inside a migration; each answers `YES` when it escaped. Returns name → answer. */
async function probe(probes: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const body = Object.entries(probes)
    .map(
      ([name, code]) =>
        `try { const v = await (async () => (${code}))(); r[${JSON.stringify(name)}] = v === undefined || v === false || v === null ? 'no' : 'YES' } catch { r[${JSON.stringify(name)}] = 'no' }`,
    )
    .join('\n')
  const manifest = hostileApp(
    {
      [NAME]: `${HEADER}const r: Record<string, string> = {}
const g = globalThis as any
${body}
throw new Error('PROBES ' + JSON.stringify(r))
export default migration({ up() {}, down() {} })
`,
      'helpers/ok.ts': 'export const OK = 1\n',
      'helpers/unapproved.ts': 'export const NO = 1\n',
      'helpers/h.cts': 'module.exports = 1\n',
    },
    [NAME, 'helpers/ok.ts'],
  )
  const message = await runReplayWorker(manifest, 20_000)
  if (message.ok) throw new Error('the probe migration was expected to report its results')
  const match = /PROBES (\{.*\})/.exec(message.error.message)
  if (match?.[1] === undefined) throw new Error(`unexpected answer: ${message.error.message}`)
  return JSON.parse(match[1]) as Record<string, string>
}

const allBlocked = (results: Record<string, string>): void => {
  const escaped = Object.entries(results).filter(([, answer]) => answer !== 'no')
  expect(escaped).toEqual([])
}

describe('the child alone (static gate bypassed)', () => {
  test('a valid migration still replays under a "type": "commonjs" package.json (always ESM)', async () => {
    const message = await runReplayWorker(hostileApp({ [NAME]: VALID }), 20_000)
    expect(message).toMatchObject({ ok: true, migrations: [{ name: NAME.slice(0, -3) }] })
  })

  test('CommonJS escapes are gone: no require, module, exports, __dirname or sloppy this', async () => {
    allBlocked(
      await probe({
        require: "typeof require !== 'undefined'",
        module: "typeof module !== 'undefined'",
        exports: "typeof exports !== 'undefined'",
        dirname: "typeof __dirname !== 'undefined'",
        filename: "typeof __filename !== 'undefined'",
        sloppyThis: '(function (this: unknown) { return this })()',
        createRequire: "(g.process ?? {}).getBuiltinModule?.('node:module')",
      }),
    )
  })

  test('the global scope holds only the allowlist; process, Buffer and the network are gone', async () => {
    const results = await probe({
      process: "typeof process !== 'undefined'",
      globalProcess: 'g.process',
      buffer: "typeof Buffer !== 'undefined'",
      fetch: "typeof fetch !== 'undefined'",
      webSocket: "typeof WebSocket !== 'undefined'",
      webAssembly: "typeof WebAssembly !== 'undefined'",
      navigator: 'g.navigator',
      performance: 'g.performance',
      messageChannel: 'g.MessageChannel',
      broadcastChannel: 'g.BroadcastChannel',
      consoleStderr: '(console as any)._stderr ?? (console as any)._stdout',
      consoleStreams: 'Object.getOwnPropertySymbols(console).length > 0',
      extraGlobals: `Reflect.ownKeys(g).filter((k) => typeof k !== 'string' || !${JSON.stringify([...SAFE_GLOBALS])}.includes(k)).length > 0`,
    })
    allBlocked(results)
  })

  test('intrinsics are frozen, __proto__ throws and code generation from strings is off', async () => {
    allBlocked(
      await probe({
        pollute:
          "(Object.defineProperty(Object.prototype, 'pwn', { get() { return 1 }, configurable: true }), true)",
        pollutePromise: '((Promise.prototype as any).then = () => 1, true)',
        prepareStackTrace: '((Error as any).prepareStackTrace = () => 1, true)',
        proto: '({} as any).__proto__',
        construct: "[].constructor.constructor('return globalThis')()",
        indirectEval: "(0, g.eval)('globalThis')",
        asyncConstruct: "(async () => {}).constructor('return 1')",
      }),
    )
  })

  test('every import the parent did not approve is refused, however it is spelled', async () => {
    const outside = pathToFileURL(join(tmpdir(), 'outside.ts')).href
    allBlocked(
      await probe({
        builtin: "import('node:fs')",
        bareBuiltin: "import('fs')",
        net: "import('node:net')",
        childProcess: "import('node:child_process')",
        workers: "import('node:worker_threads')",
        moduleApi: "import('node:module')",
        packageName: "import('@strutvane/framework')",
        packageSubpath: "import('@strutvane/framework/database')",
        packageImports: "import('#internal')",
        dataUrl: "import('data:text/javascript,export default 1')",
        fileUrl: `import(${JSON.stringify(outside)})`,
        parentFolder: "import('../../outside.ts')",
        unapproved: "import('./helpers/unapproved.ts')",
        queryString: "import('./helpers/ok.ts?v=1')",
        fragment: "import('./helpers/ok.ts#x')",
        encodedDots: "import('./helpers/%2e%2e/helpers/unapproved.ts')",
        backslash: "import('.\\\\helpers\\\\unapproved.ts')",
        commonJsHelper: "import('./helpers/h.cts')",
      }),
    )
  })

  test('the approved helper itself does load (the probes above are not blocked by accident)', async () => {
    const results = await probe({ approvedHelper: "import('./helpers/ok.ts')" })
    expect(results).toEqual({ approvedHelper: 'YES' })
  })

  test('a static import of an unapproved file stops the replay', async () => {
    const manifest = hostileApp(
      {
        [NAME]: `${HEADER}import { NO } from './helpers/unapproved.ts'\n${VALID.slice(HEADER.length)}`,
        'helpers/unapproved.ts': 'export const NO = 1\n',
      },
      [NAME],
    )
    const message = await runReplayWorker(manifest, 20_000)
    expect(message).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/may not use/) },
    })
  })

  test('a file that changed after the gate approved it is refused (pinned by SHA-256)', async () => {
    const manifest = hostileApp({ [NAME]: VALID })
    writeFileSync(join(manifest.folder, NAME), `${VALID}\nthrow new Error('swapped in')\n`)
    const message = await runReplayWorker(manifest, 20_000)
    expect(message).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/changed while/) },
    })
  })

  test('memory is capped: a migration that allocates without end crashes the child, not the parent', async () => {
    const manifest = hostileApp({
      [NAME]: `${HEADER}const hog: number[][] = []\nfor (;;) hog.push(new Array(1_000_000).fill(1))\nexport default migration({ up() {}, down() {} })\n`,
    })
    await expect(runReplayWorker(manifest, 60_000)).rejects.toMatchObject({
      code: 'replay_failed',
    })
  })

  test('the child runs with every barrier flag', () => {
    const args = childArguments(
      join(tmpdir(), 'm'),
      join(tmpdir(), 'fw', 'dist', 'replay-worker.mjs'),
    )
    for (const flag of [
      '--permission',
      '--disallow-code-generation-from-strings',
      '--frozen-intrinsics',
      '--disable-proto=throw',
      '--no-addons',
    ])
      expect(args).toContain(flag)
    expect(args.some((arg) => arg.startsWith('--max-old-space-size='))).toBe(true)
    expect(args.filter((arg) => arg.startsWith('--allow-'))).toEqual([
      `--allow-fs-read=${join(tmpdir(), 'm')}`,
      `--allow-fs-read=${join(tmpdir(), 'fw', 'dist')}`,
    ])
  })
})

describe('the worker hooks (unit)', () => {
  const folder = join(tmpdir(), 'app', 'database', 'migrations')
  const migration = join(folder, NAME)
  const helper = join(folder, 'helpers', 'x.ts')
  const hash = 'a'.repeat(64)
  const rules = sandboxRules(
    { folder, entries: [NAME], approved: { [migration]: hash, [helper]: hash } },
    pathToFileURL(join(tmpdir(), 'fw', 'dist', 'replay-worker.mjs')).href,
  )
  const migrationUrl = pathToFileURL(migration).href
  const frameworkUrl = pathToFileURL(join(tmpdir(), 'fw', 'dist', 'schema.mjs')).href

  test('maps the schema entry, allows approved relative files and lets the framework resolve', () => {
    expect(sandboxResolve('@strutvane/framework/schema', migrationUrl, rules)).toEqual({
      url: rules.schemaUrl,
    })
    expect(sandboxResolve('./helpers/x.ts', migrationUrl, rules)).toEqual({
      url: pathToFileURL(helper).href,
    })
    expect(sandboxResolve('node:fs', frameworkUrl, rules)).toBe('next')
  })

  test.each([
    'node:fs',
    'pg',
    './helpers/y.ts',
    '../../../secrets.ts',
    './x.js',
    './helpers/x.ts?v=1',
    './helpers/%78.ts',
  ])('refuses %s from a migration', (specifier) => {
    expect(() => sandboxResolve(specifier, migrationUrl, rules)).toThrow(/may not use/)
  })

  test('refuses imports with no parent, from data: URLs or from unknown files', () => {
    expect(() => sandboxResolve('node:fs', undefined, rules)).toThrow(/may not use/)
    expect(() => sandboxResolve('node:fs', 'data:text/javascript,1', rules)).toThrow(/may not use/)
    expect(() =>
      sandboxResolve('node:fs', pathToFileURL(join(folder, 'helpers', 'y.ts')).href, rules),
    ).toThrow(/may not use/)
  })

  test('checks what the framework resolved: approved URLs exactly, built-ins, framework files', () => {
    expect(() => checkResolved(migrationUrl, rules)).not.toThrow()
    expect(() => checkResolved('node:fs', rules)).not.toThrow()
    expect(() => checkResolved(frameworkUrl, rules)).not.toThrow()
    expect(() => checkResolved(`${migrationUrl}?v=1`, rules)).toThrow(/may not use/)
    expect(() => checkResolved(pathToFileURL(join(folder, 'other.ts')).href, rules)).toThrow()
    expect(() => checkResolved('data:text/javascript,1', rules)).toThrow()
  })

  test('loads approved files only when their bytes match, everything else is next or refused', () => {
    const bytes = new TextEncoder().encode('export const A = 1\n')
    const pinned = sandboxRules(
      {
        folder,
        entries: [NAME],
        approved: { [migration]: createHash('sha256').update(bytes).digest('hex') },
      },
      pathToFileURL(join(tmpdir(), 'fw', 'dist', 'replay-worker.mjs')).href,
    )
    expect(sandboxLoad(migrationUrl, pinned, () => bytes)).toEqual({
      source: 'export const A = 1\n',
    })
    expect(() => sandboxLoad(migrationUrl, pinned, () => new TextEncoder().encode('x'))).toThrow(
      /changed while/,
    )
    expect(sandboxLoad('node:fs', pinned, () => bytes)).toBe('next')
    expect(sandboxLoad(frameworkUrl, pinned, () => bytes)).toBe('next')
    expect(() => sandboxLoad(pathToFileURL(helper).href, pinned, () => bytes)).toThrow()
    expect(() => sandboxLoad('data:text/javascript,1', pinned, () => bytes)).toThrow()
  })

  test('finds the schema entry next to the worker in both layouts', () => {
    expect(schemaEntryUrl('file:///repo/src/migrations/replay-worker.ts')).toBe(
      'file:///repo/src/entries/schema.ts',
    )
    expect(
      schemaEntryUrl('file:///app/node_modules/@strutvane/framework/dist/replay-worker.mjs'),
    ).toBe('file:///app/node_modules/@strutvane/framework/dist/schema.mjs')
  })

  test('parseManifest refuses anything but the expected shape', () => {
    expect(parseManifest('{"folder":"/m","entries":["a.ts"],"approved":{}}')).toEqual({
      folder: '/m',
      entries: ['a.ts'],
      approved: {},
    })
    for (const bad of [
      'null',
      '{"folder":1,"entries":[],"approved":{}}',
      '{"folder":"/m","entries":[1],"approved":{}}',
      '{"folder":"/m","entries":[],"approved":{"/a":"nothex"}}',
      '{"folder":"/m","entries":[],"approved":null}',
    ])
      expect(() => parseManifest(bad)).toThrow(/invalid manifest/)
  })
})

describe('the confinement self-check (fail closed)', () => {
  const rules = {
    migrationsDir: join(tmpdir(), 'app', 'database', 'migrations'),
    frameworkDir: join(tmpdir(), 'fw'),
  }
  const confined = (granted: (scope: string, reference?: string) => boolean): PermissionProbe => ({
    has: granted,
  })
  const onlyFolder = (scope: string, reference?: string): boolean =>
    scope === 'fs.read' && reference !== undefined && isInside(rules.migrationsDir, reference)

  test('passes when only the folder is readable; reports whether the network is denied', () => {
    expect(assertConfined(confined(onlyFolder), rules, new Set())).toEqual({ networkDenied: false })
    expect(assertConfined(confined(onlyFolder), rules, new Set(['--allow-net']))).toEqual({
      networkDenied: true,
    })
  })

  test('refuses to run without the permission model', () => {
    expect(() => assertConfined(undefined, rules, new Set())).toThrow(/permission model is off/)
  })

  test.each([
    ['fs.write', undefined],
    ['child', undefined],
    ['worker', undefined],
    ['addon', undefined],
    ['wasi', undefined],
    ['inspector', undefined],
    ['fs.read', 'outside'],
    ['fs.read', 'parent'],
    ['net', undefined],
  ])('refuses to run when %s %s is allowed', (scope, which) => {
    const probe = confined((s, reference) => {
      if (onlyFolder(s, reference)) return true
      if (s !== scope) return false
      if (which === undefined) return true
      if (reference === undefined) return false
      return which === 'parent'
        ? reference === join(rules.migrationsDir, '..')
        : !isInside(join(rules.migrationsDir, '..'), reference)
    })
    expect(() => assertConfined(probe, rules, new Set(['--allow-net']))).toThrow(/not confined/)
  })

  test('refuses to run when the folder itself is unreadable', () => {
    expect(() =>
      assertConfined(
        confined(() => false),
        rules,
        new Set(),
      ),
    ).toThrow(/unreadable/)
  })
})

describe('lockDown (unit)', () => {
  test('removes every global outside the allowlist, replaces console and seals process', () => {
    const scope: Record<string, unknown> = { Object, JSON, process: {}, Buffer: 1, secret: 2 }
    Object.defineProperty(scope, Symbol('hidden'), { value: 1, configurable: true })
    const proc: Record<string, unknown> = { getBuiltinModule: () => 1 }
    const written: string[] = []
    const removed = lockDown(scope, proc, (text) => written.push(text))
    expect(removed).toEqual(['process', 'Buffer', 'secret'])
    expect(Reflect.ownKeys(scope)).toEqual(['Object', 'JSON', 'console'])
    const console = scope['console'] as { log(...args: unknown[]): void; time(): void }
    console.log('hello', { a: 1 })
    console.time()
    expect(written).toEqual(['hello { a: 1 }\n'])
    expect(Object.isFrozen(console)).toBe(true)
    for (const name of SEALED_PROCESS_METHODS) {
      const sealed = proc[name] as () => unknown
      expect(sealed).toThrow(/may not use/)
    }
  })

  test('fails closed when a global cannot be removed', () => {
    const scope = {}
    Object.defineProperty(scope, 'stuck', { value: 1, configurable: false })
    expect(() => lockDown(scope, {}, () => {})).toThrow(/could not remove the global stuck/)
  })
})

describe('resolveMigrationImport: the one resolver the gate and the hook share', () => {
  const folder = join(tmpdir(), 'app', 'database', 'migrations')
  const importer = join(folder, 'sub', NAME)

  test('agrees with URL resolution for every specifier it accepts, and stays in the folder', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9_.%?#\\:~ -]{1,6}$/)
    const specifier = fc
      .tuple(
        fc.constantFrom('./', '../', '../../', './/', '/', ''),
        fc.array(segment, { maxLength: 3 }),
        segment,
        fc.constantFrom('.ts', '.cts', '.mts', '.js', '', '.ts?x', '.ts#y', '.ts/'),
      )
      .map(([lead, dirs, file, ext]) => `${lead}${[...dirs, file].join('/')}${ext}`)
    fc.assert(
      fc.property(specifier, (spec) => {
        const target = resolveMigrationImport(spec, importer, folder)
        if (target === undefined) return
        expect(MIGRATION_IMPORT.test(spec)).toBe(true)
        expect(isInside(folder, target)).toBe(true)
        const viaUrl = new URL(spec, pathToFileURL(importer)).href
        expect(viaUrl).toBe(pathToFileURL(target).href)
      }),
      { numRuns: 2_000 },
    )
  })

  test.each([
    './a/%2e%2e/x.ts',
    './%2E%2E/x.ts',
    './x.ts?v=1',
    './x.ts#frag',
    '.\\x.ts',
    './x.ts/',
    './a/../x.ts',
    './a/./x.ts',
    './/x.ts',
    './sub./x.ts',
    './x.ts:stream',
    './x.ts.',
    './HELPER~1/x.ts',
    './.hidden/x.ts',
    './x.cts',
    './x.mts',
    './x.js',
    './x',
    '/abs/x.ts',
    'C:/x.ts',
    'file:///x.ts',
    '#imports',
    'node:fs',
    '../../../outside.ts',
    './',
  ])('refuses %s', (specifier) => {
    expect(resolveMigrationImport(specifier, importer, folder)).toBeUndefined()
  })

  test('accepts plain relative paths inside the folder', () => {
    expect(resolveMigrationImport('./helpers/columns.ts', importer, folder)).toBe(
      join(folder, 'sub', 'helpers', 'columns.ts'),
    )
    expect(resolveMigrationImport('../shared/v1.2.ts', importer, folder)).toBe(
      join(folder, 'shared', 'v1.2.ts'),
    )
  })
})
