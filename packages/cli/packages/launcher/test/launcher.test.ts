/**
 * The `strutvane` launcher: in-process (fake spawner) and end to end in temp projects with real
 * child processes (`node packages/launcher/src/bin.ts`, run through Node's type stripping).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import {
  CREATE_ENV,
  cwdFlag,
  DEPTH_ENV,
  findLocalCli,
  type LauncherEnvironment,
  NO_NOTICE_ENV,
  nodeLaunchSpawner,
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

  test('local wins: even --version and new are handled by the local CLI', async () => {
    const env = environment(projectWithCli())
    await runLauncher(['--version'], env)
    await runLauncher(['new', 'x'], env)
    expect(env.captured.calls).toHaveLength(2)
    expect(env.captured.stdout).toBe('')
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

  test('new/create run create-strutvane through npx (npx.cmd + shell on Windows, args checked)', async () => {
    const dir = temp()
    const linux = environment(dir)
    await runLauncher(['new', 'acme', '--preset', 'api'], linux)
    expect(linux.captured.calls[0]).toMatchObject({
      command: 'npx',
      args: ['--yes', 'create-strutvane@latest', 'acme', '--preset', 'api'],
      shell: false,
    })
    const win = environment(dir, { platform: 'win32' })
    await runLauncher(['create', 'acme'], win)
    expect(win.captured.calls[0]).toMatchObject({ command: 'npx.cmd', shell: true })
    const unsafe = environment(dir, { platform: 'win32' })
    expect(await runLauncher(['new', 'acme & calc'], unsafe)).toBe(2)
    expect(unsafe.captured.calls).toEqual([])
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

  test(`${CREATE_ENV} overrides the starter command; invalid values are rejected`, async () => {
    const dir = temp()
    const env = environment(dir, { env: { [CREATE_ENV]: JSON.stringify(['node', 'create.js']) } })
    await runLauncher(['new', 'x'], env)
    expect(env.captured.calls[0]).toMatchObject({
      command: 'node',
      args: ['create.js', 'x'],
      shell: false,
    })
    const bad = environment(dir, { env: { [CREATE_ENV]: '"node"' } })
    expect(await runLauncher(['new', 'x'], bad)).toBe(2)
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
