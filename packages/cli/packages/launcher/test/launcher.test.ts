/**
 * The `strutvane` launcher: in-process (fake spawner) and end to end in temp projects with real
 * child processes (`node packages/launcher/src/bin.ts`, run through Node's type stripping).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import {
  type BoundaryFacts,
  CREATE_ENV,
  childEnv,
  commandWord,
  cwdFlag,
  DEPTH_ENV,
  declaresCli,
  findLocalCli,
  findNpxCli,
  isForbiddenProjectDir,
  isLauncherCommand,
  isOwnedByCurrentUser,
  type LauncherEnvironment,
  NO_NOTICE_ENV,
  nodeLaunchSpawner,
  packageSpec,
  printable,
  releaseChannel,
  resolveWindowsExecutable,
  runLauncher,
} from '../src/launcher.ts'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sv-launcher-'))
  dirs.push(dir)
  return dir
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A fake local CLI that prints its argv and env as JSON and exits with $FAKE_EXIT. */
const FAKE_CLI = `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), depth: process.env.${DEPTH_ENV}, cwd: process.cwd() }))
process.exitCode = Number(process.env.FAKE_EXIT ?? 0)
`

function projectWithCli(
  version = '0.1.0',
  bin: unknown = { 'strutvane-cli': './bin.mjs' },
): string {
  const root = temp()
  writeFile(join(root, 'package.json'), '{"name":"app","private":true}')
  writeFile(join(root, 'strutvane.config.ts'), 'export default {}\n')
  const dir = join(root, 'node_modules', '@strutvane', 'cli')
  writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@strutvane/cli', version, bin }))
  writeFile(join(dir, 'bin.mjs'), FAKE_CLI)
  return root
}

interface Captured {
  stdout: string
  stderr: string
  calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; shell: boolean }[]
}

function environment(
  cwd: string,
  overrides: Partial<LauncherEnvironment> = {},
): LauncherEnvironment & { captured: Captured } {
  const captured: Captured = { stdout: '', stderr: '', calls: [] }
  return {
    cwd,
    env: {},
    execPath: '/usr/bin/node',
    platform: 'linux',
    version: '0.1.0',
    stdout: (t) => {
      captured.stdout += t
    },
    stderr: (t) => {
      captured.stderr += t
    },
    spawn: async (command, args, options) => {
      captured.calls.push({ command, args, env: options.env, shell: options.shell })
      return 0
    },
    ...overrides,
    captured,
  }
}

describe('findLocalCli', () => {
  test('finds the CLI in the project and from nested folders', () => {
    const root = projectWithCli('0.3.0')
    const nested = join(root, 'app', 'models')
    mkdirSync(nested, { recursive: true })
    const found = findLocalCli(nested)
    expect(found?.version).toBe('0.3.0')
    expect(found?.bin).toBe(join(root, 'node_modules', '@strutvane', 'cli', 'bin.mjs'))
  })

  test('accepts a string bin; rejects a bin outside the package or missing', () => {
    expect(findLocalCli(projectWithCli('1.0.0', './bin.mjs'))?.version).toBe('1.0.0')
    expect(findLocalCli(projectWithCli('1.0.0', '../../../escape.mjs'))).toBeUndefined()
    expect(findLocalCli(projectWithCli('1.0.0', { other: './nope.mjs' }))).toBeUndefined()
    expect(findLocalCli(projectWithCli('1.0.0', 42))).toBeUndefined()
  })

  test('stops at the project root (strutvane.config.ts): a CLI above it is not used', () => {
    const outer = projectWithCli()
    const inner = join(outer, 'nested-project')
    writeFile(join(inner, 'strutvane.config.ts'), '')
    expect(findLocalCli(inner)).toBeUndefined()
  })

  test('walks up to the file-system root when there is no marker; tolerates broken manifests', () => {
    const root = temp()
    writeFile(join(root, 'node_modules', '@strutvane', 'cli', 'package.json'), '{ broken')
    expect(findLocalCli(join(root))).toBeUndefined()
  })

  test('cwdFlag', () => {
    expect(cwdFlag(['routes', '--cwd', 'x'])).toBe('x')
    expect(cwdFlag(['--cwd=y', 'routes'])).toBe('y')
    expect(cwdFlag(['--', '--cwd', 'z'])).toBeUndefined()
    expect(cwdFlag(['routes'])).toBeUndefined()
  })
})

describe('runLauncher (in-process)', () => {
  test('delegates to the local CLI with the same argv, incrementing the depth', async () => {
    const root = projectWithCli('0.1.0')
    const env = environment(root)
    expect(await runLauncher(['make:model', 'Invoice', '--json'], env)).toBe(0)
    expect(env.captured.calls[0]).toMatchObject({
      command: '/usr/bin/node',
      args: [
        join(root, 'node_modules', '@strutvane', 'cli', 'bin.mjs'),
        'make:model',
        'Invoice',
        '--json',
      ],
      shell: false,
    })
    expect(env.captured.calls[0]?.env[DEPTH_ENV]).toBe('1')
    expect(env.captured.stderr).toBe('')
  })

  test('--version, help, new and create are never delegated, even inside a project', async () => {
    const root = projectWithCli('0.9.0')
    for (const argv of [
      ['--version'],
      ['-V'],
      [],
      ['help'],
      ['help', 'make:model'],
      ['--help'],
      ['--cwd', root, '--version'],
    ]) {
      const env = environment(root, { version: '0.1.0' })
      expect(await runLauncher(argv, env)).toBe(0)
      expect(env.captured.calls).toEqual([])
    }
    const v = environment(root, { version: '0.1.0' })
    await runLauncher(['--version'], v)
    expect(v.captured.stdout).toBe('strutvane 0.1.0\nproject @strutvane/cli 0.9.0\n')
    const h = environment(root)
    await runLauncher(['help'], h)
    expect(h.captured.stdout).toContain('This project uses @strutvane/cli 0.9.0')
    for (const argv of [
      ['new', 'x'],
      ['create', 'x'],
    ]) {
      const env = environment(root)
      await runLauncher(argv, env)
      expect(env.captured.calls).toHaveLength(1)
      expect(env.captured.calls[0]?.args.some((a) => a.includes('node_modules'))).toBe(false)
      expect(env.captured.calls[0]?.args).toContain('create-strutvane@latest')
    }
  })

  test('--cwd selects where to look', async () => {
    const root = projectWithCli()
    const env = environment(temp())
    await runLauncher(['routes', '--cwd', root], env)
    expect(env.captured.calls).toHaveLength(1)
  })

  test('version mismatch notice: once on stderr, silenced by --json/--quiet/env', async () => {
    const root = projectWithCli('0.2.0')
    const env = environment(root, { version: '0.1.0' })
    await runLauncher(['about'], env)
    expect(env.captured.stderr).toBe(
      "strutvane: using the project's @strutvane/cli 0.2.0 (launcher 0.1.0).\n",
    )
    for (const extra of [['--json'], ['-q'], ['--quiet']]) {
      const quiet = environment(root, { version: '0.1.0' })
      await runLauncher(['about', ...extra], quiet)
      expect(quiet.captured.stderr).toBe('')
    }
    const silenced = environment(root, { version: '0.1.0', env: { [NO_NOTICE_ENV]: '1' } })
    await runLauncher(['about'], silenced)
    expect(silenced.captured.stderr).toBe('')
  })

  test('recursion guard: at depth >= 1 the launcher never delegates again', async () => {
    const env = environment(projectWithCli(), { env: { [DEPTH_ENV]: '1' } })
    expect(await runLauncher(['routes'], env)).toBe(2)
    expect(env.captured.calls).toEqual([])
  })

  test('without a local CLI: --version, help, and a clear error for project commands', async () => {
    const dir = temp()
    const v = environment(dir, { version: '1.2.3' })
    expect(await runLauncher(['-V'], v)).toBe(0)
    expect(v.captured.stdout).toBe('strutvane 1.2.3\n')
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const h = environment(dir)
      expect(await runLauncher(argv, h)).toBe(0)
      expect(h.captured.stdout).toContain('strutvane new <name>')
    }
    const e = environment(dir)
    expect(await runLauncher(['make:model', 'X'], e)).toBe(2)
    expect(e.captured.stderr).toContain('"make:model" needs a Strutvane project')
    expect(e.captured.stderr).toContain('pnpm add -D @strutvane/cli')
  })

  test('new/create run create-strutvane through npx (plain npx without npm next to node)', async () => {
    const dir = temp()
    const linux = environment(dir)
    await runLauncher(['new', 'acme', '--preset', 'api'], linux)
    expect(linux.captured.calls[0]).toMatchObject({
      command: 'npx',
      args: ['--yes', 'create-strutvane@latest', 'acme', '--preset', 'api'],
      shell: false,
    })
  })

  test('new/create fetch create-strutvane from the launcher release channel', async () => {
    const cases: [version: string, spec: string][] = [
      ['0.1.0-next.0', 'create-strutvane@next'],
      ['0.2.0-canary.20261114', 'create-strutvane@canary'],
      ['1.0.0', 'create-strutvane@latest'],
      ['0.0.0', 'create-strutvane@latest'],
      ['1.0.0-RC.1', 'create-strutvane@latest'],
      ['not a version', 'create-strutvane@latest'],
    ]
    for (const [version, spec] of cases) {
      for (const word of ['new', 'create']) {
        const env = environment(temp(), { version })
        expect(await runLauncher([word, 'acme', '--preset', 'api'], env)).toBe(0)
        expect(env.captured.calls).toEqual([
          {
            command: 'npx',
            args: ['--yes', spec, 'acme', '--preset', 'api'],
            env: {},
            shell: false,
          },
        ])
      }
    }
  })

  test('help and the no-project error name the release channel', async () => {
    const pre = environment(temp(), { version: '0.1.0-next.0' })
    await runLauncher(['help'], pre)
    expect(pre.captured.stdout).toContain('Create a project (runs create-strutvane@next)')
    const e = environment(temp(), { version: '0.1.0-next.0' })
    expect(await runLauncher(['routes'], e)).toBe(2)
    expect(e.captured.stderr).toContain('pnpm add -D @strutvane/cli@next\n')
    const stable = environment(temp(), { version: '1.0.0' })
    await runLauncher(['help'], stable)
    expect(stable.captured.stdout).toContain('Create a project (runs create-strutvane@latest)')
    const s = environment(temp(), { version: '1.0.0' })
    await runLauncher(['routes'], s)
    expect(s.captured.stderr).toContain('pnpm add -D @strutvane/cli\n')
  })

  test('doctor --global runs the matching @strutvane/cli through npx', async () => {
    const env = environment(temp(), { version: '0.4.0' })
    await runLauncher(['doctor', '--global'], env)
    expect(env.captured.calls[0]?.args).toEqual([
      '--yes',
      '@strutvane/cli@0.4.0',
      'doctor',
      '--global',
    ])
  })

  test('doctor --global pins a prerelease exactly; a non-semver version falls back to the channel', async () => {
    const pre = environment(temp(), { version: '0.1.0-next.3' })
    await runLauncher(['doctor', '--global'], pre)
    expect(pre.captured.calls[0]?.args).toEqual([
      '--yes',
      '@strutvane/cli@0.1.0-next.3',
      'doctor',
      '--global',
    ])
    for (const version of ['0.1.0 & calc', 'v1.0.0', '']) {
      const odd = environment(temp(), { version })
      await runLauncher(['doctor', '--global'], odd)
      expect(odd.captured.calls[0]?.args).toEqual([
        '--yes',
        '@strutvane/cli@latest',
        'doctor',
        '--global',
      ])
    }
  })

  test(`${CREATE_ENV} overrides the starter command; invalid values are rejected`, async () => {
    const dir = temp()
    const env = environment(dir, { env: { [CREATE_ENV]: JSON.stringify(['node', 'create.js']) } })
    await runLauncher(['new', 'x'], env)
    expect(env.captured.calls[0]).toMatchObject({
      command: 'node',
      args: ['create.js', 'x'],
      shell: false,
    })
    for (const value of ['"node"', '{ not json', '[]', '[1]', '[""]']) {
      const bad = environment(dir, { env: { [CREATE_ENV]: value } })
      expect(await runLauncher(['new', 'x'], bad)).toBe(2)
      expect(bad.captured.stderr).toContain(`${CREATE_ENV} must be a JSON array of strings`)
      expect(bad.captured.calls).toEqual([])
    }
  })
})

describe('end to end with real child processes', () => {
  const node = process.execPath
  const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(node, [BIN, ...args], {
      cwd,
      env: { ...process.env, [DEPTH_ENV]: '', [NO_NOTICE_ENV]: '', ...env },
      encoding: 'utf8',
    })

  test('delegates argv and propagates the exit code', () => {
    const root = projectWithCli('0.1.0')
    const ok = run(root, ['routes', '--json'])
    expect(ok.status).toBe(0)
    expect(JSON.parse(ok.stdout)).toMatchObject({ argv: ['routes', '--json'], depth: '1' })
    const failing = run(root, ['migrate'], { FAKE_EXIT: '4' })
    expect(failing.status).toBe(4)
  })

  test('works from a nested folder and from a symlinked project (where supported)', () => {
    const root = projectWithCli()
    const nested = join(root, 'web', 'pages')
    mkdirSync(nested, { recursive: true })
    expect(run(nested, ['about']).status).toBe(0)
    const link = join(temp(), 'linked')
    try {
      symlinkSync(root, link, 'junction')
    } catch {
      return // symlinks/junctions not permitted on this machine
    }
    expect(JSON.parse(run(link, ['x']).stdout).argv).toEqual(['x'])
  })

  test('project-less: --version and the error for project commands', () => {
    const dir = temp()
    const v = run(dir, ['--version'])
    expect(v.status).toBe(0)
    expect(v.stdout).toMatch(/^strutvane \d+\.\d+\.\d+/)
    const e = run(dir, ['routes'])
    expect(e.status).toBe(2)
    expect(e.stderr).toContain('no project-local @strutvane/cli was found')
  })

  test('new via the starter override (a real child process)', () => {
    const dir = temp()
    const starter = join(dir, 'starter.mjs')
    writeFile(starter, "process.stdout.write('created ' + process.argv.slice(2).join(' '))")
    const r = run(dir, ['new', 'acme'], { [CREATE_ENV]: JSON.stringify([node, starter]) })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('created acme')
  })

  test('nodeLaunchSpawner reports signals as 128 + n and spawn errors as rejections', async () => {
    const code = await nodeLaunchSpawner(node, ['-e', "process.kill(process.pid, 'SIGTERM')"], {
      env: process.env,
      shell: false,
    })
    expect([143, 1]).toContain(code) // Windows has no real SIGTERM delivery
    await expect(
      nodeLaunchSpawner(join(temp(), 'missing-binary'), [], { env: process.env, shell: false }),
    ).rejects.toThrow()
    expect(execFileSync(node, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' })).toBe(
      'ok',
    )
  })
})

/** Plant a working fake `@strutvane/cli` in `dir/node_modules` (no project marker). */
function plantCli(dir: string, version = '6.6.6'): void {
  const pkg = join(dir, 'node_modules', '@strutvane', 'cli')
  writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@strutvane/cli', version, bin: './bin.mjs' }),
  )
  writeFile(join(pkg, 'bin.mjs'), FAKE_CLI)
}

/** A sandbox: `<base>/home/user` is "home", `<base>/tmp` is "temp". */
function sandbox(): { base: string; home: string; tmp: string; facts: BoundaryFacts } {
  const base = temp()
  const home = join(base, 'home', 'user')
  const tmp = join(base, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  return { base, home, tmp, facts: { home, temp: tmp, uid: undefined } }
}

describe('project boundary (which folders may be delegated to)', () => {
  test('a node_modules in a parent folder without a project package.json is never used', () => {
    const { home, facts } = sandbox()
    const parent = join(home, 'downloads')
    plantCli(parent)
    writeFile(join(parent, 'package.json'), '{"name":"not-a-project"}')
    const work = join(parent, 'some', 'folder')
    mkdirSync(work, { recursive: true })
    expect(findLocalCli(work, facts)).toBeUndefined()
    expect(findLocalCli(parent, facts)).toBeUndefined()
  })

  test('a package.json declaring @strutvane/cli (dependencies or devDependencies) qualifies', () => {
    const { home, facts } = sandbox()
    for (const [field, ok] of [
      ['devDependencies', true],
      ['dependencies', true],
      ['peerDependencies', false],
      ['optionalDependencies', false],
    ] as const) {
      const dir = join(home, `app-${field}`)
      plantCli(dir, '1.2.3')
      writeFile(join(dir, 'package.json'), JSON.stringify({ [field]: { '@strutvane/cli': '^1' } }))
      expect(findLocalCli(dir, facts)?.version, field).toBe(ok ? '1.2.3' : undefined)
    }
    expect(declaresCli(undefined)).toBe(false)
    expect(declaresCli({ devDependencies: { '@strutvane/cli': 1 } })).toBe(false)
    expect(
      declaresCli({ devDependencies: JSON.parse('{"__proto__":{"@strutvane/cli":"1"}}') }),
    ).toBe(false)
  })

  test('the temp directory itself is never a project, even with a marker', () => {
    const { tmp, facts } = sandbox()
    plantCli(tmp)
    writeFile(join(tmp, 'strutvane.config.ts'), '')
    writeFile(join(tmp, 'package.json'), '{"devDependencies":{"@strutvane/cli":"*"}}')
    const below = join(tmp, 'extracted-archive')
    mkdirSync(below, { recursive: true })
    expect(findLocalCli(tmp, facts)).toBeUndefined()
    expect(findLocalCli(below, facts)).toBeUndefined()
  })

  test('folders above home are never projects; home and below are', () => {
    const { base, home, facts } = sandbox()
    for (const above of [base, join(base, 'home')]) {
      plantCli(above)
      writeFile(join(above, 'strutvane.config.ts'), '')
      writeFile(join(above, 'package.json'), '{"devDependencies":{"@strutvane/cli":"*"}}')
      expect(findLocalCli(above, facts)).toBeUndefined()
      expect(findLocalCli(home, facts)).toBeUndefined()
    }
    const project = join(home, 'acme')
    plantCli(project, '0.4.0')
    writeFile(join(project, 'strutvane.config.ts'), '')
    expect(findLocalCli(project, facts)?.version).toBe('0.4.0')
  })

  test('a file-system or drive root is never a project', () => {
    const fsRoot = parse(temp()).root
    expect(isForbiddenProjectDir(fsRoot, { home: temp(), temp: temp(), uid: undefined })).toBe(true)
    expect(isForbiddenProjectDir(temp(), { home: temp(), temp: temp(), uid: undefined })).toBe(
      false,
    )
  })

  test('POSIX: a folder owned by another user is refused', () => {
    const { home, facts } = sandbox()
    const project = join(home, 'shared')
    plantCli(project)
    writeFile(join(project, 'strutvane.config.ts'), '')
    expect(findLocalCli(project, facts)).toBeDefined()
    const otherUser = { ...facts, uid: 999_999_999 }
    expect(isOwnedByCurrentUser(project, otherUser)).toBe(false)
    expect(findLocalCli(project, otherUser)).toBeUndefined()
    expect(isOwnedByCurrentUser(join(project, 'missing'), otherUser)).toBe(false)
    expect(isOwnedByCurrentUser(project, facts)).toBe(true)
  })

  test('runLauncher never runs a planted CLI (hijack matrix)', async () => {
    const { base, home, tmp, facts } = sandbox()
    for (const dir of [join(home, 'parent'), tmp, base]) plantCli(dir)
    writeFile(join(home, 'parent', 'package.json'), '{}')
    const starts = [join(home, 'parent', 'child'), join(tmp, 'x'), join(home, 'elsewhere')]
    for (const start of starts) {
      mkdirSync(start, { recursive: true })
      for (const argv of [
        ['--version'],
        ['help'],
        ['new', 'acme'],
        ['routes'],
        ['make:model', 'X'],
      ]) {
        const env = environment(start, { boundary: facts })
        await runLauncher(argv, env)
        const ranPlanted = env.captured.calls.some((c) => c.args.some((a) => a.endsWith('bin.mjs')))
        expect(ranPlanted, `${start} ${argv.join(' ')}`).toBe(false)
      }
    }
  })

  test('manifest versions are printed without control characters', async () => {
    const root = projectWithCli('1.0.0\u001b[31m\nspoofed')
    expect(findLocalCli(root)?.version).toBe('1.0.0[31mspoofed')
    expect(printable('a\u0007b\u009bc\r\n')).toBe('abc')
    const env = environment(root, { version: '0.1.0' })
    await runLauncher(['about'], env)
    expect(env.captured.stderr).toContain('1.0.0[31mspoofed')
    expect(env.captured.stderr.includes('\u001b')).toBe(false)
  })

  test('commandWord and isLauncherCommand', () => {
    expect(commandWord(['--cwd', 'x', 'routes'])).toBe('routes')
    expect(commandWord(['--json'])).toBeUndefined()
    expect(commandWord(['--', 'routes'])).toBeUndefined()
    expect(isLauncherCommand(['--cwd', 'help', '--version'])).toBe(true)
    expect(isLauncherCommand(['new'])).toBe(true)
    expect(isLauncherCommand(['make:model', '--version'])).toBe(false)
  })
})

describe('child processes on Windows', () => {
  test('childEnv sets NoDefaultCurrentDirectoryInExePath on win32 only', () => {
    expect(childEnv({ A: '1' }, 'win32')).toEqual({
      A: '1',
      NoDefaultCurrentDirectoryInExePath: '1',
    })
    expect(childEnv({ A: '1' }, 'linux', { B: '2' })).toEqual({ A: '1', B: '2' })
  })

  test('delegation passes the Windows environment flag', async () => {
    const env = environment(projectWithCli(), { platform: 'win32' })
    await runLauncher(['routes'], env)
    expect(env.captured.calls[0]?.env['NoDefaultCurrentDirectoryInExePath']).toBe('1')
  })

  test('resolveWindowsExecutable skips the working directory and relative PATH entries', () => {
    const files = new Set(['C:\\proj\\npx.cmd', 'D:\\rel\\npx.cmd', 'C:\\node\\npx.cmd'])
    const exists = (p: string): boolean => files.has(p)
    const env = { PATH: ';C:\\Proj;.;rel;"C:\\node"', PATHEXT: '.EXE;.CMD' }
    expect(resolveWindowsExecutable('npx', env, 'C:\\proj', exists)).toBe('C:\\node\\npx.cmd')
    expect(resolveWindowsExecutable('npx', { Path: 'C:\\proj' }, 'C:\\proj', exists)).toBe(
      undefined,
    )
    expect(resolveWindowsExecutable('npx', {}, 'C:\\proj', exists)).toBeUndefined()
  })

  test('npx runs as node npx-cli.js (no shell) when npm sits next to node', async () => {
    const prefix = temp()
    const winNode = join(prefix, 'node.exe')
    const winCli = join(prefix, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    writeFile(winCli, '')
    if (process.platform === 'win32') expect(findNpxCli(winNode, 'win32')).toBe(winCli)
    const posixNode = join(prefix, 'bin', 'node')
    writeFile(join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), '')
    expect(findNpxCli(posixNode, 'linux')).toBe(
      join(prefix, 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    )
    expect(findNpxCli(join(temp(), 'node'), 'linux')).toBeUndefined()
    const node = process.platform === 'win32' ? winNode : posixNode
    const npxCli = findNpxCli(node, process.platform) ?? ''
    const env = environment(temp(), { platform: process.platform, execPath: node })
    await runLauncher(['new', 'acme & calc'], env)
    expect(env.captured.calls[0]).toMatchObject({
      command: node,
      args: [npxCli, '--yes', 'create-strutvane@latest', 'acme & calc'],
      shell: false,
    })
  })

  test('without npx-cli.js: Windows refuses when npx is not on PATH', async () => {
    const env = environment(temp(), {
      platform: 'win32',
      execPath: join(temp(), 'node.exe'),
      env: { PATH: '' },
    })
    expect(await runLauncher(['new', 'acme'], env)).toBe(2)
    expect(env.captured.stderr).toContain('could not find npx on PATH')
    expect(env.captured.calls).toEqual([])
  })

  test.skipIf(process.platform !== 'win32')(
    'Windows fallback: a planted npx.cmd in the working directory is never chosen',
    async () => {
      const cwd = temp()
      writeFile(join(cwd, 'npx.cmd'), '@echo planted')
      const real = temp()
      writeFile(join(real, 'npx.cmd'), '@echo real')
      const env = environment(cwd, {
        platform: 'win32',
        execPath: join(temp(), 'node.exe'),
        env: { PATH: `${cwd};${real}`, PATHEXT: '.CMD' },
      })
      await runLauncher(['new', 'acme'], env)
      expect(env.captured.calls[0]).toMatchObject({
        command: `"${join(real, 'npx.cmd')}"`,
        shell: true,
      })
      expect(env.captured.calls[0]?.env['NoDefaultCurrentDirectoryInExePath']).toBe('1')
      const unsafe = environment(cwd, {
        platform: 'win32',
        execPath: join(temp(), 'node.exe'),
        env: { PATH: real, PATHEXT: '.CMD' },
      })
      expect(await runLauncher(['new', 'acme & calc'], unsafe)).toBe(2)
      expect(unsafe.captured.calls).toEqual([])
    },
  )
})

describe('releaseChannel', () => {
  test('stable versions are on latest; a prerelease id is its own channel', () => {
    expect(releaseChannel('1.2.3')).toBe('latest')
    expect(releaseChannel('0.1.0')).toBe('latest')
    expect(releaseChannel('1.2.3+build.5')).toBe('latest')
    expect(releaseChannel('0.1.0-next.0')).toBe('next')
    expect(releaseChannel('0.1.0-next')).toBe('next')
    expect(releaseChannel('0.2.0-canary.20261114')).toBe('canary')
    expect(releaseChannel('1.0.0-beta-2.1+sha.abc')).toBe('beta-2')
  })

  test('anything odd falls back to latest instead of reaching npx', () => {
    for (const version of [
      '',
      '0.0',
      'v1.0.0-next.0', // not strict semver
      '01.0.0-next.0', // leading zero
      '1.0.0-0', // numeric id
      '1.0.0-1next.0', // starts with a digit
      '1.0.0-Next.0', // upper case: npm tags are case-sensitive, ours are lowercase
      '1.0.0-latest.1',
      '1.0.0-next..1',
      '1.0.0-next.0 && calc',
      '1.0.0-next&calc.0',
      '1.0.0-next.0\n',
      `1.0.0-${'a'.repeat(65)}.0`,
    ]) {
      expect(releaseChannel(version), version).toBe('latest')
    }
    expect(releaseChannel(`1.0.0-${'a'.repeat(64)}.0`)).toBe('a'.repeat(64))
  })

  test('packageSpec: bare on latest, name@channel otherwise', () => {
    expect(packageSpec('@strutvane/cli', 'latest')).toBe('@strutvane/cli')
    expect(packageSpec('@strutvane/cli', 'next')).toBe('@strutvane/cli@next')
  })
})
