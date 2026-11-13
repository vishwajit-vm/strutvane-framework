/**
 * about, doctor, env:check, key:generate, registry:build/watch, routes, models, permissions.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordEjection } from '@strutvane/devkit'
import { afterAll, describe, expect, test } from 'vitest'
import { checkNode } from '../src/commands/doctor.ts'
import { generateAppKey } from '../src/commands/env.ts'
import type { RouteRow } from '../src/commands/inspect.ts'
import type { checkEnv } from '../src/project/env-check.ts'
import {
  addDependencies,
  cleanupTempDirs,
  cli,
  copyFixture,
  installFakePackage,
  makeProject,
  read,
  snapshotTree,
  tempDir,
  write,
} from './helpers.ts'

afterAll(cleanupTempDirs)

const EXAMPLE = [
  '# ─── Application ──────────────────────────────────────────────────',
  'APP_NAME=Demo',
  'APP_ENV=local',
  'APP_KEY=',
  'DATABASE_URL=postgres://localhost/demo',
  '',
].join('\n')

describe('about', () => {
  test('inside a project: versions, package manager and Strutvane packages', async () => {
    const root = makeProject(
      { 'pnpm-lock.yaml': '' },
      {
        dependencies: {
          '@strutvane/core': '0.1.0-next.0',
          '@strutvane/auth': '^0.1.0',
          lodash: '1',
        },
      },
    )
    installFakePackage(root, '@strutvane/core', { version: '0.1.0-next.0' })
    const r = await cli(['about', '--json'], { cwd: root, version: '0.1.0-next.0' })
    expect(r.code).toBe(0)
    expect(r.json().data).toMatchObject({
      cli: '0.1.0-next.0',
      project: { name: 'demo-app', root, packageManager: 'pnpm' },
      packages: [
        { name: '@strutvane/auth', declared: '^0.1.0', installed: null },
        { name: '@strutvane/core', declared: '0.1.0-next.0', installed: '0.1.0-next.0' },
      ],
    })
    const human = await cli(['about'], { cwd: root })
    expect(human.stdout).toContain('not installed')
    expect(human.stdout).toContain('Package manager')
  })

  test('outside a project', async () => {
    const r = await cli(['about'], { cwd: tempDir() })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('none (not inside a project)')
  })

  test('package manager detection: packageManager field, lockfiles, default npm', async () => {
    const pm = async (
      files: Record<string, string>,
      pkg: Record<string, unknown> = {},
    ): Promise<unknown> =>
      (
        (await cli(['about', '--json'], { cwd: makeProject(files, pkg) })).json().data as {
          project: { packageManager: string }
        }
      ).project.packageManager
    expect(await pm({}, { packageManager: 'yarn@4.0.0' })).toBe('yarn')
    expect(await pm({}, { packageManager: 'weird@1' })).toBe('npm')
    expect(await pm({ 'bun.lock': '' })).toBe('bun')
    expect(await pm({ 'yarn.lock': '' })).toBe('yarn')
    expect(await pm({ 'package-lock.json': '{}' })).toBe('npm')
    expect(await pm({})).toBe('npm')
  })
})

describe('env:check', () => {
  test('a complete .env passes', async () => {
    const root = makeProject({
      '.env.example': EXAMPLE,
      '.env': EXAMPLE.replace('APP_KEY=', 'APP_KEY=abc'),
    })
    const r = await cli(['env:check'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('.env matches .env.example')
  })

  test('missing keys are errors (exit 3); unknown and empty keys are warnings; values never printed', async () => {
    const root = makeProject({
      '.env.example': EXAMPLE,
      '.env': 'APP_NAME=Demo\nAPP_ENV=local\nAPP_KEY=\nEXTRA_SECRET=hunter2\n',
    })
    const r = await cli(['env:check', '--json'], { cwd: root })
    expect(r.code).toBe(3)
    expect(r.json().error?.code).toBe('ENV_PROBLEMS')
    expect(r.stdout).not.toContain('hunter2')
    const problems = (r.json().data as ReturnType<typeof checkEnv>).problems
    expect(problems.map((p) => [p.kind, p.key, p.severity])).toEqual([
      ['missing', 'DATABASE_URL', 'error'],
      ['unknown', 'EXTRA_SECRET', 'warning'],
      ['empty', 'APP_KEY', 'warning'],
    ])
  })

  test('--strict makes warnings errors; --env layers .env.<name>', async () => {
    const root = makeProject({
      '.env.example': 'A=1\nB=2\n',
      '.env': 'A=1\nB=\n',
      '.env.test': 'B=3\n',
    })
    expect((await cli(['env:check'], { cwd: root })).code).toBe(0)
    expect((await cli(['env:check', '--strict'], { cwd: root })).code).toBe(3)
    expect((await cli(['env:check', '--strict', '--env', 'test'], { cwd: root })).code).toBe(0)
    const bad = await cli(['env:check', '--env', '../../etc/passwd', '--json'], { cwd: root })
    expect(bad.code).toBe(2)
  })

  test('secrets with values in .env.example are errors; invalid lines and keys are reported', async () => {
    const root = makeProject({
      '.env.example': 'API_SECRET=leaked\nGOOD=1\nnot an assignment\n',
      '.env': 'API_SECRET=x\nGOOD=1\nGOOD=2\n1BAD=x\n',
    })
    const r = await cli(['env:check', '--json'], { cwd: root })
    const kinds = (r.json().data as ReturnType<typeof checkEnv>).problems.map((p) => p.kind)
    expect(kinds).toEqual(['secret-in-example', 'invalid-key', 'invalid-line', 'duplicate'])
    expect(r.stdout).not.toContain('leaked')
  })

  test('no .env.example: ENV_EXAMPLE_MISSING (exit 3)', async () => {
    const r = await cli(['env:check', '--json'], { cwd: makeProject({ '.env': 'A=1\n' }) })
    expect(r.code).toBe(3)
    expect(r.json().error?.code).toBe('ENV_EXAMPLE_MISSING')
  })

  test('warnings only: success with a count', async () => {
    const root = makeProject({ '.env.example': 'A=1\n', '.env': 'A=\n' })
    const r = await cli(['env:check'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('No errors (1 warning(s))')
  })
})

describe('key:generate', () => {
  test('creates APP_KEY in .env and an empty entry in .env.example', async () => {
    const root = makeProject()
    const r = await cli(['key:generate', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    const env = read(root, '.env')
    const key = /APP_KEY=(\S+)/.exec(env)?.[1] ?? ''
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(read(root, '.env.example')).toMatch(/^APP_KEY=$/m)
    expect(r.stdout).not.toContain(key)
    expect(r.json().data).toEqual({ written: true, dryRun: false, files: ['.env', '.env.example'] })
  })

  test('fills an empty APP_KEY in place, keeping the rest of .env', async () => {
    const root = makeProject({
      '.env': 'APP_NAME=Demo\nAPP_KEY=\nDB=x\n',
      '.env.example': 'APP_KEY=\n',
    })
    expect((await cli(['key:generate'], { cwd: root })).code).toBe(0)
    expect(read(root, '.env')).toMatch(/^APP_NAME=Demo\nAPP_KEY=[A-Za-z0-9_-]{43}\nDB=x\n$/)
  })

  test('an existing key is a conflict (exit 4) unless --force', async () => {
    const root = makeProject({ '.env': 'APP_KEY=old\n' })
    const r = await cli(['key:generate', '--json'], { cwd: root })
    expect(r.code).toBe(4)
    expect(r.json().error?.code).toBe('KEY_EXISTS')
    expect(read(root, '.env')).toBe('APP_KEY=old\n')
    const forced = await cli(['key:generate', '--force', '--json'], { cwd: root })
    expect(forced.code).toBe(0)
    expect(read(root, '.env')).not.toContain('APP_KEY=old')
    expect(forced.json().warnings[0]).toContain('previous key was replaced')
  })

  test('--dry-run writes nothing and never shows the key; --show prints a key and writes nothing', async () => {
    const root = makeProject()
    const before = snapshotTree(root)
    const dry = await cli(['key:generate', '--dry-run'], { cwd: root })
    expect(dry.stdout).toContain('would update .env')
    expect(snapshotTree(root)).toEqual(before)
    const show = await cli(['key:generate', '--show'], { cwd: root })
    expect(show.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/)
    expect(snapshotTree(root)).toEqual(before)
    const showJson = await cli(['key:generate', '--show', '--json'], { cwd: tempDir() })
    expect(showJson.json().data).toMatchObject({ written: false })
    expect(generateAppKey()).not.toBe(generateAppKey())
  })
})

describe('doctor', () => {
  test('a healthy project passes', async () => {
    const root = makeProject(
      { '.env.example': 'A=1\n', '.env': 'A=1\n', '.gitignore': 'node_modules\n.env\n' },
      { devDependencies: { '@strutvane/cli': '0.1.0' } },
    )
    installFakePackage(root, '@strutvane/cli', { version: '0.1.0' })
    const r = await cli(['doctor', '--json'], { cwd: root })
    expect(r.code, r.stdout).toBe(0)
    const ids = (r.json().data as { checks: { id: string; status: string }[] }).checks
    expect(ids.every((c) => c.status === 'ok')).toBe(true)
  })

  test('failures exit 3 with every check in the data', async () => {
    const root = makeProject(
      { '.env.example': 'A=1\n' },
      {
        type: 'commonjs',
        dependencies: {
          '@strutvane/core': '0.1.0',
          '@strutvane/auth': '0.2.0',
          '@strutvane/ui': '0.1.0',
        },
      },
    )
    installFakePackage(root, '@strutvane/core', { version: '0.1.0' })
    installFakePackage(root, '@strutvane/auth', { version: '0.2.0' })
    const r = await cli(['doctor', '--json'], { cwd: root })
    expect(r.code).toBe(3)
    expect(r.json().error?.code).toBe('DOCTOR_FAILED')
    const checks = (r.json().data as { checks: { id: string; status: string; message: string }[] })
      .checks
    const status = Object.fromEntries(checks.map((c) => [c.id, c.status]))
    expect(status).toMatchObject({
      node: 'ok',
      esm: 'warn',
      'cli-local': 'warn',
      installed: 'fail',
      'release-train': 'warn',
      env: 'fail',
      'env-ignored': 'fail',
    })
    const human = await cli(['doctor'], { cwd: root })
    expect(human.stdout).toContain('✖ .env is missing')
    expect(human.stderr).toContain('check')
  })

  test('env errors, registry state, lock conflicts and plugins', async () => {
    const root = makeProject({
      '.env.example': 'A=1\nB=2\n',
      '.env': 'A=1\n',
      '.gitignore': '.env*\n',
    })
    write(
      root,
      'app/models/tag.model.ts',
      "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Tag', { name: field.string() })\n",
    )
    const checks = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as {
        checks: { id: string; status: string; message: string }[]
      }
    ).checks
    expect(checks.find((c) => c.id === 'env')).toMatchObject({
      status: 'fail',
      message: '1 env problem(s): B',
    })
    expect(checks.find((c) => c.id === 'registry')).toMatchObject({
      status: 'warn',
      message: '.strutvane/registry.gen.ts has not been built',
    })

    await cli(['registry:build'], { cwd: root })
    const after = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as { checks: typeof checks }
    ).checks
    expect(after.find((c) => c.id === 'registry')?.status).toBe('ok')

    writeFileSync(
      join(root, '.strutvane/registry.gen.ts'),
      `${read(root, '.strutvane/registry.gen.ts')}// edit\n`,
    )
    const edited = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as { checks: typeof checks }
    ).checks
    expect(edited.find((c) => c.id === 'registry')?.message).toContain('edited by hand')

    write(
      root,
      'app/models/post.model.ts',
      "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Post', { title: field.string() })\n",
    )
    await cli(['registry:build'], { cwd: root })
    write(
      root,
      'app/models/post.model.ts',
      "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Post', { title: field.string(), body: field.text() })\n",
    )
    const stale = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as { checks: typeof checks }
    ).checks
    expect(stale.find((c) => c.id === 'registry')?.message).toContain('out of date')

    write(root, 'app/models/bad.model.ts', 'export default 1\n')
    const broken = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as { checks: typeof checks }
    ).checks
    expect(broken.find((c) => c.id === 'registry')?.status).toBe('fail')
    rmSync(join(root, 'app/models/bad.model.ts'))

    await recordEjection({
      projectRoot: root,
      outputs: [{ path: 'app/x.ts', template: 't', version: '1.0.0', content: 'x\n' }],
    })
    write(root, 'app/x.ts', '<<<<<<< yours\na\n=======\nb\n>>>>>>> theirs\n')
    const conflicted = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as { checks: typeof checks }
    ).checks
    expect(conflicted.find((c) => c.id === 'lock')).toMatchObject({ status: 'fail' })
    writeFileSync(join(root, '.strutvane/lock.json'), '{ broken')
    const unreadable = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as { checks: typeof checks }
    ).checks
    expect(unreadable.find((c) => c.id === 'lock')?.message).toContain('unreadable')

    addDependencies(root, {
      'strutvane-plugin-a': '1',
      'strutvane-plugin-b': '1',
      'strutvane-plugin-c': '1',
    })
    installFakePackage(root, 'strutvane-plugin-a', {
      strutvane: { commands: './c.mjs', compat: '^99.0.0' },
      files: { 'c.mjs': '' },
    })
    installFakePackage(root, 'strutvane-plugin-b', {
      strutvane: { commands: './c.mjs' },
      files: { 'c.mjs': 'export default []' },
    })
    installFakePackage(root, 'strutvane-plugin-c', {
      strutvane: { commands: './c.mjs' },
      files: { 'c.mjs': "export default { name: 'c:x', description: 'x', run() {} }" },
    })
    const plugins = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as { checks: typeof checks }
    ).checks.filter((c) => c.id === 'plugins')
    expect(plugins.map((c) => c.status)).toEqual(['fail', 'warn'])
  })

  test('--global checks only the machine; without it, a project is required', async () => {
    const r = await cli(['doctor', '--global', '--json'], { cwd: tempDir() })
    expect(r.code).toBe(0)
    expect((r.json().data as { checks: unknown[] }).checks).toHaveLength(1)
    expect((await cli(['doctor', '--json'], { cwd: tempDir() })).json().error?.code).toBe(
      'PROJECT_NOT_FOUND',
    )
  })

  test('checkNode', () => {
    expect(checkNode('24.0.0').status).toBe('ok')
    expect(checkNode('22.11.0')).toMatchObject({ status: 'fail' })
    expect(checkNode('garbage').status).toBe('fail')
  })

  test('a contributed-command count is reported when plugins load cleanly', async () => {
    const root = makeProject({ '.gitignore': '/.env\n' })
    addDependencies(root, { 'strutvane-plugin-ok': '1' })
    installFakePackage(root, 'strutvane-plugin-ok', {
      strutvane: { commands: './c.mjs' },
      files: { 'c.mjs': "export default { name: 'ok:x', description: 'x', run() {} }" },
    })
    const checks = (
      (await cli(['doctor', '--json'], { cwd: root })).json().data as {
        checks: { id: string; message: string }[]
      }
    ).checks
    expect(checks.find((c) => c.id === 'plugins')?.message).toBe('1 contributed command(s) loaded')
  })
})

describe('registry:build / registry:watch', () => {
  test('builds the fixture app deterministically and reports counts', async () => {
    const root = copyFixture()
    const r = await cli(['registry:build', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.json().data).toMatchObject({
      ok: true,
      written: true,
      counts: { models: 5, resources: 2, policies: 2, routes: 2, pages: 4 },
    })
    const first = read(root, '.strutvane/registry.gen.ts')
    const again = await cli(['registry:build', '--json'], { cwd: root })
    expect(again.json().data).toMatchObject({ written: false })
    expect(read(root, '.strutvane/registry.gen.ts')).toBe(first)
    expect(first).toContain('// @generated by @strutvane/cli ')
    const human = await cli(['registry:build'], { cwd: root })
    expect(human.stdout).toContain('Up to date: .strutvane/registry.gen.ts')
  })

  test('--check exits 6 when stale and writes nothing; --dry-run reports', async () => {
    const root = copyFixture()
    const stale = await cli(['registry:build', '--check', '--json'], { cwd: root })
    expect(stale.code).toBe(6)
    expect(stale.json().error?.code).toBe('REGISTRY_STALE')
    expect(existsSync(join(root, '.strutvane/registry.gen.ts'))).toBe(false)
    const dry = await cli(['registry:build', '--dry-run'], { cwd: root })
    expect(dry.stdout).toContain('would be updated (dry run)')
    await cli(['registry:build'], { cwd: root })
    expect((await cli(['registry:build', '--check'], { cwd: root })).code).toBe(0)
  })

  test('errors exit 3, are listed, and nothing is written', async () => {
    const root = copyFixture()
    write(
      root,
      'app/models/dup.model.ts',
      "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Invoice', { a: field.string() })\n",
    )
    write(root, 'app/models/Customer2.model.ts', 'export default 5\n')
    const r = await cli(['registry:build', '--json'], { cwd: root })
    expect(r.code).toBe(3)
    expect(r.json().error).toMatchObject({ code: 'REGISTRY_ERRORS' })
    const human = await cli(['registry:build'], { cwd: root })
    expect(human.stdout).toContain('DUPLICATE_MODEL')
    expect(human.stderr).toContain('FILE_NAME_MISMATCH')
    expect(existsSync(join(root, '.strutvane/registry.gen.ts'))).toBe(false)
  })

  test('registry:watch builds, reacts to changes and stops on abort', async () => {
    const root = copyFixture()
    const controller = new AbortController()
    const running = cli(['registry:watch', '--debounce', '5', '--json'], {
      cwd: root,
      signal: controller.signal,
    })
    const output = join(root, '.strutvane/registry.gen.ts')
    const deadline = Date.now() + 10_000
    while (!existsSync(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    write(
      root,
      'app/models/note.model.ts',
      "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Note', { body: field.text() })\n",
    )
    while (!readFileSync(output, 'utf8').includes('"Note"') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20))
    write(root, 'app/models/broken.model.ts', 'export default 1\n')
    await new Promise((r) => setTimeout(r, 300))
    controller.abort()
    const r = await running
    expect(r.code).toBe(0)
    expect(readFileSync(output, 'utf8')).toContain('"Note"')
    expect((r.json().data as { builds: number }).builds).toBeGreaterThanOrEqual(2)
  })

  test('registry:watch validates --debounce and stops at once if already aborted', async () => {
    const root = copyFixture()
    expect((await cli(['registry:watch', '--debounce', 'soon'], { cwd: root })).code).toBe(2)
    const controller = new AbortController()
    controller.abort()
    const r = await cli(['registry:watch'], { cwd: root, signal: controller.signal })
    expect(r.code).toBe(0)
  })
})

describe('routes / models / permissions', () => {
  test('routes: automatic CRUD, resource actions and custom routes', async () => {
    const root = copyFixture()
    const r = await cli(['routes', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    const routes = (r.json().data as { routes: RouteRow[] }).routes
    const find = (method: string, path: string): RouteRow | undefined =>
      routes.find((x) => x.method === method && x.path === path)
    expect(find('GET', '/api/v1/invoices')).toMatchObject({
      name: 'invoices.index',
      permission: 'invoice.viewAny',
      source: 'auto',
    })
    expect(find('DELETE', '/api/v1/invoices/:id/force')).toMatchObject({
      permission: 'invoice.forceDelete',
    })
    expect(find('POST', '/api/v1/invoices/:id/actions/approve')).toMatchObject({
      permission: 'invoice.approve',
      source: 'resource',
    })
    expect(find('POST', '/api/v1/invoices/:id/actions/send')).toMatchObject({
      permission: 'invoice.send',
    })
    expect(find('POST', '/reports/revenue')).toMatchObject({
      name: 'reports.revenue',
      permission: 'report.revenue',
      source: 'custom',
    })
    expect(find('GET', '/health')).toMatchObject({ permission: null })
    expect(find('GET', '/api/v1/invoice-lines')).toBeDefined()
  })

  test('routes filters and human table', async () => {
    const root = copyFixture()
    const r = await cli(['routes', '--model', 'Invoice', '--method', 'post', '--json'], {
      cwd: root,
    })
    const routes = (r.json().data as { routes: RouteRow[] }).routes
    expect(routes.every((x) => x.method === 'POST' && x.model === 'Invoice')).toBe(true)
    expect(routes.length).toBe(4)
    const byPath = await cli(['routes', '--path', 'health', '--json'], { cwd: root })
    expect((byPath.json().data as { routes: RouteRow[] }).routes).toHaveLength(1)
    const human = await cli(['routes'], { cwd: root })
    expect(human.stdout).toMatch(/Method +Path +Name +Permission +Source/)
    expect(human.stdout).toContain('(public)')
  })

  test('models with fields, relations and options; --api false hides CRUD routes', async () => {
    const root = copyFixture()
    const r = await cli(['models', '--model', 'Invoice', '--json'], { cwd: root })
    expect((r.json().data as { models: unknown[] }).models).toEqual([
      {
        name: 'Invoice',
        file: 'app/models/invoice.model.ts',
        fields: [
          { name: 'number', type: 'string', target: null },
          { name: 'customer', type: 'belongsTo', target: 'Customer' },
          { name: 'amount', type: 'decimal', target: null },
          { name: 'status', type: 'enum', target: null },
          { name: 'dueDate', type: 'date', target: null },
          { name: 'lines', type: 'hasMany', target: 'InvoiceLine' },
        ],
        softDeletes: true,
        tenant: true,
        api: true,
        resource: 'app/resources/invoice.resource.ts',
        policy: 'app/policies/invoice.policy.ts',
      },
    ])
    write(
      root,
      'app/models/setting.model.ts',
      "import { defineModel, field } from '@strutvane/framework'\nexport default defineModel('Setting', { key: field.string(), value: helper() }, { api: false })\n",
    )
    const human = await cli(['models'], { cwd: root })
    expect(human.stdout).toContain('Setting app/models/setting.model.ts (no api)')
    expect(human.stdout).toMatch(/value +\?/)
    const routes = (await cli(['routes', '--model', 'Setting', '--json'], { cwd: root })).json()
      .data as { routes: RouteRow[] }
    expect(routes.routes).toEqual([])
  })

  test('permissions, filtered by model', async () => {
    const root = copyFixture()
    const all = (await cli(['permissions', '--json'], { cwd: root })).json().data as {
      permissions: string[]
    }
    expect(all.permissions).toContain('report.revenue')
    expect(all.permissions).toContain('invoice.approve')
    const invoice = (
      await cli(['permissions', '--model', 'Invoice', '--json'], { cwd: root })
    ).json().data as { permissions: string[] }
    expect(invoice.permissions.every((p) => p.startsWith('invoice.'))).toBe(true)
    expect((await cli(['permissions'], { cwd: root })).stdout).toContain('invoice.viewAny\n')
  })

  test('registry errors make these commands fail with the diagnostics as issues (exit 3)', async () => {
    const root = copyFixture()
    write(root, 'app/models/zzz.model.ts', 'export default 1\n')
    const r = await cli(['routes', '--json'], { cwd: root })
    expect(r.code).toBe(3)
    expect(r.json().error?.issues?.[0]).toMatchObject({
      path: ['app/models/zzz.model.ts'],
      code: 'UNEXPECTED_DEFAULT_EXPORT',
    })
  })
})
