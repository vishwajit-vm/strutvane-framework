/**
 * Chaos against a real Postgres in a throw-away Docker container: the database goes down, freezes,
 * kills connections mid-transaction and mid-migration, and runs out of pooled connections, while
 * the app serves requests. Expected every time: a problem+json answer (never a hang, never a
 * secret), no leaked connections, and full recovery once the database is back.
 *
 * Not part of the gate (needs Docker): `npm run test:soak` with
 * `SOAK_DB=postgres://postgres:<pw>@127.0.0.1:<port>/<db>` and `SOAK_PG_CONTAINER=<name>` (the
 * test pauses, stops and starts that container, so never point it at one you care about).
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createApp,
  createLogger,
  defineProvider,
  LoggerToken,
  PermissionProviderToken,
} from '../../src/core/index.ts'
import { connectDatabase, type DatabaseConfig } from '../../src/database/connect.ts'
import type { Database } from '../../src/database/types.ts'
import { createHttpApp, type HttpApp } from '../../src/http/create-http-app.ts'
import { allowAllPermissions } from '../../src/http/permissions.ts'
import { route } from '../../src/http/route.ts'
import { migrationSource } from '../../src/migrations/files.ts'
import { migrate } from '../../src/migrations/migrator.ts'
import { planMigration } from '../../src/migrations/planner.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { frameworkProvider } from '../../src/provider.ts'

const url = process.env['SOAK_DB']
const container = process.env['SOAK_PG_CONTAINER']
const enabled = url?.startsWith('postgres') === true && container !== undefined

const Note = defineModel('Note', { title: field.string(80).filterable() })
const docker = (...args: string[]): void => {
  execFileSync('docker', args, { stdio: 'ignore' })
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForDatabase(db: Database): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (
      await db.query('SELECT 1').then(
        () => true,
        () => false,
      )
    )
      return
    await sleep(500)
  }
  throw new Error('the database did not come back')
}

describe.skipIf(!enabled)('Postgres chaos', () => {
  const config: DatabaseConfig = {
    driver: 'postgres',
    url: url as string,
    pool: { max: 3, connectionTimeoutMs: 1_000, statementTimeoutMs: 2_000, queryTimeoutMs: 3_000 },
  }
  let db: Database
  let http: HttpApp
  let app: ReturnType<typeof createApp>
  const logs: string[] = []

  beforeAll(async () => {
    db = await connectDatabase(config)
    await db.execute('DROP TABLE IF EXISTS "notes", "strutvane_migrations", "chaos_migrated"')
    const plan = await planMigration({ dialect: 'postgres', previous: [], next: [Note.definition] })
    await migrate(db, [migrationSource('0001_notes', plan.statements)])
    app = createApp({
      config: {},
      providers: [
        defineProvider({
          name: 'chaos',
          register(a) {
            a.container.value(PermissionProviderToken, allowAllPermissions())
            a.container.value(LoggerToken, createLogger({ sink: (l) => void logs.push(l) }))
          },
        }),
        frameworkProvider({ database: db, models: [Note] }),
      ],
    })
    await app.boot()
    http = createHttpApp(app, {
      resources: [Note],
      env: 'production',
      publicApi: true,
      requestTimeoutMs: 5_000,
      routes: [
        route.get('/slow', {
          public: true,
          handler: async () => {
            await db.transaction((tx) => tx.query('SELECT pg_sleep(1.5)'))
            return { ok: true }
          },
        }),
      ],
    })
  }, 120_000)

  afterAll(async () => {
    try {
      docker('unpause', container as string)
    } catch {}
    await app?.shutdown()
  })

  const get = async (path: string) => {
    const started = Date.now()
    const res = await http.fetch(new Request(`http://app.test${path}`))
    return { status: res.status, body: await res.text(), ms: Date.now() - started, res }
  }
  const appConnections = async (): Promise<number> => {
    const probe = await connectDatabase({ ...config, pool: { max: 1 } })
    try {
      const rows = await probe.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
      )
      return Number(rows[0]?.n ?? 0)
    } finally {
      await probe.close()
    }
  }
  const noSecrets = (text: string): void => {
    const password = new URL(url as string).password
    if (password) expect(text).not.toContain(password)
    expect(text).not.toMatch(/ECONNREFUSED|pg_sleep|stack/i)
  }

  it('database down mid-life: problem+json, /ready 503, no secrets; recovers when it is back', async () => {
    docker('stop', container as string)
    try {
      const r = await get('/api/v1/notes')
      expect(r.status).toBeGreaterThanOrEqual(500)
      expect(r.res.headers.get('content-type')).toMatch(/problem\+json/)
      noSecrets(r.body)
      expect((await get('/ready')).status).toBe(503)
      expect(r.ms).toBeLessThan(6_000)
    } finally {
      docker('start', container as string)
    }
    await waitForDatabase(db)
    expect((await get('/api/v1/notes')).status).toBe(200)
  }, 120_000)

  it('database frozen mid-request: bounded answer, then recovery, no leaked connections', async () => {
    const inFlight = get('/api/v1/slow')
    await sleep(200)
    docker('pause', container as string)
    try {
      const during = await get('/api/v1/notes')
      expect(during.status).toBeGreaterThanOrEqual(500)
      expect(during.ms).toBeLessThan(6_000)
      const first = await inFlight
      expect(first.status).toBeGreaterThanOrEqual(500)
      expect(first.ms).toBeLessThan(6_000)
      noSecrets(first.body)
    } finally {
      docker('unpause', container as string)
    }
    await waitForDatabase(db)
    expect((await get('/api/v1/notes')).status).toBe(200)
    expect(await appConnections()).toBeLessThanOrEqual(3)
  }, 120_000)

  it('connections killed mid-transaction: the request fails cleanly and the pool heals', async () => {
    const slow = get('/api/v1/slow')
    await sleep(300)
    const killer = await connectDatabase({ ...config, pool: { max: 1 } })
    await killer.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
    )
    await killer.close()
    expect((await slow).status).toBeGreaterThanOrEqual(500)
    for (let i = 0; i < 5; i++) expect((await get('/api/v1/notes')).status).toBe(200)
  }, 60_000)

  it('pool exhausted: excess requests fail fast instead of queueing forever', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => get('/api/v1/slow')))
    const ok = results.filter((r) => r.status === 200).length
    const failed = results.filter((r) => r.status >= 500)
    expect(ok).toBeGreaterThan(0)
    for (const r of failed) {
      expect(r.res.headers.get('content-type')).toMatch(/problem\+json/)
      expect(r.ms).toBeLessThan(6_000)
    }
    expect(Math.max(...results.map((r) => r.ms))).toBeLessThan(10_000)
    expect((await get('/api/v1/notes')).status).toBe(200)
  }, 60_000)

  it('connection killed mid-migration: nothing is half-applied, and a re-run succeeds', async () => {
    const migration = migrationSource('0002_chaos', [
      'CREATE TABLE "chaos_migrated" (id int)',
      'SELECT pg_sleep(1.5)',
    ])
    const migrator = await connectDatabase({ ...config, pool: { max: 1, statementTimeoutMs: 0 } })
    // Only the chaos migration is "on disk" for this run.
    await migrator.execute(`DELETE FROM "strutvane_migrations" WHERE "name" = '0001_notes'`)
    const running = migrate(migrator, [migration]).catch((e: unknown) => e)
    await sleep(400)
    const killer = await connectDatabase({ ...config, pool: { max: 1 } })
    await killer.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(1.5)%' AND pid <> pg_backend_pid()`,
    )
    expect(await running).toBeInstanceOf(Error)
    const exists = await killer.query(`SELECT to_regclass('public.chaos_migrated') AS t`)
    expect(exists[0]?.['t']).toBeNull()
    await killer.close()
    await migrator.close()
    const again = await connectDatabase({ ...config, pool: { max: 1, statementTimeoutMs: 0 } })
    try {
      expect(await migrate(again, [migration])).toEqual(['0002_chaos'])
    } finally {
      await again.close()
    }
  }, 60_000)
})
