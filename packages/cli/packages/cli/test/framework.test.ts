import { EnvValidationError, ProviderError, StrutvaneError, ValidationError } from '@strutvane/core'
import { DevkitError } from '@strutvane/devkit'
import { describe, expect, test } from 'vitest'
import { type AnyCommand, commandProblems, defineCommand } from '../src/framework/command.ts'
import { CliError, toFailure } from '../src/framework/errors.ts'
import { EXIT } from '../src/framework/exit-codes.ts'
import { scanCommandLine } from '../src/framework/globals.ts'
import { renderCommandHelp, renderGlobalHelp, renderGroupHelp } from '../src/framework/help.ts'
import {
  createOutput,
  createStyle,
  formatTable,
  shouldUseColor,
  stripAnsi,
} from '../src/framework/output.ts'
import { camelCase, parseCommandLine, usageLine } from '../src/framework/parse.ts'
import {
  createCommandTable,
  editDistance,
  resolveCommand,
  suggest,
} from '../src/framework/router.ts'
import { renderMessages } from '../src/framework/run.ts'

const cmd = (name: string, extra: Partial<AnyCommand> = {}): AnyCommand =>
  defineCommand({ name, description: `${name} command`, run: () => ({}), ...extra }) as AnyCommand

const table = createCommandTable([
  cmd('make:model', { aliases: ['model'] }),
  cmd('make:migration'),
  cmd('migrate'),
  cmd('migrate:status'),
  cmd('migrate:rollback'),
  cmd('models'),
  cmd('auth:user:create'),
  cmd('secret:thing', { hidden: true }),
])

describe('router', () => {
  test('exact colon names and aliases', () => {
    const r = resolveCommand(table, ['make:model', 'Invoice'])
    expect(r).toMatchObject({ kind: 'found', consumed: 1 })
    expect(r.kind === 'found' && r.command.name).toBe('make:model')
    const alias = resolveCommand(table, ['model'])
    expect(alias.kind === 'found' && alias.command.name).toBe('make:model')
  })

  test('the space alias joins up to three words, longest first', () => {
    const two = resolveCommand(table, ['make', 'model', 'Invoice'])
    expect(two).toMatchObject({ kind: 'found', consumed: 2 })
    const three = resolveCommand(table, ['auth', 'user', 'create', '--email'])
    expect(three.kind === 'found' && three.command.name).toBe('auth:user:create')
    expect(resolveCommand(table, ['migrate', 'status'])).toMatchObject({
      kind: 'found',
      consumed: 2,
    })
  })

  test('exact beats prefix: `migrate` is not ambiguous with migrate:status', () => {
    const r = resolveCommand(table, ['migrate'])
    expect(r.kind === 'found' && r.command.name).toBe('migrate')
  })

  test('unique segment prefixes are accepted (sv mi:st → migrate:status)', () => {
    const r = resolveCommand(table, ['mi:st'])
    expect(r.kind === 'found' && r.command.name).toBe('migrate:status')
    const spaced = resolveCommand(table, ['mi', 'ro'])
    expect(spaced.kind === 'found' && spaced.command.name).toBe('migrate:rollback')
  })

  test('ambiguous prefixes list the candidates', () => {
    expect(resolveCommand(table, ['ma:m'])).toEqual({
      kind: 'ambiguous',
      input: 'ma:m',
      matches: ['make:migration', 'make:model'],
    })
  })

  test('a bare namespace resolves to a group listing (hidden commands excluded)', () => {
    const r = resolveCommand(table, ['make'])
    expect(r.kind).toBe('group')
    expect(r.kind === 'group' && r.commands.map((c) => c.name)).toEqual([
      'make:migration',
      'make:model',
    ])
    expect(resolveCommand(table, ['secret']).kind).toBe('unknown')
  })

  test('unknown commands get "did you mean" suggestions', () => {
    const r = resolveCommand(table, ['mgirate'])
    expect(r).toMatchObject({ kind: 'unknown', input: 'mgirate' })
    expect(r.kind === 'unknown' && r.suggestions).toContain('migrate')
    expect(suggest('', ['x'])).toEqual([])
    expect(suggest('xyzzy', ['migrate'])).toEqual([])
  })

  test('editDistance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('same', 'same')).toBe(0)
  })

  test('the first registration of a name wins', () => {
    const t = createCommandTable([
      cmd('a', { description: 'first' }),
      cmd('a', { description: 'second' }),
    ])
    expect(t.get('a')?.description).toBe('first')
    expect(t.commands).toHaveLength(1)
  })
})

describe('scanCommandLine', () => {
  test('collects leading words and output flags anywhere', () => {
    const s = scanCommandLine([
      '--json',
      'make',
      'model',
      'Invoice',
      '--all',
      'x:string',
      '--no-color',
    ])
    expect(s.words).toEqual(['make', 'model', 'Invoice'])
    expect(s.wordIndexes).toEqual([1, 2, 3])
    expect(s.json).toBe(true)
    expect(s.color).toBe(false)
  })

  test('skips the values of global string flags', () => {
    expect(scanCommandLine(['--cwd', 'apps/web', 'routes']).words).toEqual(['routes'])
    expect(scanCommandLine(['--cwd', 'apps/web', 'routes']).cwd).toBe('apps/web')
    expect(scanCommandLine(['--cwd=apps/api', '--env', 'test', 'env:check']).cwd).toBe('apps/api')
    expect(scanCommandLine(['--env=test', 'env:check']).words).toEqual(['env:check'])
  })

  test('help, version, verbosity and the -- terminator', () => {
    const s = scanCommandLine(['-h', '-V', '-v', '-q', '--color', 'x', '--', 'y'])
    expect(s).toMatchObject({ help: true, version: true, verbose: true, quiet: true, color: true })
    expect(s.words).toEqual(['x'])
  })
})

describe('parseCommandLine', () => {
  const command = cmd('make:thing', {
    args: { name: { required: true }, rest: { variadic: true } },
    flags: {
      all: { type: 'boolean' },
      api: { type: 'boolean', default: true },
      seed: { type: 'string', default: '10' },
      tag: { type: 'string', multiple: true },
      template: { type: 'string', choices: ['a', 'b'] },
      model: { type: 'string', short: 'm' },
    },
  })

  test('declared flags, defaults, negation and globals', () => {
    const p = parseCommandLine(command, [
      'Invoice',
      'x:string',
      'y:text',
      '--no-api',
      '--tag',
      'a',
      '--tag',
      'b',
      '-m',
      'M',
      '--json',
      '--dry-run',
      '--yes',
      '--no-interactive',
    ])
    expect(p.args).toEqual({ name: 'Invoice', rest: ['x:string', 'y:text'] })
    expect(p.flags).toEqual({
      all: undefined,
      api: false,
      seed: '10',
      tag: ['a', 'b'],
      template: undefined,
      model: 'M',
    })
    expect(p.globals).toMatchObject({
      json: true,
      dryRun: true,
      yes: true,
      interactive: false,
      color: true,
    })
  })

  test('multiple flags default to an empty list', () => {
    expect(parseCommandLine(command, ['X']).flags['tag']).toEqual([])
  })

  test('usage errors are exit 2 with stable codes', () => {
    const expectCode = (argv: string[], code: string): void => {
      expect(() => parseCommandLine(command, argv)).toThrow(
        expect.objectContaining({ code, exitCode: EXIT.USAGE }),
      )
    }
    expectCode([], 'MISSING_ARGUMENT')
    expectCode(['X', '--nope'], 'UNKNOWN_FLAG')
    expectCode(['X', '--seed'], 'INVALID_FLAG_VALUE')
    expectCode(['X', '--template', 'c'], 'INVALID_CHOICE')
  })

  test('surplus positionals are rejected; required variadic needs one value', () => {
    const one = cmd('one', { args: { a: {} } })
    expect(() => parseCommandLine(one, ['x', 'y'])).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_ARGUMENTS' }),
    )
    expect(parseCommandLine(one, []).args).toEqual({ a: undefined })
    const req = cmd('req', { args: { files: { variadic: true, required: true } } })
    expect(() => parseCommandLine(req, [])).toThrow(
      expect.objectContaining({ code: 'MISSING_ARGUMENT' }),
    )
  })

  test('allowUnknownFlags collects installer answers in camelCase', () => {
    const add = cmd('add', { args: { package: { required: true } }, allowUnknownFlags: true })
    const p = parseCommandLine(add, [
      'auth',
      '--methods',
      'email,google',
      '--no-mfa',
      '--keep-data',
      '--level=2',
      '--dry-run',
    ])
    expect(p.args).toEqual({ package: 'auth' })
    expect(p.extraFlags).toEqual({
      methods: 'email,google',
      mfa: false,
      keepData: true,
      level: '2',
    })
    expect(p.globals.dryRun).toBe(true)
  })

  test('helpers', () => {
    expect(camelCase('keep-data-now')).toBe('keepDataNow')
    expect(usageLine(command)).toBe('sv make:thing <name> [rest...] [flags]')
    expect(usageLine(cmd('about'))).toBe('sv about')
  })
})

describe('output', () => {
  test('color decision: flag > NO_COLOR > FORCE_COLOR > TTY', () => {
    expect(shouldUseColor({ flag: false, env: { FORCE_COLOR: '1' }, isTTY: true })).toBe(false)
    expect(shouldUseColor({ flag: true, env: { NO_COLOR: '1' }, isTTY: false })).toBe(true)
    expect(shouldUseColor({ flag: undefined, env: { NO_COLOR: '1' }, isTTY: true })).toBe(false)
    expect(shouldUseColor({ flag: undefined, env: { NO_COLOR: '' }, isTTY: true })).toBe(true)
    expect(shouldUseColor({ flag: undefined, env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true)
    expect(shouldUseColor({ flag: undefined, env: { FORCE_COLOR: '0' }, isTTY: true })).toBe(false)
    expect(shouldUseColor({ flag: undefined, env: {}, isTTY: false })).toBe(false)
  })

  test('styles wrap only when enabled; stripAnsi undoes them', () => {
    const on = createStyle(true)
    expect(on.red('x')).toBe('\u001b[31mx\u001b[39m')
    expect(stripAnsi(on.bold(on.green('ok')))).toBe('ok')
    expect(createStyle(false).red('x')).toBe('x')
  })

  test('tables align on visible width', () => {
    const style = createStyle(true)
    expect(
      formatTable(
        ['A', 'Bee'],
        [
          [style.red('x'), 'y'],
          ['long', 'z'],
        ],
      ).map(stripAnsi),
    ).toEqual(['A     Bee', 'x     y', 'long  z'])
  })

  test('json mode suppresses human output but keeps warnings; quiet keeps results and warnings', () => {
    let out = ''
    let err = ''
    const streams = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) }
    const json = createOutput({ json: true, color: true, quiet: false, streams })
    json.line('a')
    json.success('b')
    json.info('c')
    json.table(['h'], [['r']])
    json.raw('d')
    json.warn('careful')
    expect(out).toBe('')
    expect(err).toBe('')
    expect(json.warnings).toEqual(['careful'])
    expect(json.style.enabled).toBe(false)

    const quiet = createOutput({ json: false, color: false, quiet: true, streams })
    quiet.line('hidden')
    quiet.info('hidden')
    quiet.success('shown')
    quiet.raw('raw')
    quiet.raw('')
    quiet.warn('w')
    expect(out).toBe('✔ shown\nraw\n')
    expect(err).toBe('warning: w\n')
  })
})

describe('errors', () => {
  test('CliError keeps code, params, exit code, issues and data', () => {
    const e = new CliError('X', {
      exitCode: EXIT.CONFLICT,
      params: { a: 1 },
      issues: [{ path: ['f'], message: 'm' }],
      data: { d: 1 },
    })
    expect(toFailure(e)).toMatchObject({
      code: 'X',
      exitCode: 4,
      params: { a: 1 },
      data: { d: 1 },
      unexpected: false,
    })
    expect(new CliError('Y').exitCode).toBe(EXIT.FAILURE)
  })

  test('an invalid .env is a configuration error (exit 3), not an unexpected one', () => {
    const env = new EnvValidationError([
      { key: 'DATABASE_URL', message: 'Invalid URL' },
      { key: '', message: 'Expected object' },
    ])
    const failure = toFailure(env)
    expect(failure).toMatchObject({
      code: 'ENV_INVALID',
      exitCode: EXIT.VALIDATION,
      params: { count: 2 },
      issues: [
        { path: ['DATABASE_URL'], message: 'Invalid URL' },
        { path: [], message: 'Expected object' },
      ],
      unexpected: false,
    })
    const rendered = renderMessages(failure)
    expect(rendered.message).toBe('Invalid environment: 2 problems.')
    expect(rendered.hint).toContain('Fix: set these keys in your .env file')
    expect(rendered.hint).not.toContain('report the bug')
  })

  test('env errors are matched structurally: another copy of core, or wrapped as a cause', () => {
    // A contributed command may bundle its own core, so instanceof would miss it.
    const foreign = Object.assign(new Error('Invalid environment: 1 problem(s)'), {
      name: 'EnvValidationError',
      problems: [{ key: 'APP_KEY', message: 'Required' }, 'junk', { key: 3 }],
    })
    expect(toFailure(foreign)).toMatchObject({
      code: 'ENV_INVALID',
      exitCode: 3,
      issues: [
        { path: ['APP_KEY'], message: 'Required' },
        { path: [], message: 'Invalid' },
      ],
    })
    // Booting the app wraps provider failures; the cause still decides.
    const wrapped = new ProviderError('app', 'register', foreign)
    expect(toFailure(wrapped)).toMatchObject({ code: 'ENV_INVALID', exitCode: 3 })
    expect(toFailure(new StrutvaneError('BOOT', { cause: wrapped }))).toMatchObject({
      code: 'ENV_INVALID',
    })
    // An explicit CliError keeps its own classification.
    expect(toFailure(new CliError('X', { cause: foreign }))).toMatchObject({ code: 'X' })
  })

  test('a port the server cannot bind is a configuration error naming host, port and the fix', () => {
    // The framework's ServerListenError, matched by code + host + port (it is loaded from the app).
    const listen = (code: string) =>
      Object.assign(new Error('Port 3000 is already in use (127.0.0.1:3000).'), {
        name: 'ServerListenError',
        code,
        host: '127.0.0.1',
        port: 3000,
      })
    const failure = toFailure(listen('PORT_IN_USE'))
    expect(failure).toMatchObject({
      code: 'PORT_IN_USE',
      exitCode: EXIT.VALIDATION,
      params: { host: '127.0.0.1', port: '3000' },
      unexpected: false,
    })
    const rendered = renderMessages(failure)
    expect(rendered.message).toBe('Port 3000 on 127.0.0.1 is already in use.')
    expect(rendered.hint).toContain('APP_PORT')
    expect(rendered.hint).toContain('--port')
    expect(rendered.hint).not.toContain('report the bug')
    for (const code of ['PORT_ACCESS_DENIED', 'ADDRESS_NOT_AVAILABLE']) {
      const f = toFailure(listen(code))
      expect(f.exitCode, code).toBe(EXIT.VALIDATION)
      expect(renderMessages(f).message, code).toContain('127.0.0.1:3000')
    }
    // Missing host/port, or an unrelated code, is not treated as a listen error.
    expect(
      toFailure(Object.assign(new Error('x'), { code: 'PORT_IN_USE', port: 3000 })),
    ).toMatchObject({ unexpected: true })
    expect(
      toFailure(Object.assign(new Error('x'), { code: 'EADDRINUSE', host: 'h', port: 1 })),
    ).toMatchObject({ unexpected: true })
  })

  test('a lookalike without the documented problems list, or a cause cycle, stays unexpected', () => {
    const lookalike = Object.assign(new Error('Invalid environment'), {
      name: 'EnvValidationError',
    })
    expect(toFailure(lookalike)).toMatchObject({ code: 'INTERNAL_ERROR', unexpected: true })
    // Matching is by name and shape, never by message text.
    expect(toFailure(new Error('Invalid environment: 1 problem(s)'))).toMatchObject({
      code: 'INTERNAL_ERROR',
    })
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    Object.assign(a, { cause: b })
    expect(toFailure(a)).toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  test('devkit errors map by code (even from another copy of devkit)', () => {
    expect(toFailure(new DevkitError('FILE_EXISTS', 'a.ts exists'))).toMatchObject({
      code: 'FILE_EXISTS',
      exitCode: 4,
      params: { detail: 'a.ts exists' },
    })
    const foreign = Object.assign(new Error('bad input'), {
      code: 'GENERATOR_INPUT_INVALID',
      issues: [{ path: ['name'], message: 'x' }, { path: 'bad', code: 'c' }, 5],
    })
    expect(toFailure(foreign)).toMatchObject({
      exitCode: 3,
      issues: [
        { path: ['name'], message: 'x' },
        { path: [], code: 'c', message: 'c' },
      ],
    })
  })

  test('core errors', () => {
    const v = toFailure(
      new ValidationError([{ path: ['a'], code: 'required', message: 'A is required.' }]),
    )
    expect(v).toMatchObject({
      code: 'VALIDATION_FAILED',
      exitCode: 3,
      issues: [{ path: ['a'], code: 'required' }],
    })
    expect(toFailure(new StrutvaneError('SOMETHING', { params: { x: 1 } }))).toMatchObject({
      code: 'SOMETHING',
      exitCode: 1,
    })
  })

  test('anything else is an unexpected INTERNAL_ERROR', () => {
    expect(toFailure(new TypeError('boom'))).toMatchObject({
      code: 'INTERNAL_ERROR',
      exitCode: 1,
      unexpected: true,
      params: { detail: 'boom' },
    })
    expect(toFailure('a string')).toMatchObject({ params: { detail: 'a string' } })
    expect(toFailure(Object.assign(new Error('e'), { code: 'ENOENT' }))).toMatchObject({
      code: 'INTERNAL_ERROR',
    })
  })

  test('messages come from the catalog, with hints; unknown codes fall back to the detail', () => {
    expect(
      renderMessages(toFailure(new CliError('UNKNOWN_COMMAND', { params: { name: 'x' } }))),
    ).toEqual({
      message: 'Unknown command "x".',
      hint: 'Run `sv help` to see every command.',
    })
    expect(renderMessages(toFailure(new StrutvaneError('PLUGIN_CODE')))).toEqual({
      message: 'PLUGIN_CODE',
    })
    expect(
      renderMessages(toFailure(new CliError('REGISTRY_ERRORS', { params: { count: 1 } }))).message,
    ).toContain('1 error;')
  })
})

describe('commandProblems (contributed command validation)', () => {
  test('accepts a valid command', () => {
    expect(
      commandProblems(
        cmd('reports:send', {
          flags: { x: { type: 'boolean' } },
          args: { a: {}, b: { variadic: true } },
        }),
      ),
    ).toEqual([])
  })

  test('reports every problem', () => {
    expect(commandProblems(null)).toEqual(['a command must be an object'])
    expect(
      commandProblems({
        name: 'Bad Name',
        description: ' ',
        run: 1,
        flags: { Bad: { type: 'x' } },
        args: { a: { variadic: true }, b: {} },
      }),
    ).toEqual([
      'name "Bad Name" must be colon-separated kebab-case',
      'description must be a non-empty string',
      'run must be a function',
      'flag "Bad" must be kebab-case',
      'flag "Bad" needs type "boolean" or "string"',
      'argument "a" is variadic but not last',
    ])
    expect(commandProblems({ name: 'a', description: 'd', run() {}, flags: 1, args: 2 })).toEqual([
      'flags must be an object',
      'args must be an object',
    ])
  })
})

describe('help', () => {
  const style = createStyle(false)
  test('global help groups commands and lists global flags', () => {
    const text = renderGlobalHelp(table.commands, '1.2.3', style)
    expect(text).toContain('strutvane 1.2.3')
    expect(text).toMatch(/Commands:\n {2}migrate +migrate command/)
    expect(text).toContain('make:')
    expect(text).toContain('--dry-run')
    expect(text).not.toContain('secret:thing')
  })

  test('command help shows usage, arguments, flags, examples and source', () => {
    const command = cmd('make:thing', {
      details: 'Longer text.',
      aliases: ['thing'],
      args: { name: { required: true, description: 'The name' }, opt: {} },
      flags: {
        template: { type: 'string', choices: ['a', 'b'], default: 'a', description: 'Pick' },
        quick: { type: 'boolean', short: 'q' },
      },
      examples: ['sv make:thing X'],
    })
    const text = renderCommandHelp(command, style, 'strutvane-plugin-x')
    expect(text).toContain('Usage: sv make:thing <name> [opt] [flags]')
    expect(text).toContain('Aliases: thing')
    expect(text).toContain('opt   (optional)')
    expect(text).toContain('--template <value>  Pick (one of: a, b; default: a)')
    expect(text).toContain('-q, --quick')
    expect(text).toContain('Provided by strutvane-plugin-x')
    expect(renderGroupHelp('make', [command], style)).toContain('make:thing')
  })
})
