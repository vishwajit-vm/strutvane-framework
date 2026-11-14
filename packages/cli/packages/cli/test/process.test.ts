/**
 * Process-level behaviour: the real bin as a child process (exit codes, `--json`), `main()`
 * with Ctrl+C, the real spawner (Windows shell rules), prompters, contribution containment and
 * Windows path handling.
 */
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { defineCommand } from '../src/framework/command.ts'
import { EXIT } from '../src/framework/exit-codes.ts'
import {
  type ClackApi,
  createInteractivePrompter,
  createNonInteractivePrompter,
} from '../src/framework/prompter.ts'
import { runCli } from '../src/framework/run.ts'
import {
  childEnvironment,
  createNodeServices,
  createNodeSpawner,
  exitCodeForSignal,
  needsShell,
  resolveWindowsCommand,
} from '../src/framework/services.ts'
import { main } from '../src/main.ts'
import {
  type BoundaryFacts,
  declaresCli,
  isForbiddenProjectDir,
  isOwnedByCurrentUser,
  processBoundary,
  readManifest,
} from '../src/project/boundary.ts'
import { isInNodeModules, isInside, resolveContribution } from '../src/project/contributions.ts'
import {
  expandPackageName,
  findProjectRoot,
  isContributorName,
  isValidPackageName,
  packageManagerCommand,
  readInstalledPackage,
} from '../src/project/project.ts'
import { cleanupTempDirs, cli, installFakePackage, makeProject, tempDir, write } from './helpers.ts'

afterAll(cleanupTempDirs)

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

describe('the real executable (child process)', () => {
  const run = (cwd: string, args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    })

  test('--version, --json envelope on stdout, exit codes', () => {
    const root = makeProject()
    const version = run(root, ['--version'])
    expect(version.status).toBe(0)
    expect(version.stdout).toMatch(/^strutvane \d+\.\d+\.\d+/)

    const about = run(root, ['about', '--json'])
    expect(about.status).toBe(0)
    expect(JSON.parse(about.stdout)).toMatchObject({ schemaVersion: 1, ok: true, command: 'about' })

    const unknown = run(root, ['nope', '--json'])
    expect(unknown.status).toBe(2)
    expect(JSON.parse(unknown.stdout).error.code).toBe('UNKNOWN_COMMAND')

    const generated = run(root, ['make:model', 'Tag', 'name:string', '--no-test'])
    expect(generated.status).toBe(0)
    expect(run(root, ['make:model', 'Tag', 'name:text']).status).toBe(4)
  })
})

describe('main()', () => {
  test('runs with the built-in commands and returns the exit code', async () => {
    let out = ''
    const code = await main(['--version'], {
      streams: { stdout: (t) => (out += t), stderr: () => {} },
    })
    expect(code).toBe(0)
    expect(out).toMatch(/^strutvane /)
  })

  test('Ctrl+C aborts long-running commands and reports 130', async () => {
    const target = new EventEmitter() as unknown as NodeJS.Process
    const root = makeProject()
    const running = main(['registry:watch'], {
      cwd: root,
      signalTarget: target,
      streams: { stdout: () => {}, stderr: () => {} },
      services: { isTTY: false, env: {} },
    })
    await new Promise((r) => setTimeout(r, 100))
    target.emit('SIGINT')
    expect(await running).toBe(EXIT.INTERRUPTED)
    expect((target as unknown as EventEmitter).listenerCount('SIGINT')).toBe(0)
  })

  test('a second Ctrl+C exits immediately', async () => {
    const target = new EventEmitter() as unknown as NodeJS.Process
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const root = makeProject()
    const running = main(['registry:watch'], {
      cwd: root,
      signalTarget: target,
      streams: { stdout: () => {}, stderr: () => {} },
      services: { env: {} },
    })
    await new Promise((r) => setTimeout(r, 50))
    target.emit('SIGINT')
    target.emit('SIGINT')
    expect(exit).toHaveBeenCalledWith(130)
    await running
  })

  test('runCli defaults to the process streams and cwd without throwing', async () => {
    const quiet = defineCommand({
      name: 'noop',
      description: 'n',
      requiresProject: false,
      run: () => ({}),
    })
    expect(await runCli({ argv: ['noop', '--quiet'], builtins: [quiet] })).toBe(0)
  })
})

describe('spawning', () => {
  test('needsShell: only for non-.exe commands on Windows', () => {
    expect(needsShell('pnpm', 'win32', 'C:\\node.exe')).toBe(true)
    expect(needsShell('C:\\node.exe', 'win32', 'C:\\node.exe')).toBe(false)
    expect(needsShell('git.EXE', 'win32', 'C:\\node.exe')).toBe(false)
    expect(needsShell('pnpm', 'linux', '/usr/bin/node')).toBe(false)
  })

  test('the Windows shell path refuses arguments with shell metacharacters', async () => {
    const bin = tempDir()
    write(bin, 'pnpm.cmd', '@exit /b 0')
    const spawn = createNodeSpawner('win32', process.execPath, { PATH: bin, PATHEXT: '.CMD' })
    for (const value of ['a&b', 'x|y', '%PATH%', 'a b', '"q"', '^', '<x>']) {
      await expect(spawn('pnpm', ['add', value], { cwd: tempDir() })).rejects.toMatchObject({
        exitCode: process.platform === 'win32' ? 2 : 1,
      })
    }
  })

  test('Windows: programs are resolved from PATH, never from the working directory', async () => {
    const files = new Set(['C:\\app\\pnpm.cmd', 'C:\\tools\\pnpm.cmd', 'C:\\tools\\git.exe'])
    const exists = (p: string): boolean => files.has(p)
    const env = { PATH: ';.;C:\\APP;relative;"C:\\tools"', PATHEXT: '.EXE;.CMD' }
    expect(resolveWindowsCommand('pnpm', env, 'C:\\app', exists)).toBe('C:\\tools\\pnpm.cmd')
    expect(resolveWindowsCommand('pnpm.cmd', env, 'C:\\app', exists)).toBe('C:\\tools\\pnpm.cmd')
    expect(resolveWindowsCommand('git', env, 'C:\\app', exists)).toBe('C:\\tools\\git.exe')
    expect(resolveWindowsCommand('pnpm', { Path: 'C:\\app' }, 'C:\\app', exists)).toBeUndefined()
    expect(resolveWindowsCommand('.\\pnpm', env, 'C:\\app', exists)).toBeUndefined()
    expect(resolveWindowsCommand('C:\\x\\y.exe', env, 'C:\\app', exists)).toBe('C:\\x\\y.exe')
    expect(resolveWindowsCommand('pnpm', {}, 'C:\\app', exists)).toBeUndefined()
    expect(childEnvironment('win32', { A: '1' }, { B: '2' })).toEqual({
      A: '1',
      B: '2',
      NoDefaultCurrentDirectoryInExePath: '1',
    })
    expect(childEnvironment('linux', { A: '1' })).toEqual({ A: '1' })
    expect(needsShell('C:\\tools\\git.exe', 'win32', 'node')).toBe(false)
    const spawn = createNodeSpawner('win32', process.execPath, { PATH: '' })
    await expect(spawn('pnpm', ['install'], { cwd: tempDir() })).rejects.toMatchObject({
      code: 'COMMAND_NOT_FOUND',
    })
  })

  test.skipIf(process.platform !== 'win32')(
    'Windows: a planted pnpm.cmd in the project never runs; the PATH one does',
    async () => {
      const project = tempDir()
      write(project, 'pnpm.cmd', '@echo planted& exit /b 7')
      const bin = tempDir()
      write(bin, 'pnpm.cmd', '@echo real %NoDefaultCurrentDirectoryInExePath%& exit /b 0')
      const spawn = createNodeSpawner('win32', process.execPath, {
        ...process.env,
        PATH: `${project};${bin};${process.env['PATH'] ?? ''}`,
        PATHEXT: '.CMD;.EXE',
      })
      const result = await spawn('pnpm', ['add', 'zod'], { cwd: project })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('real 1')
      expect(result.stdout).not.toContain('planted')
    },
  )

  test('the real spawner captures output and exit codes (no shell)', async () => {
    const spawn = createNodeSpawner()
    const ok = await spawn(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      { cwd: process.cwd() },
    )
    expect(ok).toEqual({ code: 0, stdout: 'out', stderr: 'err' })
    const failing = await spawn(process.execPath, ['-e', 'process.exit(3)'], {
      cwd: process.cwd(),
      env: { X: '1' },
    })
    expect(failing.code).toBe(3)
    const inherit = await spawn(process.execPath, ['-e', ''], {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
    expect(inherit.code).toBe(0)
    await expect(
      spawn(join(tempDir(), 'missing-exe.exe'), [], { cwd: process.cwd() }),
    ).rejects.toThrow()
  })

  test('exitCodeForSignal', () => {
    expect(exitCodeForSignal('SIGINT')).toBe(130)
    expect(exitCodeForSignal('SIGTERM')).toBe(143)
    expect(exitCodeForSignal('SIGWEIRD')).toBe(129)
    expect(exitCodeForSignal(null)).toBe(1)
  })

  test('node services reflect the process', () => {
    const services = createNodeServices(new AbortController().signal)
    expect(services.platform).toBe(process.platform)
    expect(services.execPath).toBe(process.execPath)
    expect(typeof services.clock.now()).toBe('number')
  })

  test('package manager command lines', () => {
    expect(packageManagerCommand('pnpm', 'add', ['a'], { dev: true })).toEqual({
      command: 'pnpm',
      args: ['add', '--save-dev', 'a'],
    })
    expect(packageManagerCommand('npm', 'add', ['a'], { dev: true })).toEqual({
      command: 'npm',
      args: ['install', '--save-dev', 'a'],
    })
    expect(packageManagerCommand('npm', 'remove', ['a'])).toEqual({
      command: 'npm',
      args: ['uninstall', 'a'],
    })
    expect(packageManagerCommand('yarn', 'add', ['a'], { dev: true })).toEqual({
      command: 'yarn',
      args: ['add', '--dev', 'a'],
    })
    expect(packageManagerCommand('bun', 'remove', ['a'])).toEqual({
      command: 'bun',
      args: ['remove', 'a'],
    })
    expect(packageManagerCommand('bun', 'add', ['a'], { dev: true }).args).toEqual([
      'add',
      '--dev',
      'a',
    ])
  })
})

describe('prompters', () => {
  test('non-interactive: defaults, --yes, INPUT_REQUIRED', async () => {
    const strict = createNonInteractivePrompter({ yes: false })
    expect(strict.interactive).toBe(false)
    await expect(strict.confirm('Go?')).rejects.toMatchObject({
      code: 'INPUT_REQUIRED',
      exitCode: 2,
    })
    expect(await strict.confirm('Go?', { default: false })).toBe(false)
    expect(await strict.text('Name?', { default: 'x' })).toBe('x')
    await expect(strict.text('Name?')).rejects.toMatchObject({ code: 'INPUT_REQUIRED' })
    expect(await strict.select('Pick', [{ value: 'a' }], { default: 'a' })).toBe('a')
    await expect(strict.select('Pick', [{ value: 'a' }])).rejects.toMatchObject({
      code: 'INPUT_REQUIRED',
    })
    expect(
      await createNonInteractivePrompter({ yes: true }).confirm('Go?', { default: false }),
    ).toBe(true)
  })

  test('interactive (clack): passes options through and maps cancel to exit 130', async () => {
    const CANCEL = Symbol('cancel')
    const seen: unknown[] = []
    const api = {
      confirm: async (o: unknown) => {
        seen.push(o)
        return true
      },
      text: async (o: { validate?: (v: string | undefined) => string | undefined }) => {
        seen.push(o)
        return o.validate?.(undefined) ?? 'typed'
      },
      select: async (o: unknown) => {
        seen.push(o)
        return 'b'
      },
      isCancel: (v: unknown): v is symbol => v === CANCEL,
    } as unknown as ClackApi
    const prompter = createInteractivePrompter(api)
    expect(prompter.interactive).toBe(true)
    expect(await prompter.confirm('Go?', { default: true })).toBe(true)
    expect(await prompter.confirm('Go?')).toBe(true)
    expect(
      await prompter.text('Name?', { default: 'd', placeholder: 'p', validate: () => undefined }),
    ).toBe('typed')
    expect(await prompter.text('Name?')).toBe('typed')
    expect(
      await prompter.select('Pick', [{ value: 'a', label: 'A', hint: 'h' }, { value: 'b' }], {
        default: 'a',
      }),
    ).toBe('b')
    expect(await prompter.select('Pick', [{ value: 'a' }])).toBe('b')
    expect(seen[0]).toEqual({ message: 'Go?', initialValue: true })
    expect(seen[4]).toMatchObject({
      options: [
        { value: 'a', label: 'A', hint: 'h' },
        { value: 'b', label: 'b' },
      ],
      initialValue: 'a',
    })
    const cancelling = createInteractivePrompter({
      ...api,
      confirm: async () => CANCEL,
    } as unknown as ClackApi)
    await expect(cancelling.confirm('Go?')).rejects.toMatchObject({
      code: 'INTERRUPTED',
      exitCode: 130,
    })
  })
})

describe('contribution containment and Windows paths', () => {
  test('isInside handles both separators and sibling prefixes', () => {
    expect(isInside(join('a', 'pkg'), join('a', 'pkg', 'dist', 'x.js'))).toBe(true)
    expect(isInside(join('a', 'pkg'), join('a', 'pkg'))).toBe(true)
    expect(isInside(join('a', 'pkg'), join('a', 'pkg-evil', 'x.js'))).toBe(false)
    expect(isInside(join('a', 'pkg'), join('a', 'x.js'))).toBe(false)
    expect(isInNodeModules('C:\\proj\\node_modules\\.pnpm\\x\\node_modules\\@s\\y')).toBe(true)
    expect(isInNodeModules('/home/u/proj/src/plugin')).toBe(false)
  })

  test('symlinks pointing out of the package are refused', () => {
    const root = makeProject({ 'secret/plugin.mjs': 'export default []' })
    const dir = installFakePackage(root, 'strutvane-plugin-link', {
      strutvane: { commands: './link/plugin.mjs' },
    })
    try {
      symlinkSync(join(root, 'secret'), join(dir, 'link'), 'junction')
    } catch {
      return // links not permitted here
    }
    const pkg = readInstalledPackage(root, 'strutvane-plugin-link')
    expect(pkg).toBeDefined()
    if (pkg !== undefined)
      expect(() => resolveContribution(pkg, 'commands')).toThrow(
        expect.objectContaining({ code: 'UNSAFE_CONTRIBUTION' }),
      )
  })

  test('Windows drive-letter and UNC contribution paths are refused', () => {
    const root = makeProject()
    for (const declared of [
      'C:\\evil.mjs',
      'c:/evil.mjs',
      '\\\\server\\share\\x.mjs',
      'x\u0000.mjs',
    ]) {
      installFakePackage(root, 'strutvane-plugin-w', { strutvane: { commands: declared } })
      const pkg = readInstalledPackage(root, 'strutvane-plugin-w')
      if (pkg === undefined) throw new Error('fixture missing')
      expect(() => resolveContribution(pkg, 'commands'), declared).toThrow()
    }
  })

  test('package names never traverse directories', () => {
    expect(isValidPackageName('@strutvane/auth')).toBe(true)
    expect(isValidPackageName('..')).toBe(false)
    expect(isValidPackageName('@scope/..')).toBe(false)
    expect(isValidPackageName('a\\b')).toBe(false)
    expect(isValidPackageName('a/../b')).toBe(false)
    expect(readInstalledPackage(makeProject(), '../../etc')).toBeUndefined()
    expect(isContributorName('@strutvane/cli')).toBe(false)
    expect(isContributorName('@acme/strutvane-plugin-x')).toBe(true)
    expect(isContributorName('lodash')).toBe(false)
    expect(expandPackageName('auth')).toBe('@strutvane/auth')
  })

  test('findProjectRoot prefers strutvane.config.ts over a nearer package.json', () => {
    const root = makeProject()
    write(root, 'packages/inner/package.json', '{}')
    mkdirSync(join(root, 'packages', 'inner', 'src'), { recursive: true })
    expect(findProjectRoot(join(root, 'packages', 'inner', 'src'))).toBe(root)
    // A package.json alone is not a project; one that declares @strutvane/cli is.
    const plain = tempDir()
    write(plain, 'package.json', '{}')
    expect(findProjectRoot(join(plain))).toBeUndefined()
    write(plain, 'package.json', '{"devDependencies":{"@strutvane/cli":"^0.1.0"}}')
    expect(findProjectRoot(join(plain))).toBe(plain)
  })

  /** A sandbox: `<base>/home/user` is "home", `<base>/tmp` is "temp". */
  function sandbox(): { base: string; home: string; tmp: string; facts: BoundaryFacts } {
    const base = tempDir()
    const home = join(base, 'home', 'user')
    const tmp = join(base, 'tmp')
    mkdirSync(home, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    return { base, home, tmp, facts: { home, temp: tmp, uid: undefined } }
  }

  test('findProjectRoot never accepts the temp dir, folders above home or a drive root', () => {
    const { base, home, tmp, facts } = sandbox()
    for (const dir of [tmp, base, join(base, 'home')]) {
      write(dir, 'strutvane.config.ts', '')
      write(dir, 'package.json', '{"devDependencies":{"@strutvane/cli":"*"}}')
      expect(findProjectRoot(dir, facts), dir).toBeUndefined()
    }
    mkdirSync(join(tmp, 'x'), { recursive: true })
    expect(findProjectRoot(join(tmp, 'x'), facts)).toBeUndefined()
    expect(findProjectRoot(join(home, 'nowhere'), facts)).toBeUndefined()
    expect(isForbiddenProjectDir(parse(base).root, facts)).toBe(true)
    // A planted node_modules in a parent without a project package.json is never used.
    write(home, 'downloads/node_modules/@strutvane/framework/package.json', '{}')
    write(home, 'downloads/package.json', '{"name":"nope"}')
    expect(findProjectRoot(join(home, 'downloads'), facts)).toBeUndefined()
    const project = join(home, 'acme')
    write(project, 'strutvane.config.ts', '')
    expect(findProjectRoot(join(project), facts)).toBe(project)
  })

  test('findProjectRoot: POSIX ownership and manifest edge cases', () => {
    const { home, facts } = sandbox()
    const project = join(home, 'shared')
    write(project, 'strutvane.config.ts', '')
    expect(findProjectRoot(project, { ...facts, uid: 999_999_999 })).toBeUndefined()
    expect(isOwnedByCurrentUser(join(project, 'missing'), { ...facts, uid: 1 })).toBe(false)
    expect(declaresCli(null)).toBe(false)
    expect(declaresCli({ dependencies: { '@strutvane/cli': '1' } })).toBe(true)
    expect(declaresCli({ peerDependencies: { '@strutvane/cli': '1' } })).toBe(false)
    expect(
      declaresCli(JSON.parse('{"devDependencies":{"__proto__":{"@strutvane/cli":"1"}}}')),
    ).toBe(false)
    write(home, 'broken/package.json', '{ nope')
    expect(readManifest(join(home, 'broken'))).toBeUndefined()
    write(home, 'bom/package.json', '﻿{"devDependencies":{"@strutvane/cli":"1"}}')
    expect(findProjectRoot(join(home, 'bom'), facts)).toBe(join(home, 'bom'))
    expect(processBoundary().home).toBeTruthy()
  })

  test('the runner treats an unqualified folder as no project (plugins are never loaded)', async () => {
    const { home } = sandbox()
    const dir = join(home, 'plain')
    write(dir, 'package.json', '{"dependencies":{"strutvane-plugin-x":"1"}}')
    write(
      dir,
      'node_modules/strutvane-plugin-x/package.json',
      '{"name":"strutvane-plugin-x","version":"1.0.0","strutvane":{"commands":"./c.mjs","compat":"*"}}',
    )
    write(
      dir,
      'node_modules/strutvane-plugin-x/c.mjs',
      'globalThis.__planted = true; export default []',
    )
    const r = await cli(['routes', '--json'], { cwd: dir })
    expect(r.json().error?.code).toBe('PROJECT_NOT_FOUND')
    expect((globalThis as { __planted?: boolean }).__planted).toBeUndefined()
  })
})
