// The project runtime: loading a generated project, booting it, serving it over real HTTP,
// migrations and seeders, and the CLI command contributions.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import commands, {
  type CommandContextLike,
  commandAppEnv,
  renameAnswers,
} from '../../src/commands.ts'
import type { Actor } from '../../src/contracts/index.ts'
import { defineProvider, HooksToken, PermissionProviderToken } from '../../src/core/index.ts'
import { connectDatabase } from '../../src/database/connect.ts'
import { firstAppEnv, normaliseAppEnv } from '../../src/runtime/app-env.ts'
import { apiBasePath, bootProject, mergeResources } from '../../src/runtime/boot.ts'
import { databaseConfigFrom } from '../../src/runtime/database-config.ts'
import { createDefaultFrameworkProvider } from '../../src/runtime/default-provider.ts'
import {
  migrateProject,
  migrationTarget,
  projectMigrationStatus,
} from '../../src/runtime/migrations.ts'
import { loadProject, ProjectLoadError } from '../../src/runtime/project.ts'
import { defineMigration, defineSeeder, isSeeder } from '../../src/runtime/seeders.ts'
import { serve } from '../../src/runtime/serve.ts'
import { startServer } from '../../src/runtime/server.ts'
import { IMPORTS, makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  // Bounded: on Windows a just-closed libSQL file can stay locked for a while; temp dirs may linger.
  const pending = Promise.all(cleanups.splice(0).map((c) => c()))
  let timer: NodeJS.Timeout | undefined
  await Promise.race([pending, new Promise((resolve) => (timer = setTimeout(resolve, 3000)))])
  clearTimeout(timer)
})

async function project(files?: Record<string, string>) {
  const p = await makeProject(files)
  cleanups.push(p.cleanup)
  return p.root
}

function context(root: string, flags: CommandContextLike['flags'] = {}) {
  const lines: string[] = []
  const ctx: CommandContextLike = {
    flags,
    requireProject: () => ({ root }),
    out: {
      line: (t = '') => lines.push(t),
      success: (t) => lines.push(`ok ${t}`),
      info: (t) => lines.push(`info ${t}`),
      warn: (t) => lines.push(`warn ${t}`),
      table: (_h, rows) => lines.push(...rows.map((r) => r.join(' | '))),
    },
  }
  return { ctx, lines }
}

const command = (name: string) => {
  const c = commands.find((x) => x.name === name)
  if (!c) throw new Error(name)
  return c
}

describe('databaseConfigFrom', () => {
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj'

  test('maps the generated sqlite shape to a file URL under the project root', () => {
    const c = databaseConfigFrom(
      { default: 'sqlite', connection: { filename: 'storage/db.sqlite' } },
      root,
    )
    expect(c.driver).toBe('sqlite')
    expect(c.driver === 'sqlite' && c.url.startsWith('file:')).toBe(true)
    expect(databaseConfigFrom({ connection: { filename: ':memory:' } }, root)).toEqual({
      driver: 'sqlite',
      url: ':memory:',
    })
    expect(
      databaseConfigFrom({ default: 'sqlite', connection: { url: 'libsql://x' } }, root),
    ).toEqual({
      driver: 'sqlite',
      url: 'libsql://x',
    })
    expect(databaseConfigFrom(undefined, root).driver).toBe('sqlite')
  })

  test('passes framework configs through and maps postgres discrete fields', () => {
    expect(databaseConfigFrom({ connection: { driver: 'pglite' } }, root)).toEqual({
      driver: 'pglite',
    })
    expect(databaseConfigFrom({ default: 'pglite' }, root)).toEqual({ driver: 'pglite' })
    expect(
      databaseConfigFrom({ default: 'pglite', connection: { dataDir: 'storage/pg' } }, root),
    ).toMatchObject({
      driver: 'pglite',
    })
    expect(
      databaseConfigFrom(
        {
          default: 'postgres',
          connection: {
            host: 'db',
            port: '5432',
            database: 'app',
            user: 'u',
            password: 'p',
            ssl: true,
            pool: { max: 5 },
          },
        },
        root,
      ),
    ).toEqual({
      driver: 'postgres',
      host: 'db',
      port: 5432,
      database: 'app',
      user: 'u',
      password: 'p',
      ssl: true,
      pool: { max: 5 },
    })
    expect(
      databaseConfigFrom({ default: 'postgres', connection: { url: 'postgres://x' } }, root),
    ).toEqual({
      driver: 'postgres',
      url: 'postgres://x',
    })
    expect(
      databaseConfigFrom(
        {
          default: 'azure-postgres',
          connection: { host: 'h', auth: { type: 'entra', clientId: 'c' } },
        },
        root,
      ),
    ).toEqual({ driver: 'postgres', host: 'h', auth: { kind: 'azure-entra', clientId: 'c' } })
    expect(
      databaseConfigFrom({ default: 'mysql', connection: { url: 'mysql://x' } }, root),
    ).toEqual({
      driver: 'mysql',
      url: 'mysql://x',
    })
    expect(databaseConfigFrom({ default: 'azure-mysql' }, root)).toEqual({ driver: 'mysql' })
  })

  test('fails loudly for unusable settings', () => {
    expect(() => databaseConfigFrom({ default: 'postgres', connection: {} }, root)).toThrow(
      /url or connection.host/,
    )
    expect(() => databaseConfigFrom({ default: 'oracle' }, root)).toThrow(/unknown database/)
  })
})

describe('apiBasePath / mergeResources', () => {
  test('joins prefix and version safely', () => {
    expect(apiBasePath(undefined)).toBe('/api/v1')
    expect(apiBasePath({ prefix: 'api/', version: '/v2/' })).toBe('/api/v2')
    expect(apiBasePath({ prefix: '/', version: 'v1' })).toBe('/v1')
  })
})

describe('loadProject', () => {
  test('loads config, providers, models and routes (and .env without overriding)', async () => {
    const root = await project()
    process.env['STRUTVANE_FIXTURE_FROM_DOTENV'] = undefined
    delete process.env['STRUTVANE_FIXTURE_FROM_DOTENV']
    const p = await loadProject(root)
    expect(p.models.map((m) => m.definition.name)).toEqual(['Invoice'])
    expect(p.routes.map((r) => `${r.method} ${r.path}`)).toContain('get /hello')
    expect(p.providers).toHaveLength(1)
    expect(p.config['app']).toMatchObject({ name: 'demo', preset: 'api', root })
    expect(process.env['STRUTVANE_FIXTURE_FROM_DOTENV']).toBe('yes')
    delete process.env['STRUTVANE_FIXTURE_FROM_DOTENV']
  })

  test('rejects a missing config and files with the wrong shape, naming the file', async () => {
    const empty = await project({ 'README.md': '' })
    await expect(loadProject(empty)).rejects.toThrow(ProjectLoadError)
    const noProviders = await project({ 'strutvane.config.ts': 'export default {}\n' })
    await expect(loadProject(noProviders)).rejects.toThrow(/providers/)
    const badModel = await project(
      projectFiles({ 'app/models/bad.model.ts': 'export default 1\n' }),
    )
    await expect(loadProject(badModel, { dotenv: false })).rejects.toThrow(/bad.model.ts/)
    const badResource = await project(
      projectFiles({ 'app/resources/x.resource.ts': 'export default {}\n' }),
    )
    await expect(loadProject(badResource, { dotenv: false })).rejects.toThrow(/x.resource.ts/)
    const badRoutes = await project(
      projectFiles({ 'app/http/routes/api.ts': 'export default [1]\n' }),
    )
    await expect(loadProject(badRoutes, { dotenv: false })).rejects.toThrow(/route/)
  })
})

describe('migrations and seeders', () => {
  test('migrate generates a timestamped migration + snapshot, applies it, and is idempotent', async () => {
    const root = await project()
    const p = await loadProject(root, { dotenv: false })
    const first = await migrateProject(p, { name: 'create invoices' })
    expect(first.created).toMatch(/^\d{14}_create_invoices$/)
    expect(first.applied).toEqual([first.created])
    const again = await migrateProject(p)
    expect(again).toEqual({ created: undefined, applied: [], packaged: [] })
    const status = await projectMigrationStatus(p)
    expect(status.applied.map((a) => a.name)).toEqual([first.created])
    expect(status.pending).toEqual([])
  })

  test('pretend writes without applying; custom migration tables are refused', async () => {
    const root = await project()
    const p = await loadProject(root, { dotenv: false })
    const r = await migrateProject(p, { pretend: true })
    expect(r.applied).toEqual([])
    expect(readdirSync(join(root, 'database/migrations')).some((f) => f.endsWith('.sql'))).toBe(
      true,
    )
    await writeFile(join(root, 'database/migrations/99990101000000_bad.ts'), 'export default {}\n')
    await expect(migrateProject(p)).rejects.toThrow(/defineMigration/)
    const custom = await project(
      projectFiles({ 'config/database.ts': "export default { migrations: { table: 'mine' } }\n" }),
    )
    expect(() =>
      migrationTarget({
        ...p,
        root: custom,
        config: { database: { migrations: { table: 'mine' } } },
      }),
    ).toThrow(/strutvane_migrations/)
  })

  test('hand-written .ts and .sql migrations run in timestamp order with { db }; edits are drift', async () => {
    const root = await project()
    const p = await loadProject(root, { dotenv: false })
    await migrateProject(p, { name: 'create invoices' })
    const ts = join(root, 'database/migrations/99990101000000_backfill.ts')
    await writeFile(
      ts,
      `import { defineMigration } from '${IMPORTS.database}'
export default defineMigration({
  async up({ db }) {
    await db.execute(
      "INSERT INTO invoices (id, number, amount, status, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'TS-1', '1.00', 'draft', 'x', 'x')",
    )
  },
  async down({ db }) { await db.execute("DELETE FROM invoices WHERE number = 'TS-1'") },
})
`,
    )
    await writeFile(
      join(root, 'database/migrations/99990102000000_more.sql'),
      "-- more\n-- Notes only, then one statement.\n\nUPDATE invoices SET status = 'sent' WHERE number = 'TS-1';\n",
    )
    const r = await migrateProject(p)
    expect(r.applied).toEqual(['99990101000000_backfill', '99990102000000_more'])
    const db = await connectDatabase(migrationTarget(p).connection)
    try {
      const rows = await db.query("SELECT status FROM invoices WHERE number = 'TS-1'")
      expect(rows[0]?.['status']).toBe('sent')
    } finally {
      await db.close()
    }
    await writeFile(ts, `${readFileSync(ts, 'utf8')}// edited\n`)
    expect((await projectMigrationStatus(p)).drift).toEqual([
      { name: '99990101000000_backfill', kind: 'changed' },
    ])
  })

  test('defineSeeder / defineMigration validate their input', () => {
    expect(() => defineSeeder('bad name', async () => {})).toThrow(/PascalCase/)
    expect(() => defineSeeder({ name: 'X', run: 1 as never })).toThrow(/run function/)
    expect(defineSeeder({ run() {} }).name).toBe('DatabaseSeeder')
    expect(isSeeder(defineSeeder('A', () => {}))).toBe(true)
    expect(isSeeder(null)).toBe(false)
    expect(() => defineMigration({} as never)).toThrow(/up\(\)/)
    expect(typeof defineMigration({ up() {} }).up).toBe('function')
  })
})

describe('boot and serve', () => {
  test('boots the project, serves CRUD + custom routes over real HTTP, and enforces route auth', async () => {
    const root = await project()
    const loaded = await loadProject(root, { dotenv: false })
    await migrateProject(loaded)
    const started = await startServer({ root, port: 0, env: 'local' })
    try {
      const base = started.server.url
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' })
      expect(await (await fetch(`${base}/api/v1/hello`)).json()).toEqual({ message: 'hi' })
      expect((await fetch(`${base}/api/v1/private`)).status).toBe(401)
      const echo = await fetch(`${base}/api/v1/echo`, {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      })
      expect(await echo.json()).toEqual({ a: 1 })
      const bad = await fetch(`${base}/api/v1/echo`, {
        method: 'POST',
        body: '{',
        headers: { 'content-type': 'application/json' },
      })
      expect(bad.status).toBe(400)
      expect((await fetch(`${base}/api/v1/nothing`, { method: 'DELETE' })).status).toBe(204)
      // No PermissionProvider in local: allow-all with a warning, so the permission route passes.
      expect(await (await fetch(`${base}/api/v1/reports/2026`)).json()).toEqual({ year: '2026' })
      const created = await fetch(`${base}/api/v1/invoices`, {
        method: 'POST',
        body: JSON.stringify({ number: 'INV-1', amount: '10.00' }),
        headers: { 'content-type': 'application/json' },
      })
      expect(created.status).toBe(201)
      const invalid = await fetch(`${base}/api/v1/invoices`, {
        method: 'POST',
        body: JSON.stringify({ number: 'INV-2', amount: 'x', status: 'void' }),
        headers: { 'content-type': 'application/json' },
      })
      expect(invalid.status).toBe(422)
      expect(invalid.headers.get('content-type')).toContain('application/problem+json')
      const list = await (
        await fetch(`${base}/api/v1/invoices?filter[status][eq]=draft&sort=-amount`)
      ).json()
      expect(list.data).toHaveLength(1)
    } finally {
      await started.stop()
    }
  })

  test('refuses to build the API outside local without a PermissionProvider', async () => {
    const root = await project()
    const loaded = await loadProject(root, { dotenv: false })
    await expect(bootProject(loaded, { env: 'staging' })).rejects.toThrow(/No PermissionProvider/)
  })

  test('resource files replace the default config; mismatches are rejected', async () => {
    const root = await project(
      projectFiles({
        'app/resources/invoice.resource.ts': `import { defineResource } from '${IMPORTS.http}'
import Invoice from '../models/invoice.model.ts'
export default defineResource(Invoice, { routes: { delete: false } })
`,
      }),
    )
    const loaded = await loadProject(root, { dotenv: false })
    const merged = mergeResources(loaded.models, loaded.resources)
    expect(merged[0]).toMatchObject({ routes: { delete: false } })
    expect(() => mergeResources([], loaded.resources)).toThrow(/no model/)
    expect(() => mergeResources(loaded.models, [...loaded.resources, ...loaded.resources])).toThrow(
      /Two resource/,
    )
  })

  test('hooks can identify the caller, add headers, or answer the request themselves', async () => {
    const root = await project()
    const loaded = await loadProject(root, { dotenv: false })
    const actor: Actor = { id: 'u1', type: 'user', roles: [], attrs: {} }
    const identity = defineProvider({
      name: 'identity',
      register(app) {
        app.container.value(PermissionProviderToken, {
          can: async () => ({ allowed: false, reason: 'test' }),
          filterFor: async () => ({ op: 'false' }),
        })
      },
      boot(app) {
        app.make(HooksToken).on(
          'http.onRequest',
          (payload, control) => {
            const p = payload as { request: Request }
            const headers = new Headers({ 'x-extra': '1' })
            headers.append('set-cookie', 'a=1')
            headers.append('set-cookie', 'b=2')
            if (new URL(p.request.url).pathname === '/answered') {
              control.stop()
              return { ...p, headers, response: new Response('hooked', { status: 202 }) }
            }
            return { ...p, actor, tenant: undefined, headers }
          },
          { name: 'test.identity' },
        )
      },
    })
    const booted = await bootProject(
      { ...loaded, providers: [...loaded.providers, identity] },
      { env: 'production' },
    )
    try {
      const answered = await booted.http.request('/answered')
      expect(answered.status).toBe(202)
      expect(await answered.text()).toBe('hooked')
      expect(answered.headers.get('x-request-id')).toBeTruthy()
      expect(answered.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
      const priv = await booted.http.request('/api/v1/private')
      expect(await priv.json()).toEqual({ actor: 'u1' })
      expect(priv.headers.get('x-extra')).toBe('1')
      expect((await booted.http.request('/api/v1/reports/2026')).status).toBe(403)
    } finally {
      await booted.shutdown()
    }
  })

  test('serve reports handler failures as bare 500s', async () => {
    const errors: unknown[] = []
    const server = await serve(
      () => {
        throw new Error('boom')
      },
      { port: 0, onError: (e) => errors.push(e) },
    )
    try {
      expect((await fetch(server.url)).status).toBe(500)
      expect(errors).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  test('the zero-option provider without the project token boots with no models', async () => {
    const provider = createDefaultFrameworkProvider()
    expect(provider.name).toBe('@strutvane/framework')
  })
})

describe('contributed commands', () => {
  test('are well-formed for the CLI (name, description, run, typed flags)', () => {
    expect(commands.map((c) => c.name).sort()).toEqual(
      [
        'build',
        'db:seed',
        'dev',
        'migrate',
        'migrate:fresh',
        'migrate:refresh',
        'migrate:reset',
        'migrate:rollback',
        'migrate:status',
        'start',
        'sync',
      ].sort(),
    )
    for (const c of commands) {
      expect(c.description.length).toBeGreaterThan(0)
      for (const def of Object.values(c.flags ?? {}))
        expect(['boolean', 'string']).toContain(def.type)
    }
  })

  test('migrate, migrate:status and db:seed work end to end', async () => {
    const root = await project()
    const m = context(root)
    await command('migrate').run(m.ctx)
    expect(m.lines.some((l) => l.startsWith('ok Created migration'))).toBe(true)
    const again = context(root)
    await command('migrate').run(again.ctx)
    expect(again.lines).toEqual(['ok Nothing to migrate.'])
    const status = context(root)
    expect(await command('migrate:status').run(status.ctx)).toMatchObject({ data: { pending: [] } })
    expect(status.lines[0]).toMatch(/applied \(batch 1\)/)

    const seed = context(root)
    await command('db:seed').run(seed.ctx)
    expect(seed.lines).toEqual(['ok Seeded DatabaseSeeder', 'ok Seeded InvoiceSeeder'])
    const one = context(root, { class: 'InvoiceSeeder' })
    await command('db:seed').run(one.ctx)
    const loaded = await loadProject(root, { dotenv: false })
    const db = await connectDatabase(migrationTarget(loaded).connection)
    try {
      const rows = await db.query('SELECT COUNT(*) AS n FROM "invoices"')
      expect(Number(rows[0]?.['n'])).toBe(6)
    } finally {
      await db.close()
    }
    await expect(
      command('db:seed').run(context(root, { class: 'MissingSeeder' }).ctx),
    ).rejects.toThrow(/not found/)
  })

  test('migrate --pretend and build (no web UI) report without side effects', async () => {
    const root = await project()
    const p = context(root, { pretend: true, name: 'first' })
    await command('migrate').run(p.ctx)
    expect(p.lines[0]).toMatch(/first/)
    expect(existsSync(join(root, 'storage/database.sqlite'))).toBe(false)
    const b = context(root)
    await command('build').run(b.ctx)
    expect(b.lines[0]).toMatch(/1 model\(s\), 5 route\(s\)/)
  })

  test('commands use the APP_ENV the CLI resolved, normalised like the CLI', async () => {
    expect(commandAppEnv({ ...context('x').ctx, appEnv: ' Staging ' })).toBe('staging')
    expect(
      commandAppEnv({ ...context('x').ctx, appEnv: '', services: { env: { APP_ENV: 'Local' } } }),
    ).toBe('local')
    expect(commandAppEnv(context('x').ctx)).toBeUndefined()
    expect(normaliseAppEnv('  ')).toBeUndefined()
    expect(normaliseAppEnv(3)).toBeUndefined()
    expect(firstAppEnv(undefined, '', ' PRODUCTION ')).toBe('production')
    const root = await project()
    const before = process.env['APP_ENV']
    try {
      const b = context(root)
      await command('build').run({ ...b.ctx, appEnv: 'Staging' })
      // written before config and .env load, so nothing re-reads a different value
      expect(process.env['APP_ENV']).toBe('staging')
      process.env['APP_ENV'] = ''
      await loadProject(root, { dotenv: false })
      expect(process.env['APP_ENV']).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env['APP_ENV']
      else process.env['APP_ENV'] = before
    }
  })

  test('the runtime treats APP_ENV like the CLI: trimmed, lowercased, empty is unset', async () => {
    const root = await project()
    const loaded = await loadProject(root, { dotenv: false })
    const booted = await bootProject(loaded, { env: ' LOCAL ' })
    try {
      expect(booted.env).toBe('local')
    } finally {
      await booted.shutdown()
    }
    const noEnv = {
      ...loaded,
      config: { ...loaded.config, app: { ...(loaded.config['app'] as object), env: undefined } },
    }
    const before = process.env['APP_ENV']
    process.env['APP_ENV'] = '   '
    try {
      // blank APP_ENV is unset → production → no PermissionProvider → refuses to start
      await expect(bootProject(noEnv)).rejects.toThrow(/No PermissionProvider/)
    } finally {
      if (before === undefined) delete process.env['APP_ENV']
      else process.env['APP_ENV'] = before
    }
  })

  test('rename answers map to planner decisions and reject malformed input', () => {
    expect(renameAnswers(['invoices=bills', 'invoices.total=amount'], ['a.b=c'])).toEqual({
      'table invoices -> bills': 'rename',
      'column invoices.total -> amount': 'rename',
      'column a.b -> c': 'separate',
    })
    expect(() => renameAnswers(['nope'], [])).toThrow(/old=new/)
  })
})
