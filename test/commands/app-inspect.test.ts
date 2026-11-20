/**
 * `doctor`, `models`, `permissions`, `registry:build` and `design:use` on an application
 * (`bootstrap/app.ts`, no `strutvane.config.ts`), reproducing the demo acceptance run:
 *
 * - FW-11: `doctor` failed with "The registry has 1 error(s)" and a warning to enable auth "in
 *   strutvane.config.ts"; `models` / `permissions` failed with `unknown_model` or
 *   `unexpected_default_export`, because all of them compiled the v1 registry.
 * - FW-14 / INST-2: the installer and `config/ui.ts` tell people to run `node strut design:use`,
 *   which did not exist.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cli, fakeSpawner } from '../console/helpers.ts'
import { appFolder, cleanupFolders, sourceUrl, testEnv, writeFiles } from './helpers.ts'

afterEach(cleanupFolders)

const env = { APP_ENV: 'testing' }

/** `.strutvane/resources.json` for customers (with a policy) and orders (without one). */
const RESOURCES = {
  version: 1,
  internal: ['users'],
  resources: [
    {
      table: 'customers',
      model: 'Customer',
      route: 'customers',
      label: { singular: 'Customer', plural: 'Customers' },
      primaryKey: 'id',
      titleField: 'email',
      timestamps: true,
      softDeletes: false,
      defaultSort: '-created_at',
      perPage: 25,
      relations: [],
      sidebar: { order: 1, hidden: false },
      fields: [
        { name: 'id', label: 'Id', kind: 'id', cast: 'integer', hidden: false },
        { name: 'email', label: 'Email', kind: 'string', cast: 'string', hidden: false },
        { name: 'api_token', label: 'Token', kind: 'string', cast: 'string', hidden: true },
      ],
    },
    {
      table: 'orders',
      model: 'Order',
      route: 'orders',
      label: { singular: 'Order', plural: 'Orders' },
      primaryKey: 'id',
      titleField: 'id',
      timestamps: true,
      softDeletes: true,
      defaultSort: '-created_at',
      perPage: 25,
      relations: [],
      sidebar: { order: 2, hidden: false },
      tenant: 'tenant_id',
      fields: [
        {
          name: 'customer_id',
          label: 'Customer',
          kind: 'foreignId',
          cast: 'integer',
          hidden: false,
          references: 'customers',
        },
      ],
    },
  ],
}

/** A real app: an ability used by a route, a Customer policy, and resources.json. */
function inspectableApp(extra: Record<string, string> = {}): string {
  const root = appFolder()
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'northwind', type: 'module', private: true }),
    '.env': Object.entries(testEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    'bootstrap/app.ts': `import { dirname } from 'node:path'
import { Application } from '${sourceUrl('foundation/application.ts')}'
import { defineConfig } from '${sourceUrl('foundation/config.ts')}'
import { defineRoutes, Route } from '${sourceUrl('routing/route.ts')}'

const app = defineConfig((env) => ({
  name: 'Northwind',
  env: env.string('APP_ENV', 'production'),
  debug: false,
  url: env.string('APP_URL', 'http://localhost'),
  key: env.string('APP_KEY'),
}))

export default Application.configure({ basePath: dirname(import.meta.dirname) })
  .withConfig({ app })
  .withRouting({
    api: defineRoutes([
      Route.get('/customers', (ctx) => ctx.json([])).middleware('auth', 'can:manage-customers'),
    ]),
  })
  .withMiddleware((m) => m.defineAbility('manage-customers', () => true))
  .create()
`,
    'app/models/customer.ts': 'export {}\n',
    'app/policies/customer.policy.ts': `export default class CustomerPolicy {
  viewAny() { return true }
  update() { return false }
}
`,
    '.strutvane/resources.json': JSON.stringify(RESOURCES),
    ...extra,
  })
  return root
}

describe('models on an application (FW-11)', () => {
  it('lists the models of resources.json with their model and policy files', async () => {
    const root = inspectableApp()
    const run = await cli(['models', '--json'], { cwd: root, env })
    expect(run.code).toBe(0)
    const models = (run.json().data as { models: Record<string, unknown>[] }).models
    expect(models).toMatchObject([
      {
        name: 'Customer',
        table: 'customers',
        file: 'app/models/customer.ts',
        policy: 'app/policies/customer.policy.ts',
        softDeletes: false,
        tenant: false,
      },
      { name: 'Order', file: null, policy: null, softDeletes: true, tenant: true },
    ])
    // Hidden fields stay hidden; foreign keys name their table.
    expect(models[0]?.['fields']).toEqual([
      { name: 'id', type: 'id', target: null },
      { name: 'email', type: 'string', target: null },
    ])
    expect(models[1]?.['fields']).toEqual([
      { name: 'customer_id', type: 'foreignId', target: 'customers' },
    ])
    const text = await cli(['models', '--model', 'Order'], { cwd: root, env })
    expect(text.stdout).toContain('none: every action is denied')
    expect(text.stdout).not.toContain('Customer')
  })

  it('says how to generate resources.json when it is missing', async () => {
    const root = inspectableApp({ '.strutvane/resources.json': 'not json' })
    const run = await cli(['models'], { cwd: root, env })
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('node strut migrate')
  })
})

describe('permissions on an application (FW-11)', () => {
  it('lists abilities with their routes, policy abilities, and models denied by default', async () => {
    const root = inspectableApp()
    const run = await cli(['permissions', '--json'], { cwd: root, env })
    expect(run.code).toBe(0)
    const data = run.json().data as {
      permissions: string[]
      rows: { permission: string; kind: string; source: string; routes: string[] }[]
    }
    expect(data.permissions).toEqual([
      'manage-customers',
      'Customer.update',
      'Customer.viewAny',
      'Order.*',
    ])
    expect(data.rows[0]?.routes).toEqual(['GET /api/customers'])
    expect(data.rows[1]?.source).toBe('app/policies/customer.policy.ts')
    expect(data.rows[3]).toMatchObject({ kind: 'denied' })
    // A new folder: each node strut command is its own process, and an app imported once is
    // cached by the module loader.
    const only = await cli(['permissions', '--model', 'Customer', '--json'], {
      cwd: inspectableApp(),
      env,
    })
    expect((only.json().data as { permissions: string[] }).permissions).toEqual([
      'Customer.update',
      'Customer.viewAny',
    ])
  })
})

describe('doctor and registry:build on an application (FW-11)', () => {
  it('checks that the app boots instead of compiling a v1 registry', async () => {
    const root = inspectableApp({
      '.gitignore': '.env\n',
      '.env.example': Object.keys(testEnv)
        .map((key) => `${key}=`)
        .join('\n'),
    })
    const run = await cli(['doctor', '--json'], { cwd: root, env })
    const checks = (run.json().data as { checks: { id: string; status: string }[] }).checks
    const ids = checks.map((check) => check.id)
    expect(ids).toContain('app-boots')
    expect(ids).not.toContain('registry')
    expect(checks.find((check) => check.id === 'app-boots')?.status).toBe('ok')
    expect(checks.find((check) => check.id === 'resources')?.status).toBe('ok')
    expect(JSON.stringify(checks)).not.toContain('strutvane.config.ts')
  })

  it('fails when the app does not boot, with the boot error and its hint', async () => {
    const root = inspectableApp({ '.env': 'APP_ENV=testing\nAPP_KEY=weak\n' })
    const run = await cli(['doctor', '--json'], { cwd: root, env })
    expect(run.code).toBe(3)
    const checks = (run.json().data as { checks: { id: string; status: string; hint?: string }[] })
      .checks
    const boot = checks.find((check) => check.id === 'app-boots')
    expect(boot?.status).toBe('fail')
    expect(boot?.hint).toBeTruthy()
  })

  it('warns about an add-on installed but not registered in bootstrap/providers.ts (AUTH-2)', async () => {
    const auth = {
      'node_modules/@strutvane/auth/package.json': JSON.stringify({
        name: '@strutvane/auth',
        version: '0.2.0-next.1',
        exports: { '.': './index.js', './provider': './provider.js' },
      }),
    }
    const root = inspectableApp({
      ...auth,
      'package.json': JSON.stringify({
        name: 'northwind',
        type: 'module',
        dependencies: { '@strutvane/auth': '^0.2.0-next.1' },
      }),
    })
    const checksOf = async (): Promise<{ id: string; message: string; hint?: string }[]> =>
      (
        (await cli(['doctor', '--json'], { cwd: root, env })).json().data as {
          checks: { id: string; message: string; hint?: string }[]
        }
      ).checks
    const missing = (await checksOf()).find((check) => check.id === 'providers')
    expect(missing?.message).toContain(
      '@strutvane/auth is installed but its provider is not registered',
    )
    expect(missing?.hint).toContain("import auth from '@strutvane/auth/provider'")
    writeFiles(root, {
      'bootstrap/providers.ts':
        "import auth from '@strutvane/auth/provider'\nexport default [auth]\n",
    })
    expect((await checksOf()).some((check) => check.id === 'providers')).toBe(false)
  })

  it('registry:build explains that an application has no registry', async () => {
    const run = await cli(['registry:build'], { cwd: inspectableApp(), env })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('node strut migrate')
  })
})

/** An app with the admin UI on the crisp design, as create-strutvane writes it. */
function uiApp(): string {
  return inspectableApp({
    'package.json': JSON.stringify({
      name: 'northwind',
      type: 'module',
      dependencies: { '@strutvane/design-crisp': '^0.2.0-next.0' },
    }),
    'package-lock.json': '{}',
    'node_modules/@strutvane/design-crisp/package.json': JSON.stringify({
      name: '@strutvane/design-crisp',
      version: '0.2.0-next.0',
    }),
    'config/ui.ts': "export default {\n  design: 'crisp',\n  appearance: 'system',\n}\n",
    'resources/ui/main.tsx':
      "import * as designs from '@strutvane/design-crisp'\nconst design = designs['crisp']\n",
    'resources/ui/theme.css': ':root { --brand: red; }\n',
    'strutvane.json': JSON.stringify(
      { ui: { design: 'crisp' }, packages: ['@strutvane/design-crisp'] },
      null,
      2,
    ),
  })
}

const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8')

describe('design:use (FW-14)', () => {
  it('installs the design, points config/ui.ts and main.tsx at it, and removes the old one', async () => {
    const root = uiApp()
    const spawn = fakeSpawner()
    const run = await cli(['design:use', 'vivid'], { cwd: root, env, spawn })
    expect(run.code).toBe(0)
    expect(spawn.calls.map((call) => [call.command, ...call.args].join(' '))).toEqual([
      expect.stringMatching(/^npm (install|add|i) @strutvane\/design-vivid/),
      expect.stringMatching(/^npm (uninstall|remove|rm) @strutvane\/design-crisp$/),
    ])
    expect(read(root, 'config/ui.ts')).toContain("design: 'vivid'")
    expect(read(root, 'resources/ui/main.tsx')).toBe(
      "import * as designs from '@strutvane/design-vivid'\nconst design = designs['vivid']\n",
    )
    expect(JSON.parse(read(root, 'strutvane.json'))).toEqual({
      ui: { design: 'vivid' },
      packages: ['@strutvane/design-vivid'],
    })
    // The app's own overrides are never touched.
    expect(read(root, 'resources/ui/theme.css')).toBe(':root { --brand: red; }\n')
  })

  it('changes nothing when the install fails, or on a dry run', async () => {
    const root = uiApp()
    const failing = fakeSpawner(() => ({ code: 1 }))
    expect((await cli(['design:use', 'vivid'], { cwd: root, env, spawn: failing })).code).not.toBe(
      0,
    )
    expect(read(root, 'config/ui.ts')).toContain("design: 'crisp'")
    const spawn = fakeSpawner()
    const dry = await cli(['design:use', 'vivid', '--dry-run'], { cwd: root, env, spawn })
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('would update config/ui.ts')
    expect(spawn.calls).toEqual([])
    expect(read(root, 'resources/ui/main.tsx')).toContain('design-crisp')
  })

  it('refuses an unknown design, does nothing when already in use, and needs a UI', async () => {
    const root = uiApp()
    const spawn = fakeSpawner()
    const unknown = await cli(['design:use', '../../evil'], { cwd: root, env, spawn })
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('crisp, vivid')
    const same = await cli(['design:use', 'crisp'], { cwd: root, env, spawn })
    expect(same.code).toBe(0)
    expect(same.stdout).toContain('already uses the crisp design')
    expect(spawn.calls).toEqual([])
    const apiOnly = await cli(['design:use', 'vivid'], { cwd: inspectableApp(), env, spawn })
    expect(apiOnly.code).toBe(3)
    expect(apiOnly.stderr).toContain('config/ui.ts')
  })
})
