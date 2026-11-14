/**
 * Package migrations run as the database OWNER, so the CLI hands the framework only the folders
 * of packages the app enabled (imported in strutvane.config.ts), that are direct dependencies with
 * a contributor name, compatible, and whose folder resolves inside the package. Attack-style cases:
 * a transitive dependency, an unregistered direct dependency, a symlinked folder pointing outside
 * the package and a third-party package without compat must never contribute.
 */
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { BUILTIN_COMMANDS } from '../../src/console/commands/builtins.ts'
import { type AnyCommand, defineCommand } from '../../src/console/framework/command.ts'
import {
  enabledPackages,
  packageMigrations,
  packageOfSpecifier,
} from '../../src/console/project/package-migrations.ts'
import {
  addDependencies,
  cleanupTempDirs,
  cli,
  installFakePackage,
  makeProject,
  writeFiles,
} from './helpers.ts'

afterAll(cleanupTempDirs)

const VERSION = '0.1.0-next.0'
const SQL = { 'migrations/postgres/20260101000000_x.sql': 'CREATE TABLE x (id int)' }

/** A project whose strutvane.config.ts imports (enables) the given packages. */
function project(enabled: readonly string[]): string {
  const imports = enabled.map((name, i) => `import p${i} from '${name}/provider'`).join('\n')
  const list = enabled.map((_, i) => `p${i}`).join(', ')
  return makeProject({
    'strutvane.config.ts': `${imports}\nexport default { providers: [${list}] }\n`,
  })
}

const scan = (root: string) =>
  packageMigrations({ root, packageJson: { dependencies: depsOf(root) } }, VERSION)

function depsOf(root: string): Record<string, string> {
  const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return json.dependencies ?? {}
}

/** A command that reports what the runner's ctx.packageMigrations() returns. */
const probe: AnyCommand = defineCommand({
  name: 'probe',
  description: 'report package migrations',
  requiresProject: false,
  async run(ctx) {
    return { data: ctx.packageMigrations() }
  },
})

describe('which packages may contribute migrations', () => {
  test('an enabled first-party direct dependency contributes its real folder', async () => {
    const root = project(['@strutvane/auth'])
    const dir = installFakePackage(root, '@strutvane/auth', {
      strutvane: { migrations: './migrations' },
      files: SQL,
    })
    addDependencies(root, { '@strutvane/auth': VERSION })
    expect(scan(root)).toEqual({
      dirs: [{ package: '@strutvane/auth', dir: realpathSync(join(dir, 'migrations')) }],
      ignored: [],
    })
    const r = await cli(['probe', '--json'], {
      cwd: root,
      builtins: [...BUILTIN_COMMANDS, probe],
      version: VERSION,
    })
    expect(r.json().data).toEqual([
      { package: '@strutvane/auth', dir: realpathSync(join(dir, 'migrations')) },
    ])
  })

  test('attack: a transitive dependency with migrations is ignored', () => {
    const root = project(['@strutvane/sneaky'])
    // Installed (hoisted) into node_modules, enabled by name, but not in the app's package.json.
    installFakePackage(root, '@strutvane/sneaky', {
      strutvane: { migrations: './migrations' },
      files: SQL,
    })
    expect(scan(root)).toEqual({ dirs: [], ignored: [] })
  })

  test('attack: an unregistered direct dependency is ignored (and reported)', async () => {
    const root = project([])
    installFakePackage(root, '@strutvane/auth', {
      strutvane: { migrations: './migrations' },
      files: SQL,
    })
    installFakePackage(root, 'left-pad-evil', { strutvane: { migrations: './m' }, files: SQL })
    addDependencies(root, { '@strutvane/auth': VERSION, 'left-pad-evil': '1.0.0' })
    expect(scan(root)).toEqual({ dirs: [], ignored: ['@strutvane/auth', 'left-pad-evil'] })
    // Even imported in strutvane.config.ts, a package without a contributor name never contributes.
    const named = project(['left-pad-evil'])
    installFakePackage(named, 'left-pad-evil', { strutvane: { migrations: './m' }, files: SQL })
    addDependencies(named, { 'left-pad-evil': '1.0.0' })
    expect(scan(named).dirs).toEqual([])
    const doctor = await cli(['doctor', '--json'], { cwd: root, version: VERSION })
    const checks = (
      doctor.json().data as { checks: { id: string; status: string; message: string }[] }
    ).checks
    const warnings = checks.filter((c) => c.id === 'migrations')
    expect(warnings.map((c) => c.status)).toEqual(['warn', 'warn'])
    expect(warnings[0]?.message).toMatch(
      /@strutvane\/auth ships database migrations that are ignored/,
    )
  })

  test('attack: a symlinked migrations folder pointing outside the package is refused', async () => {
    const root = project(['@strutvane/linked'])
    writeFiles(root, { 'evil/postgres/20260101000000_evil.sql': 'DROP TABLE users' })
    const dir = installFakePackage(root, '@strutvane/linked', {
      strutvane: { migrations: './migrations' },
    })
    symlinkSync(join(root, 'evil'), join(dir, 'migrations'), 'junction')
    addDependencies(root, { '@strutvane/linked': VERSION })
    expect(() => scan(root)).toThrow(expect.objectContaining({ code: 'UNSAFE_CONTRIBUTION' }))
    const r = await cli(['probe', '--json'], {
      cwd: root,
      builtins: [...BUILTIN_COMMANDS, probe],
      version: VERSION,
    })
    expect(r.code).toBe(1)
    expect(r.json().error?.code).toBe('UNSAFE_CONTRIBUTION')
    const doctor = await cli(['doctor', '--json'], { cwd: root, version: VERSION })
    const checks = (doctor.json().data as { checks: { id: string; status: string }[] }).checks
    expect(checks.find((c) => c.id === 'migrations')?.status).toBe('fail')
  })

  test('attack: escaping, absolute and malformed declarations are refused', () => {
    for (const declared of ['../../..', '/etc', 'C:\\Windows', 42, '', 'a\0b']) {
      const root = project(['@strutvane/bad'])
      mkdirSync(join(root, 'outside'), { recursive: true })
      installFakePackage(root, '@strutvane/bad', { strutvane: { migrations: declared } })
      addDependencies(root, { '@strutvane/bad': VERSION })
      expect(() => scan(root), String(declared)).toThrow(
        expect.objectContaining({ code: 'UNSAFE_CONTRIBUTION' }),
      )
    }
  })

  test('attack: a third-party package without (or with a non-matching) compat is refused', () => {
    const root = project(['strutvane-plugin-crm'])
    installFakePackage(root, 'strutvane-plugin-crm', {
      strutvane: { migrations: './migrations' },
      files: SQL,
    })
    addDependencies(root, { 'strutvane-plugin-crm': '1.0.0' })
    expect(() => scan(root)).toThrow(expect.objectContaining({ code: 'MISSING_COMPAT' }))
    const wrong = project(['strutvane-plugin-crm'])
    installFakePackage(wrong, 'strutvane-plugin-crm', {
      strutvane: { migrations: './migrations', compat: '^9.0.0' },
      files: SQL,
    })
    addDependencies(wrong, { 'strutvane-plugin-crm': '1.0.0' })
    expect(() => scan(wrong)).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_PACKAGE' }))
    const good = project(['strutvane-plugin-crm'])
    installFakePackage(good, 'strutvane-plugin-crm', {
      strutvane: { migrations: './migrations', compat: '>=0.1.0-0' },
      files: SQL,
    })
    addDependencies(good, { 'strutvane-plugin-crm': '1.0.0' })
    expect(scan(good).dirs.map((d) => d.package)).toEqual(['strutvane-plugin-crm'])
  })

  test('a declared folder that does not exist contributes nothing; outside a project, nothing', async () => {
    const root = project(['@strutvane/auth'])
    installFakePackage(root, '@strutvane/auth', { strutvane: { migrations: './migrations' } })
    addDependencies(root, { '@strutvane/auth': VERSION })
    expect(scan(root)).toEqual({ dirs: [], ignored: [] })
    const outside = makeProject()
    const r = await cli(['probe', '--json'], {
      cwd: join(outside, '..'),
      builtins: [...BUILTIN_COMMANDS, probe],
    })
    expect(r.json().data).toEqual([])
  })

  test('enabled packages come from static value imports of strutvane.config.ts', () => {
    const root = makeProject({
      'strutvane.config.ts': [
        "import auth from '@strutvane/auth/provider'",
        "import { logs } from '@strutvane/logs'",
        "import type { X } from 'strutvane-plugin-types'",
        "import local from './app/providers/app.ts'",
        "import fs from 'node:fs'",
        '// import evil from "@strutvane/commented"',
        'export default { providers: [auth, logs] }',
      ].join('\n'),
    })
    expect([...enabledPackages(root)].sort()).toEqual(['@strutvane/auth', '@strutvane/logs'])
    expect(packageOfSpecifier('@strutvane/auth/provider')).toBe('@strutvane/auth')
    expect(packageOfSpecifier('plain/sub')).toBe('plain')
    expect(packageOfSpecifier('../x')).toBeUndefined()
    expect(packageOfSpecifier('node:fs')).toBeUndefined()
    expect(enabledPackages(join(root, 'missing')).size).toBe(0)
  })
})
