/**
 * `sv add` / `sv remove` with a fixture installer package, and `sv upgrade` on a fixture ejected
 * file. The package manager is a fake spawner that "installs" by writing into node_modules.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { installSpec, packageArgument } from '../../src/console/commands/packages.ts'
import { REDACTED, recordEjection } from '../../src/devkit/index.ts'
import {
  addDependencies,
  cleanupTempDirs,
  cli,
  fakeSpawner,
  installFakePackage,
  makeProject,
  read,
  snapshotTree,
  write,
} from './helpers.ts'

afterAll(cleanupTempDirs)

const INSTALLER = `
export default {
  name: 'demo',
  description: 'Demo package',
  async install(ctx) {
    const methods = typeof ctx.answers.methods === 'string' ? ctx.answers.methods : 'email'
    await ctx.fs.write('config/demo.ts', 'export default { methods: ' + JSON.stringify(methods.split(',')) + ' }\\n')
    await ctx.env.add('Demo', [{ key: 'DEMO_URL', value: 'http://localhost:4000' }, { key: 'DEMO_SECRET', secret: true }])
    await ctx.fs.write('app/models/demo-item.model.ts', "import { defineModel, field } from '@strutvane/framework'\\nexport default defineModel('DemoItem', { name: field.string() })\\n")
    ctx.log.info('demo installed')
    if (!ctx.has('@strutvane/ui')) ctx.log.warn('install @strutvane/ui for screens')
  },
  async uninstall(ctx) {
    await ctx.fs.remove('config/demo.ts')
    await ctx.env.remove(['DEMO_URL', 'DEMO_SECRET'])
    ctx.log.info('keepData=' + String(ctx.answers.keepData))
  },
}
`

function installDemo(root: string, extra: Record<string, unknown> = {}): void {
  installFakePackage(root, '@strutvane/demo', {
    version: '0.1.0',
    strutvane: { installer: './installer.mjs', ...extra },
    files: { 'installer.mjs': INSTALLER },
  })
}

/** A spawner whose `pnpm add` installs the demo package. */
function installingSpawner(root: string) {
  return fakeSpawner((call) => {
    const demo = (x: string): boolean => x === '@strutvane/demo' || x.startsWith('@strutvane/demo@')
    if (call.args[0] === 'add' && call.args.some(demo)) {
      installDemo(root)
      addDependencies(root, { '@strutvane/demo': '0.1.0' })
    }
    return { code: 0 }
  })
}

describe('add', () => {
  test('first-party packages come from the CLI release channel; others by bare name', async () => {
    expect(installSpec('@strutvane/auth', '0.1.0-next.0')).toBe('@strutvane/auth@next')
    expect(installSpec('@strutvane/auth', '0.2.0-canary.3')).toBe('@strutvane/auth@canary')
    expect(installSpec('@strutvane/auth', '1.0.0')).toBe('@strutvane/auth')
    expect(installSpec('@strutvane/auth', '1.0.0-0')).toBe('@strutvane/auth')
    expect(installSpec('strutvane-plugin-x', '0.1.0-next.0')).toBe('strutvane-plugin-x')
    expect(installSpec('@acme/strutvane-plugin-x', '0.1.0-next.0')).toBe('@acme/strutvane-plugin-x')
    for (const [version, spec] of [
      ['0.1.0-next.0', '@strutvane/demo@next'],
      ['1.0.0', '@strutvane/demo'],
    ] as const) {
      const root = makeProject({ 'pnpm-lock.yaml': '', '.env.example': '' })
      const spawn = installingSpawner(root)
      const r = await cli(['add', 'demo', '--json'], { cwd: root, spawn, version })
      expect(r.code, r.stdout).toBe(0)
      expect(spawn.calls[0]?.args).toEqual(['add', spec])
    }
  })

  test('installs with the project package manager, runs the installer and refreshes the registry', async () => {
    const root = makeProject({ 'pnpm-lock.yaml': '', '.env.example': '' })
    const spawn = installingSpawner(root)
    const r = await cli(['add', 'demo', '--methods', 'email,google', '--json'], {
      cwd: root,
      spawn,
      version: '1.0.0',
    })
    expect(r.code, r.stdout).toBe(0)
    expect(spawn.calls[0]).toMatchObject({
      command: 'pnpm',
      args: ['add', '@strutvane/demo'],
      options: { cwd: root, stdio: 'pipe' },
    })
    expect(read(root, 'config/demo.ts')).toBe('export default { methods: ["email","google"] }\n')
    expect(read(root, '.env')).toMatch(/DEMO_SECRET=[A-Za-z0-9_-]{43}/)
    expect(read(root, '.env.example')).toMatch(/^DEMO_SECRET=$/m)
    expect(existsSync(join(root, '.strutvane/registry.gen.ts'))).toBe(true)
    expect(r.json().data).toMatchObject({
      package: '@strutvane/demo',
      installer: 'demo',
      dryRun: false,
      messages: [
        { level: 'info', message: 'demo installed' },
        { level: 'warn', message: 'install @strutvane/ui for screens' },
      ],
    })
    expect(r.json().warnings).toEqual(['install @strutvane/ui for screens'])
  })

  test('already installed: no package manager call; --dry-run --diff previews and writes nothing', async () => {
    const root = makeProject()
    installDemo(root)
    addDependencies(root, { '@strutvane/demo': '0.1.0' })
    const before = snapshotTree(root)
    const spawn = fakeSpawner()
    const r = await cli(['add', '@strutvane/demo', '--dry-run', '--diff'], { cwd: root, spawn })
    expect(r.code).toBe(0)
    expect(spawn.calls).toEqual([])
    expect(r.stdout).toContain('would create')
    expect(r.stdout).toContain('+++ b/config/demo.ts')
    expect(snapshotTree(root)).toEqual(before)
  })

  test('re-running add is idempotent (no changes the second time)', async () => {
    const root = makeProject()
    installDemo(root)
    addDependencies(root, { '@strutvane/demo': '0.1.0' })
    expect((await cli(['add', 'demo'], { cwd: root })).code).toBe(0)
    const before = snapshotTree(root)
    const again = await cli(['add', 'demo', '--json'], { cwd: root })
    expect((again.json().data as { changes: unknown[] }).changes).toEqual([])
    expect(snapshotTree(root)).toEqual(before)
  })

  test('not installed + --dry-run: nothing runs', async () => {
    const root = makeProject()
    const spawn = fakeSpawner()
    const r = await cli(['add', 'demo', '--dry-run', '--json'], { cwd: root, spawn })
    expect(r.code).toBe(0)
    expect(spawn.calls).toEqual([])
    expect(r.json().data).toMatchObject({ installedPackage: false, installer: null })
  })

  test('package manager failure: COMMAND_FAILED (exit 1)', async () => {
    const r = await cli(['add', 'demo', '--json'], {
      cwd: makeProject(),
      spawn: fakeSpawner(() => ({ code: 1 })),
    })
    expect(r.code).toBe(1)
    expect(r.json().error).toMatchObject({ code: 'COMMAND_FAILED' })
    expect(r.json().error?.message).toContain('npm install @strutvane/demo')
  })

  test('a package without an installer is fine', async () => {
    const root = makeProject()
    installFakePackage(root, '@strutvane/plain')
    const r = await cli(['add', 'plain', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.json().data).toMatchObject({ installer: null })
  })

  test('refuses invalid package names, paths, URLs and file: specs (exit 2) before running anything', async () => {
    const spawn = fakeSpawner()
    for (const bad of [
      '../evil',
      'file:../x',
      'https://evil.example/x.tgz',
      'git+ssh://x',
      '@Scope/X',
      'a b',
      'C:\\x',
    ]) {
      const r = await cli(['add', bad, '--json'], { cwd: makeProject(), spawn })
      expect(r.code, bad).toBe(2)
      expect(r.json().error?.code).toBe('INVALID_PACKAGE_NAME')
    }
    expect(spawn.calls).toEqual([])
    expect(packageArgument('auth')).toBe('@strutvane/auth')
    expect(packageArgument('strutvane-plugin-x')).toBe('strutvane-plugin-x')
    expect(packageArgument('@acme/thing')).toBe('@acme/thing')
  })

  test('--diff never shows env-file values (secret canary)', async () => {
    const CANARY = 'canary-7f3a9c1e'
    const root = makeProject({ '.env': `EXISTING_TOKEN=${CANARY}-old\nAPP_ENV=local\n` })
    installFakePackage(root, '@strutvane/secrets', {
      strutvane: { installer: './i.mjs' },
      files: {
        'i.mjs': `export default { name: 'secrets', async install(ctx) {
  await ctx.env.add('Payments', [{ key: 'PAYMENT_TOKEN', value: '${CANARY}' }])
  await ctx.fs.write('.env.local', 'LOCAL_TOKEN=${CANARY}\\n')
  await ctx.fs.write('config/payments.ts', 'export default {}\\n')
} }`,
      },
    })
    addDependencies(root, { '@strutvane/secrets': '0.1.0' })
    for (const extra of [['--dry-run', '--diff'], ['--dry-run', '--diff', '--json'], ['--diff']]) {
      const r = await cli(['add', '@strutvane/secrets', ...extra], { cwd: root })
      expect(r.code, extra.join(' ')).toBe(0)
      expect(r.stdout + r.stderr).not.toContain(CANARY)
      if (!extra.includes('--json')) {
        expect(r.stdout).toContain(`PAYMENT_TOKEN=${REDACTED}`)
        expect(r.stdout).toContain('+++ b/config/payments.ts')
      }
    }
  })

  test('a third-party plugin without strutvane.compat is refused before its installer runs', async () => {
    const root = makeProject()
    installFakePackage(root, 'strutvane-plugin-nocompat', {
      version: '1.0.0',
      strutvane: { installer: './i.mjs' },
      files: { 'i.mjs': 'globalThis.__ranNoCompat = true; export default {}' },
    })
    addDependencies(root, { 'strutvane-plugin-nocompat': '1.0.0' })
    const r = await cli(['add', 'strutvane-plugin-nocompat', '--json'], { cwd: root })
    expect(r.code).toBe(7)
    expect(r.json().error?.code).toBe('MISSING_COMPAT')
    expect(r.json().error?.hint).toContain('strutvane')
    expect((globalThis as { __ranNoCompat?: boolean }).__ranNoCompat).toBeUndefined()
  })

  test('incompatible packages are refused (exit 7) before their installer runs', async () => {
    const root = makeProject()
    installDemo(root, { compat: '^5.0.0' })
    const r = await cli(['add', 'demo', '--json'], { cwd: root, version: '0.1.0' })
    expect(r.code).toBe(7)
    expect(r.json().error?.code).toBe('INCOMPATIBLE_PACKAGE')
    expect(existsSync(join(root, 'config/demo.ts'))).toBe(false)
  })

  test('an installer path escaping the package is refused', async () => {
    const root = makeProject({
      'evil.mjs': 'export default { name: "evil", install() { throw new Error("ran") } }',
    })
    installFakePackage(root, '@strutvane/evil', { strutvane: { installer: '../../../evil.mjs' } })
    const r = await cli(['add', 'evil', '--json'], { cwd: root })
    expect(r.code).toBe(1)
    expect(r.json().error?.code).toBe('UNSAFE_CONTRIBUTION')
    const abs = makeProject()
    installFakePackage(abs, '@strutvane/abs', { strutvane: { installer: '/etc/passwd' } })
    expect((await cli(['add', 'abs', '--json'], { cwd: abs })).json().error?.code).toBe(
      'UNSAFE_CONTRIBUTION',
    )
  })

  test('malformed installer declarations and modules', async () => {
    const root = makeProject()
    installFakePackage(root, '@strutvane/a', { strutvane: { installer: 42 } })
    installFakePackage(root, '@strutvane/b', { strutvane: { installer: './missing.mjs' } })
    installFakePackage(root, '@strutvane/c', {
      strutvane: { installer: './i.mjs' },
      files: { 'i.mjs': 'export default 5' },
    })
    for (const name of ['a', 'b', 'c']) {
      const r = await cli(['add', name, '--json'], { cwd: root })
      expect(r.json().error?.code, name).toBe('INVALID_CONTRIBUTION')
    }
  })

  test('an installer that throws: nothing is written, INSTALLER_FAILED (exit 1)', async () => {
    const root = makeProject()
    installFakePackage(root, '@strutvane/bad', {
      strutvane: { installer: './i.mjs' },
      files: {
        'i.mjs':
          "export const installer = { name: 'bad', async install(ctx) { await ctx.fs.write('x.ts', 'x'); throw new Error('nope') } }",
      },
    })
    const before = snapshotTree(root)
    const r = await cli(['add', 'bad', '--json'], { cwd: root })
    expect(r.code).toBe(1)
    expect(r.json().error?.code).toBe('INSTALLER_FAILED')
    expect(snapshotTree(root)).toEqual(before)
  })
})

describe('remove', () => {
  test('reverses the installer, then uninstalls with the package manager', async () => {
    const root = makeProject({ 'yarn.lock': '' })
    installDemo(root)
    addDependencies(root, { '@strutvane/demo': '0.1.0' })
    await cli(['add', 'demo'], { cwd: root })
    const spawn = fakeSpawner()
    const r = await cli(['remove', 'demo', '--keep-data', '--json'], { cwd: root, spawn })
    expect(r.code, r.stdout).toBe(0)
    expect(existsSync(join(root, 'config/demo.ts'))).toBe(false)
    expect(read(root, '.env')).not.toContain('DEMO_URL')
    expect(spawn.calls[0]).toMatchObject({ command: 'yarn', args: ['remove', '@strutvane/demo'] })
    expect(r.json().data).toMatchObject({ messages: [{ level: 'info', message: 'keepData=true' }] })
  })

  test('--dry-run and --keep-package', async () => {
    const root = makeProject()
    installDemo(root)
    await cli(['add', 'demo'], { cwd: root })
    const before = snapshotTree(root)
    const spawn = fakeSpawner()
    const dry = await cli(['remove', 'demo', '--dry-run'], { cwd: root, spawn })
    expect(dry.stdout).toContain('would delete')
    expect(dry.stdout).toContain('would uninstall @strutvane/demo')
    expect(snapshotTree(root)).toEqual(before)
    const keep = await cli(['remove', 'demo', '--keep-package', '--json'], { cwd: root, spawn })
    expect(keep.code).toBe(0)
    expect(spawn.calls).toEqual([])
  })

  test('not installed: PACKAGE_NOT_INSTALLED; no installer: only the dependency is removed', async () => {
    expect(
      (await cli(['remove', 'ghost', '--json'], { cwd: makeProject() })).json().error?.code,
    ).toBe('PACKAGE_NOT_INSTALLED')
    const root = makeProject()
    installFakePackage(root, '@strutvane/plain')
    const spawn = fakeSpawner()
    expect((await cli(['remove', 'plain'], { cwd: root, spawn })).code).toBe(0)
    expect(spawn.calls[0]?.args).toEqual(['uninstall', '@strutvane/plain'])
  })
})

describe('upgrade', () => {
  const BASE = [
    'export function handler() {',
    "  const greeting = 'hello'",
    '  return greeting',
    '}',
    '',
  ].join('\n')
  const NEXT = [
    'export function handler() {',
    "  const greeting = 'hello'",
    '  return greeting.toUpperCase()',
    '}',
    '',
  ].join('\n')
  const PATH = 'app/http/controllers/invoice.controller.ts'

  async function ejectedProject(templateContent: string): Promise<string> {
    const root = makeProject({}, { dependencies: { '@strutvane/framework': '0.1.0' } })
    await recordEjection({
      projectRoot: root,
      outputs: [{ path: PATH, template: 'framework/controller', version: '0.1.0', content: BASE }],
    })
    installFakePackage(root, '@strutvane/framework', {
      version: '0.2.0',
      strutvane: { templates: './templates.mjs' },
      files: {
        'templates.mjs': `export default () => [{ path: ${JSON.stringify(PATH)}, template: 'framework/controller', version: '0.2.0', content: ${JSON.stringify(templateContent)} }]`,
      },
    })
    return root
  }

  test('three-way merges a user-edited owned file with the new template', async () => {
    const root = await ejectedProject(NEXT)
    write(root, PATH, `// my note\n${BASE}`)
    const r = await cli(['upgrade', '--json'], { cwd: root })
    expect(r.code, r.stdout).toBe(0)
    expect(read(root, PATH)).toBe(`// my note\n${NEXT}`)
    expect(r.json().data).toMatchObject({
      written: [PATH],
      conflicted: [],
      templates: 1,
      typecheck: null,
    })
  })

  test('--dry-run previews the merge and writes nothing', async () => {
    const root = await ejectedProject(NEXT)
    const before = snapshotTree(root)
    const r = await cli(['upgrade', '--dry-run'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('update')
    expect(r.stdout).toContain('greeting.toUpperCase()')
    expect(snapshotTree(root)).toEqual(before)
  })

  test('conflicting edits: markers are written and the command exits 4', async () => {
    const root = await ejectedProject(NEXT)
    write(root, PATH, BASE.replace('return greeting', 'return greeting.trim()'))
    const r = await cli(['upgrade', '--json'], { cwd: root })
    expect(r.code).toBe(4)
    expect(r.json().error).toMatchObject({ code: 'MERGE_CONFLICTS' })
    expect(read(root, PATH)).toContain('<<<<<<<')
  })

  test('runs the project typecheck afterwards; a failure is TYPECHECK_FAILED (exit 1)', async () => {
    const root = await ejectedProject(NEXT)
    write(root, 'node_modules/typescript/bin/tsc', '// fake tsc')
    const ok = fakeSpawner(() => ({ code: 0 }))
    const r = await cli(['upgrade', '--json'], { cwd: root, spawn: ok })
    expect(r.json().data).toMatchObject({ typecheck: true })
    expect(ok.calls[0]?.args).toEqual([
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
    ])

    const root2 = await ejectedProject(NEXT)
    write(root2, 'node_modules/typescript/bin/tsc', '// fake tsc')
    const bad = await cli(['upgrade', '--json'], {
      cwd: root2,
      spawn: fakeSpawner(() => ({ code: 2 })),
    })
    expect(bad.code).toBe(1)
    expect(bad.json().error?.code).toBe('TYPECHECK_FAILED')
    const skipped = await ejectedProject(NEXT)
    write(skipped, 'node_modules/typescript/bin/tsc', '// fake tsc')
    const spawn = fakeSpawner()
    await cli(['upgrade', '--no-typecheck'], { cwd: skipped, spawn })
    expect(spawn.calls).toEqual([])
  })

  test('--to bumps every Strutvane dependency through the package manager', async () => {
    const root = await ejectedProject(BASE)
    addDependencies(root, { '@strutvane/core': '0.1.0', strutvane: '0.1.0', lodash: '1.0.0' })
    const spawn = fakeSpawner()
    const r = await cli(['upgrade', '--to', '0.2.0', '--no-typecheck', '--json'], {
      cwd: root,
      spawn,
    })
    expect(r.code).toBe(0)
    expect(spawn.calls[0]?.args).toEqual([
      'install',
      '@strutvane/core@0.2.0',
      '@strutvane/framework@0.2.0',
      'strutvane@0.2.0',
    ])
    expect(r.json().data).toMatchObject({
      bumped: ['@strutvane/core', '@strutvane/framework', 'strutvane'],
    })
    const dry = await cli(['upgrade', '--channel', 'next', '--dry-run'], {
      cwd: root,
      spawn: fakeSpawner(),
    })
    expect(dry.stdout).toContain('would update Strutvane packages to next')
    const failing = await cli(['upgrade', '--channel', 'next', '--json'], {
      cwd: root,
      spawn: fakeSpawner(() => ({ code: 1 })),
    })
    expect(failing.json().error?.code).toBe('COMMAND_FAILED')
  })

  test('validates --to and --channel (exit 2)', async () => {
    const root = makeProject()
    expect((await cli(['upgrade', '--to', 'latest'], { cwd: root })).code).toBe(2)
    expect((await cli(['upgrade', '--channel', 'Next!'], { cwd: root })).code).toBe(2)
    expect((await cli(['upgrade', '--to', '1.0.0', '--channel', 'next'], { cwd: root })).code).toBe(
      2,
    )
  })

  test('nothing to upgrade; invalid template modules are reported', async () => {
    const empty = await cli(['upgrade'], { cwd: makeProject() })
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain('No owned files to upgrade')
    const root = makeProject({}, { dependencies: { '@strutvane/framework': '0.1.0' } })
    installFakePackage(root, '@strutvane/framework', {
      strutvane: { templates: './t.mjs' },
      files: { 't.mjs': 'export const templates = [{ path: 1 }]' },
    })
    const r = await cli(['upgrade', '--json'], { cwd: root })
    expect(r.json().error).toMatchObject({ code: 'INVALID_CONTRIBUTION' })
  })

  test('an owned file the user deleted is not recreated', async () => {
    const root = await ejectedProject(NEXT)
    writeFileSync(join(root, PATH), '')
    const { rmSync } = await import('node:fs')
    rmSync(join(root, PATH))
    const r = await cli(['upgrade', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    expect(existsSync(join(root, PATH))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(root, '.strutvane/lock.json'), 'utf8')).files[PATH].status,
    ).toBe('deleted-by-user')
  })
})
