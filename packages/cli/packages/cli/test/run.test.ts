/**
 * The runner end to end (in-process): help, version, resolution errors, the `--json` envelope,
 * exit codes, project detection, contributed commands and the production guard.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { BUILTIN_COMMANDS } from '../src/commands/builtins.ts'
import { defineCommand } from '../src/framework/command.ts'
import { CliError } from '../src/framework/errors.ts'
import { EXIT } from '../src/framework/exit-codes.ts'
import { JSON_SCHEMA_VERSION, runCli } from '../src/framework/run.ts'
import {
  addDependencies,
  cleanupTempDirs,
  cli,
  installFakePackage,
  makeProject,
  tempDir,
} from './helpers.ts'

afterAll(cleanupTempDirs)

/** Shape every `--json` document must have (the documented, stable schema). */
function expectEnvelope(doc: Record<string, unknown>): void {
  expect(Object.keys(doc).sort()).toEqual(
    (doc['ok'] === true
      ? ['command', 'data', 'exitCode', 'ok', 'schemaVersion', 'warnings']
      : ['command', 'data', 'error', 'exitCode', 'ok', 'schemaVersion', 'warnings']
    ).sort(),
  )
  expect(doc['schemaVersion']).toBe(JSON_SCHEMA_VERSION)
  expect(Array.isArray(doc['warnings'])).toBe(true)
  expect(typeof doc['exitCode']).toBe('number')
  if (doc['ok'] !== true) {
    const error = doc['error'] as Record<string, unknown>
    expect(typeof error['code']).toBe('string')
    expect(typeof error['message']).toBe('string')
  }
}

describe('help and version', () => {
  test('`sv` and `sv help` list every built-in command', async () => {
    const root = makeProject()
    for (const argv of [[], ['help'], ['--help']]) {
      const r = await cli(argv, { cwd: root })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('make:model')
      expect(r.stdout).toContain('registry:build')
      expect(r.stdout).toContain('migrate:status')
    }
  })

  test('`sv help <command>` and `sv <command> --help`, also via the space alias', async () => {
    const root = makeProject()
    for (const argv of [
      ['help', 'make:model'],
      ['make', 'model', '--help'],
      ['help', 'ma:mo'],
    ]) {
      const r = await cli(argv, { cwd: root })
      expect(r.code, argv.join(' ')).toBe(0)
      expect(r.stdout).toContain('Usage: sv make:model <name> [fields...] [flags]')
      expect(r.stdout).toContain('--soft-deletes')
    }
  })

  test('help --json describes commands', async () => {
    const r = await cli(['help', '--json'], { cwd: makeProject() })
    const doc = r.json()
    expectEnvelope(doc as unknown as Record<string, unknown>)
    const data = doc.data as { commands: { name: string; source: string }[] }
    expect(data.commands.find((c) => c.name === 'about')?.source).toBe('@strutvane/cli')
    const one = await cli(['help', 'routes', '--json'], { cwd: makeProject() })
    expect((one.json().data as { name: string }).name).toBe('routes')
  })

  test('namespace help: `sv make` and `sv help make`', async () => {
    const root = makeProject()
    for (const argv of [['make'], ['help', 'make']]) {
      const r = await cli(argv, { cwd: root })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('make:resource')
    }
    const json = await cli(['make', '--json'], { cwd: root })
    expect((json.json().data as { group: string }).group).toBe('make')
  })

  test('--version / -V', async () => {
    const r = await cli(['--version'], { cwd: tempDir(), version: '9.9.9' })
    expect(r.stdout).toBe('strutvane 9.9.9\n')
    const j = await cli(['-V', '--json'], { cwd: tempDir(), version: '9.9.9' })
    expect(j.json().data).toEqual({ version: '9.9.9' })
  })
})

describe('resolution errors and exit codes', () => {
  test('unknown command: exit 2 with suggestions', async () => {
    const r = await cli(['mak:modle'], { cwd: makeProject() })
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.stderr).toContain('Unknown command "mak:modle"')
    expect(r.stderr).toContain('Did you mean `sv make:model`?')
    expect(r.stderr).toContain('hint: Run `sv help`')
  })

  test('unknown command in --json: the error envelope on stdout, nothing on stderr', async () => {
    const r = await cli(['nope', '--json'], { cwd: makeProject() })
    expect(r.code).toBe(2)
    expect(r.stderr).toBe('')
    const doc = r.json()
    expectEnvelope(doc as unknown as Record<string, unknown>)
    expect(doc).toMatchObject({
      ok: false,
      command: null,
      exitCode: 2,
      error: { code: 'UNKNOWN_COMMAND' },
    })
    expect((await cli(['help', 'nope'], { cwd: makeProject() })).code).toBe(2)
  })

  test('ambiguous prefix: exit 2', async () => {
    const r = await cli(['make:m', '--json'], { cwd: makeProject() })
    expect(r.code).toBe(2)
    expect(r.json().error?.code).toBe('AMBIGUOUS_COMMAND')
  })

  test('unknown flag and missing argument: exit 2', async () => {
    const root = makeProject()
    expect((await cli(['about', '--bogus'], { cwd: root })).code).toBe(2)
    const missing = await cli(['make:model', '--json'], { cwd: root })
    expect(missing.json().error).toMatchObject({ code: 'MISSING_ARGUMENT' })
    expect(missing.json().command).toBe('make:model')
  })

  test('--cwd that does not exist: exit 2', async () => {
    const r = await cli(['about', '--cwd', 'missing-dir', '--json'], { cwd: tempDir() })
    expect(r.json().error?.code).toBe('CWD_NOT_FOUND')
  })

  test('--cwd runs as if in another directory', async () => {
    const root = makeProject()
    const r = await cli(['about', '--json', '--cwd', root], { cwd: tempDir() })
    expect((r.json().data as { project: { root: string } }).project.root).toBe(root)
  })

  test('project commands outside a project: PROJECT_NOT_FOUND (exit 2)', async () => {
    const r = await cli(['routes', '--json'], { cwd: tempDir() })
    expect(r.code).toBe(2)
    expect(r.json().error?.code).toBe('PROJECT_NOT_FOUND')
  })

  test('a broken package.json is a validation error (exit 3)', async () => {
    const root = makeProject({ 'package.json': '{ not json' })
    const r = await cli(['about', '--json'], { cwd: root })
    expect(r.code).toBe(3)
    expect(r.json().error?.code).toBe('INVALID_PACKAGE_JSON')
  })

  test('unexpected errors: exit 1, stack only with --verbose', async () => {
    const boom = defineCommand({
      name: 'boom',
      description: 'throws',
      requiresProject: false,
      run() {
        throw new TypeError('kaput')
      },
    })
    const r = await cli(['boom'], { cwd: tempDir(), builtins: [boom] })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Unexpected error: kaput')
    expect(r.stderr).not.toContain('at ')
    const v = await cli(['boom', '--verbose'], { cwd: tempDir(), builtins: [boom] })
    expect(v.stderr).toContain('TypeError: kaput')
  })

  test('commands can return data and a non-zero exit code; warnings reach the envelope', async () => {
    const pending = defineCommand({
      name: 'pending',
      description: 'needs attention',
      requiresProject: false,
      run(ctx) {
        ctx.out.warn('heads up')
        return { data: { n: 1 }, exitCode: EXIT.PENDING }
      },
    })
    const r = await cli(['pending', '--json'], { cwd: tempDir(), builtins: [pending] })
    expect(r.code).toBe(6)
    expect(r.json()).toMatchObject({
      ok: false,
      exitCode: 6,
      data: { n: 1 },
      warnings: ['heads up'],
    })
    const human = await cli(['pending'], { cwd: tempDir(), builtins: [pending] })
    expect(human.stderr).toContain('warning: heads up')
  })

  test('commands returning nothing produce data: null', async () => {
    const quiet = defineCommand({
      name: 'quiet',
      description: 'q',
      requiresProject: false,
      run() {},
    })
    const r = await cli(['quiet', '--json'], { cwd: tempDir(), builtins: [quiet] })
    expect(r.json()).toMatchObject({ ok: true, data: null, command: 'quiet' })
  })

  test('requireProject() inside a project-less command', async () => {
    const needs = defineCommand({
      name: 'needs',
      description: 'n',
      requiresProject: false,
      run(ctx) {
        return { data: ctx.requireProject().root }
      },
    })
    expect((await cli(['needs', '--json'], { cwd: tempDir(), builtins: [needs] })).code).toBe(2)
    const root = makeProject()
    expect((await cli(['needs', '--json'], { cwd: root, builtins: [needs] })).json().data).toBe(
      root,
    )
  })

  test('issues are listed in human output', async () => {
    const bad = defineCommand({
      name: 'bad',
      description: 'b',
      requiresProject: false,
      run() {
        throw new CliError('VALIDATION_FAILED', {
          exitCode: EXIT.VALIDATION,
          issues: [
            { path: ['a', 0], message: 'is wrong' },
            { path: [], message: 'general' },
          ],
        })
      },
    })
    const r = await cli(['bad'], { cwd: tempDir(), builtins: [bad] })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('  - a.0: is wrong')
    expect(r.stderr).toContain('  - general')
  })
})

describe('prompting rules', () => {
  const asks = defineCommand({
    name: 'asks',
    description: 'asks a question',
    requiresProject: false,
    async run(ctx) {
      return {
        data: { interactive: ctx.prompt.interactive, answer: await ctx.prompt.confirm('Proceed?') },
      }
    },
  })

  test('not a TTY: never prompts; a question without default fails with INPUT_REQUIRED (exit 2)', async () => {
    const r = await cli(['asks', '--json'], { cwd: tempDir(), builtins: [asks] })
    expect(r.code).toBe(2)
    expect(r.json().error?.code).toBe('INPUT_REQUIRED')
  })

  test('--yes accepts', async () => {
    const r = await cli(['asks', '--json', '--yes'], { cwd: tempDir(), builtins: [asks] })
    expect(r.json().data).toEqual({ interactive: false, answer: true })
  })

  test('--json and --no-interactive disable prompting even on a TTY', async () => {
    for (const flag of ['--json', '--no-interactive']) {
      const r = await cli(['asks', flag, '--yes'], {
        cwd: tempDir(),
        builtins: [asks],
        isTTY: true,
      })
      expect(r.code).toBe(0)
    }
  })
})

describe('contributed commands (strutvane.commands)', () => {
  const pluginCommands = `
export default [
  {
    name: 'reports:send',
    description: 'Send monthly reports',
    args: { month: { required: true } },
    flags: { loud: { type: 'boolean' } },
    run(ctx) {
      ctx.out.success('sent ' + ctx.args.month)
      return { data: { month: ctx.args.month, loud: ctx.flags.loud === true } }
    },
  },
  { name: 'about', description: 'hijack attempt', run() { return { data: 'hijacked' } } },
  { name: 'Bad Name', description: 'x', run() {} },
]
`

  function projectWithPlugin(): string {
    const root = makeProject()
    addDependencies(root, { 'strutvane-plugin-reports': '1.0.0', lodash: '1.0.0' })
    installFakePackage(root, 'strutvane-plugin-reports', {
      strutvane: { commands: './commands.mjs', compat: '*' },
      files: { 'commands.mjs': pluginCommands },
    })
    installFakePackage(root, 'lodash', {
      strutvane: { commands: './evil.mjs' },
      files: { 'evil.mjs': 'throw new Error("never loaded")' },
    })
    return root
  }

  test('runs a plugin command with parsing and the JSON envelope', async () => {
    const root = projectWithPlugin()
    const r = await cli(['reports:send', '2026-10', '--loud', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.json().data).toEqual({ month: '2026-10', loud: true })
    const spaced = await cli(['reports', 'send', '2026-11'], { cwd: root })
    expect(spaced.stdout).toContain('sent 2026-11')
  })

  test('plugins cannot replace built-ins; invalid commands are skipped; non-plugin deps are never loaded', async () => {
    const root = projectWithPlugin()
    const about = await cli(['about', '--json'], { cwd: root })
    expect(about.json().data).not.toBe('hijacked')
    const help = await cli(['help', '--json'], { cwd: root })
    const commands = (help.json().data as { commands: { name: string; source: string }[] }).commands
    expect(commands.find((c) => c.name === 'reports:send')?.source).toBe('strutvane-plugin-reports')
    expect(help.json().warnings.join('\n')).toContain('also defines "about"')
  })

  test('incompatible plugins are refused (exit 7 when their command is requested)', async () => {
    const root = makeProject()
    addDependencies(root, { '@acme/strutvane-plugin-old': '1.0.0' })
    installFakePackage(root, '@acme/strutvane-plugin-old', {
      version: '1.0.0',
      strutvane: { commands: './c.mjs', compat: '^9.0.0' },
      files: { 'c.mjs': 'throw new Error("must not run")' },
    })
    const r = await cli(['old:thing', '--json'], { cwd: root, version: '0.1.0' })
    expect(r.code).toBe(EXIT.INCOMPATIBLE)
    expect(r.json().error).toMatchObject({ code: 'INCOMPATIBLE_PLUGINS' })
    expect(r.json().error?.message).toContain('@acme/strutvane-plugin-old (needs ^9.0.0)')
  })

  test('a plugin pointing outside its package is refused, never imported', async () => {
    const root = makeProject({ 'outside.mjs': 'globalThis.__pwned = true; export default []' })
    addDependencies(root, { 'strutvane-plugin-evil': '1.0.0' })
    installFakePackage(root, 'strutvane-plugin-evil', {
      strutvane: { commands: '../../outside.mjs' },
    })
    const r = await cli(['doctor', '--json'], { cwd: root })
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
    const checks = (r.json().data as { checks: { id: string; message: string }[] }).checks
    expect(checks.find((c) => c.id === 'plugins')?.message).toContain(
      'resolves outside its package',
    )
  })

  test('a plugin command failing on an invalid .env reports a configuration error', async () => {
    const root = makeProject()
    addDependencies(root, { 'strutvane-plugin-envy': '1.0.0' })
    // Shaped like core's EnvValidationError from a bundled copy of core (not this CLI's class).
    const commands = `
export default [{
  name: 'envy:run',
  description: 'Needs a valid env',
  run() {
    const error = new Error('Invalid environment: 2 problem(s)')
    error.name = 'EnvValidationError'
    error.problems = [
      { key: 'APP_KEY', message: 'Required' },
      { key: 'DATABASE_URL', message: 'Invalid URL' },
    ]
    throw error
  },
}]
`
    installFakePackage(root, 'strutvane-plugin-envy', {
      strutvane: { commands: './c.mjs', compat: '*' },
      files: { 'c.mjs': commands },
    })
    const text = await cli(['envy:run'], { cwd: root })
    expect(text.code).toBe(EXIT.VALIDATION)
    expect(text.stderr).toContain('Invalid environment: 2 problems.')
    expect(text.stderr).toContain('  - APP_KEY: Required')
    expect(text.stderr).toContain('  - DATABASE_URL: Invalid URL')
    expect(text.stderr).toContain('Fix: set these keys in your .env file')
    expect(text.stderr).not.toContain('Unexpected error')
    expect(text.stderr).not.toContain('report the bug')
    const json = await cli(['envy:run', '--json'], { cwd: root })
    expect(json.code).toBe(EXIT.VALIDATION)
    expect(json.json().error).toMatchObject({
      code: 'ENV_INVALID',
      issues: [
        { path: ['APP_KEY'], message: 'Required' },
        { path: ['DATABASE_URL'], message: 'Invalid URL' },
      ],
    })
  })

  test('a plugin that throws on import does not break other commands', async () => {
    const root = makeProject()
    addDependencies(root, { 'strutvane-plugin-broken': '1.0.0' })
    installFakePackage(root, 'strutvane-plugin-broken', {
      strutvane: { commands: './c.mjs', compat: '*' },
      files: { 'c.mjs': 'throw new Error("broken plugin")' },
    })
    expect((await cli(['help'], { cwd: root })).code).toBe(0)
    expect((await cli(['nope', '--json'], { cwd: root })).json().error?.code).toBe(
      'UNKNOWN_COMMAND',
    )
  })
})

describe('framework placeholders and delegation', () => {
  test('without the framework: FRAMEWORK_REQUIRED with an install hint', async () => {
    const r = await cli(['migrate'], { cwd: makeProject() })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('provided by @strutvane/framework')
    expect(r.stderr).toContain('sv add framework')
  })

  test('framework installed but not providing the command: FRAMEWORK_COMMAND_MISSING', async () => {
    const root = makeProject()
    installFakePackage(root, '@strutvane/framework')
    const r = await cli(['db:seed', '--json'], { cwd: root })
    expect(r.json().error?.code).toBe('FRAMEWORK_COMMAND_MISSING')
  })

  test('the fake framework module replaces placeholders and receives flags', async () => {
    const root = makeProject()
    addDependencies(root, { '@strutvane/framework': '0.1.0' })
    installFakePackage(root, '@strutvane/framework', {
      strutvane: { commands: './cli.mjs' },
      files: {
        'cli.mjs': `
export const commands = [
  { name: 'migrate', description: 'real migrate', flags: { check: { type: 'boolean' } },
    run(ctx) { return ctx.flags.check ? { data: { pending: 2 }, exitCode: 6 } : { data: { applied: 3 } } } },
  { name: 'migrate:fresh', description: 'real fresh', run() { return { data: { fresh: true } } } },
  { name: 'db:fail', description: 'db error', run() { const e = new Error('connection refused'); throw e } },
]`,
      },
    })
    const env = { APP_ENV: 'local' }
    expect((await cli(['migrate', '--json'], { cwd: root, env })).json().data).toEqual({
      applied: 3,
    })
    const check = await cli(['migrate', '--check', '--json'], { cwd: root, env })
    expect(check.code).toBe(EXIT.PENDING)
    // Prefixes reach contributed commands too, except destructive ones (exact name only).
    expect((await cli(['mi:st', '--json'], { cwd: root, env })).json().command).toBe(
      'migrate:status',
    )
    const prefixed = await cli(['mi:fr', '--json'], { cwd: root, env })
    expect(prefixed.json().error?.code).toBe('UNKNOWN_COMMAND')
    expect(prefixed.json().error?.issues?.[0]?.message).toBe('migrate:fresh')
    expect((await cli(['migrate', 'fr', '--json'], { cwd: root, env })).code).toBe(EXIT.USAGE)
    expect((await cli(['migrate:fresh', '--json'], { cwd: root, env })).json().data).toEqual({
      fresh: true,
    })
    expect((await cli(['migrate', 'fresh', '--json'], { cwd: root, env })).json().data).toEqual({
      fresh: true,
    })
    expect((await cli(['help', '--json'], { cwd: root, env })).json().warnings).toEqual([])
  })

  test('production guard: destructive commands need --force --i-understand', async () => {
    const root = makeProject({ '.env': 'APP_ENV=production\n' })
    addDependencies(root, { '@strutvane/framework': '0.1.0' })
    installFakePackage(root, '@strutvane/framework', {
      strutvane: { commands: './cli.mjs' },
      files: {
        'cli.mjs':
          "export default { name: 'migrate:fresh', description: 'fresh', run() { return { data: 'dropped' } } }",
      },
    })
    const refused = await cli(['migrate:fresh', '--json'], { cwd: root })
    expect(refused.code).toBe(2)
    expect(refused.json().error?.code).toBe('PRODUCTION_GUARD')
    expect((await cli(['migrate:fresh', '--force', '--json'], { cwd: root })).code).toBe(2)
    const ok = await cli(['migrate:fresh', '--force', '--i-understand', '--json'], { cwd: root })
    expect(ok.json().data).toBe('dropped')
    // The process environment wins over .env.
    const local = await cli(['migrate:fresh', '--json'], { cwd: root, env: { APP_ENV: 'local' } })
    expect(local.json().data).toBe('dropped')
  })

  /** A project whose framework contributes a destructive command that reports what it saw. */
  function guardedProject(files: Readonly<Record<string, string>>): string {
    const root = makeProject(files)
    addDependencies(root, { '@strutvane/framework': '0.1.0' })
    installFakePackage(root, '@strutvane/framework', {
      strutvane: { commands: './cli.mjs' },
      files: {
        'cli.mjs': `export default { name: 'db:wipe', description: 'wipe', run(ctx) {
  return { data: { appEnv: ctx.appEnv ?? null, seen: ctx.services.env.APP_ENV ?? null, db: ctx.services.env.DATABASE_URL ?? null } } } }`,
      },
    })
    return root
  }

  test.each([
    [
      '--env production with .env.production',
      { '.env': 'APP_ENV=local\n', '.env.production': 'APP_ENV=production\n' },
      {},
      ['--env', 'production'],
    ],
    [
      'empty APP_ENV in the shell falls through to .env',
      { '.env': 'APP_ENV=production\n' },
      { APP_ENV: '' },
      [],
    ],
    [
      'whitespace-only APP_ENV in the shell',
      { '.env': 'APP_ENV=production\n' },
      { APP_ENV: '   ' },
      [],
    ],
    ['quoted value', { '.env': 'APP_ENV="production"\n' }, {}, []],
    ['single-quoted value', { '.env': "APP_ENV='production'\n" }, {}, []],
    ['export prefix', { '.env': 'export APP_ENV=production\n' }, {}, []],
    ['mixed case', { '.env': 'APP_ENV=Production\n' }, {}, []],
    ['padded value', { '.env': 'APP_ENV=  production  \n' }, {}, []],
    ['padded quoted mixed case', { '.env': 'export APP_ENV=" PRODUCTION "\n' }, {}, []],
    ['staging (not a safe environment)', { '.env': 'APP_ENV=staging\n' }, {}, []],
    ['no .env at all', {}, {}, []],
    ['.env without APP_ENV', { '.env': 'APP_NAME=x\n' }, {}, []],
    ['empty APP_ENV everywhere', { '.env': 'APP_ENV=\n' }, { APP_ENV: '' }, []],
    [
      'shell production beats a local .env',
      { '.env': 'APP_ENV=local\n' },
      { APP_ENV: 'production' },
      [],
    ],
    [
      '--env name whose file is missing falls back to .env',
      { '.env': 'APP_ENV=production\n' },
      {},
      ['--env', 'ci'],
    ],
  ] as const)('production guard refuses: %s', async (_, files, env, extra) => {
    const root = guardedProject(files)
    const refused = await cli(['db:wipe', ...extra, '--json'], { cwd: root, env })
    expect(refused.code).toBe(EXIT.USAGE)
    expect(refused.json().error?.code).toBe('PRODUCTION_GUARD')
    expect((await cli(['db:wipe', ...extra, '--force', '--json'], { cwd: root, env })).code).toBe(
      EXIT.USAGE,
    )
    expect(
      (await cli(['db:wipe', ...extra, '--i-understand', '--json'], { cwd: root, env })).code,
    ).toBe(EXIT.USAGE)
    const forced = await cli(['db:wipe', ...extra, '--force', '--i-understand', '--json'], {
      cwd: root,
      env,
    })
    expect(forced.code).toBe(0)
  })

  test.each([
    ['local', { '.env': 'APP_ENV=local\n' }, {}, [], 'local'],
    [
      'test via --env',
      { '.env': 'APP_ENV=production\n', '.env.test': 'APP_ENV=Test\n' },
      {},
      ['--env', 'test'],
      'test',
    ],
    ['testing', { '.env': 'APP_ENV=" testing "\n' }, {}, [], 'testing'],
    [
      'development from the shell',
      { '.env': 'APP_ENV=production\n' },
      { APP_ENV: ' Development' },
      [],
      'development',
    ],
  ] as const)(
    'production guard allows %s, and the command sees the same value',
    async (_, files, env, extra, expected) => {
      const root = guardedProject(files)
      const r = await cli(['db:wipe', ...extra, '--json'], { cwd: root, env })
      expect(r.code).toBe(0)
      expect(r.json().data).toMatchObject({ appEnv: expected, seen: expected })
    },
  )

  test('--env layers .env.<name> into the command environment; the shell still wins', async () => {
    const root = guardedProject({
      '.env': 'APP_ENV=local\nDATABASE_URL=postgres://dev\n',
      '.env.test': 'APP_ENV=test\nDATABASE_URL=postgres://test\n__proto__=x\n',
    })
    const r = await cli(['db:wipe', '--env', 'test', '--json'], { cwd: root })
    expect(r.json().data).toEqual({ appEnv: 'test', seen: 'test', db: 'postgres://test' })
    const shell = await cli(['db:wipe', '--env', 'test', '--json'], {
      cwd: root,
      env: { DATABASE_URL: 'postgres://shell' },
    })
    expect(shell.json().data).toMatchObject({ db: 'postgres://shell' })
    const bad = await cli(['db:wipe', '--env', '../x', '--json'], { cwd: root })
    expect(bad.json().error?.code).toBe('INVALID_ARGUMENT')
  })

  test('the guard message names the resolved value and its source, without control characters', async () => {
    const root = guardedProject({ '.env.ci': 'APP_ENV="prod\u001b[2Juction"\n' })
    const r = await cli(['db:wipe', '--env', 'ci'], { cwd: root })
    expect(r.stderr).toContain('APP_ENV is "prod[2juction" (from .env.ci)')
    expect(r.stderr.includes('\u001b')).toBe(false)
    const unset = await cli(['db:wipe'], { cwd: guardedProject({}) })
    expect(unset.stderr).toContain('APP_ENV is not set')
    const shell = await cli(['db:wipe'], { cwd: guardedProject({}), env: { APP_ENV: 'prod' } })
    expect(shell.stderr).toContain('"prod" (from the environment)')
  })

  test('runCli hands the resolved variables to applyEnv (main writes them to process.env)', async () => {
    const root = guardedProject({ '.env': 'APP_ENV=Local\n', '.env.test': 'EXTRA=1\n' })
    const applied: Record<string, string>[] = []
    const code = await runCli({
      argv: ['db:wipe', '--env', 'test', '--quiet'],
      cwd: root,
      builtins: BUILTIN_COMMANDS,
      streams: { stdout: () => {}, stderr: () => {} },
      services: { env: {}, isTTY: false },
      applyEnv: (vars) => applied.push(Object.fromEntries(vars)),
    })
    expect(code).toBe(0)
    expect(applied).toEqual([{ EXTRA: '1', APP_ENV: 'local' }])
  })

  test('destructive commands are refused without a project too (fail closed)', async () => {
    const guarded = defineCommand({
      name: 'danger:zone',
      description: 'd',
      destructive: true,
      requiresProject: false,
      run: () => ({ data: 'ran' }),
    })
    const dir = tempDir()
    const builtins = [...BUILTIN_COMMANDS, guarded]
    expect((await cli(['danger:zone', '--json'], { cwd: dir, builtins })).code).toBe(EXIT.USAGE)
    const ok = await cli(['danger:zone', '--json'], {
      cwd: dir,
      builtins,
      env: { APP_ENV: 'test' },
    })
    expect(ok.json().data).toBe('ran')
    // Destructive built-ins also need their exact name.
    expect((await cli(['danger:z', '--json'], { cwd: dir, builtins })).json().error?.code).toBe(
      'UNKNOWN_COMMAND',
    )
  })
})
