/**
 * The server side of the soak harness: a real Strutvane app (core application, framework
 * provider, CRUD resource, a permission-protected custom route, error routes) served by the
 * framework's own Node adapter. It runs in a child process so the driver can measure it from the
 * outside and so a crash shows up as an exit, not as a failed assertion in the same heap.
 *
 * Talks to the driver over IPC:
 * - sends `{ type: 'ready', url }` once listening;
 * - answers `{ type: 'sample' }` with heap (after a forced GC), RSS, active resources by type and,
 *   on Postgres, the number of server-side connections this app holds;
 * - stops on `'shutdown'` and exits 0 once closed.
 *
 * Environment: `SOAK_DB` is a Postgres URL, or a SQLite file path (default: a temp file).
 *
 * Run with `node --expose-gc test/soak/soak-server.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Actor, PermissionProvider, QueryFilter } from '../../src/contracts/index.ts'
import { HTTP_HOOKS, type HttpRequestHookPayload } from '../../src/contracts/index.ts'
import {
  createApp,
  createLogger,
  defineProvider,
  HooksToken,
  LoggerToken,
  PermissionProviderToken,
} from '../../src/core/index.ts'
import { connectDatabase } from '../../src/database/connect.ts'
import type { Database } from '../../src/database/types.ts'
import { createHttpApp } from '../../src/http/create-http-app.ts'
import { route } from '../../src/http/route.ts'
import { migrationSource } from '../../src/migrations/files.ts'
import { migrate } from '../../src/migrations/migrator.ts'
import { planMigration } from '../../src/migrations/planner.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { frameworkProvider } from '../../src/provider.ts'
import { serve } from '../../src/runtime/serve.ts'

const Note = defineModel(
  'Note',
  {
    title: field.string(120).searchable().sortable().filterable(),
    body: field.text().optional(),
    status: field.enum(['open', 'done']).default('open').filterable(),
  },
  { timestamps: true },
)

/** Signed-in when the request carries `x-soak-user`; everything requires a signed-in actor. */
const permissions: PermissionProvider = {
  can: async (actor) =>
    actor ? { allowed: true, reason: 'soak user' } : { allowed: false, reason: 'anonymous' },
  filterFor: async (actor): Promise<QueryFilter> => (actor ? { op: 'true' } : { op: 'false' }),
}

const pgUrl = process.env['SOAK_DB']?.startsWith('postgres') ? process.env['SOAK_DB'] : undefined
const tempDir = pgUrl ? undefined : mkdtempSync(join(tmpdir(), 'sv-soak-'))
const sqliteFile = tempDir ? join(tempDir, 'soak.sqlite') : undefined

const db: Database = await connectDatabase(
  pgUrl
    ? { driver: 'postgres', url: pgUrl, pool: { max: 10 } }
    : { driver: 'sqlite', url: pathToFileURL(sqliteFile as string).href },
)
const dialect = pgUrl ? 'postgres' : 'sqlite'
if (pgUrl) await db.execute('DROP TABLE IF EXISTS "notes", "strutvane_migrations"')
const plan = await planMigration({ dialect, previous: [], next: [Note.definition] })
await migrate(db, [migrationSource('0001_soak', plan.statements)])

const soakProvider = defineProvider({
  name: 'soak',
  register(app) {
    app.container.value(PermissionProviderToken, permissions)
    // Logs go nowhere: the soak measures the app, not the terminal.
    app.container.value(LoggerToken, createLogger({ sink: () => undefined }))
  },
  boot(app) {
    app.make(HooksToken).on(
      HTTP_HOOKS.request,
      (payload: unknown) => {
        const p = payload as HttpRequestHookPayload
        const user = p.request.headers.get('x-soak-user')
        const actor: Actor | null = user ? { id: user, type: 'user', roles: [], attrs: {} } : null
        return { ...p, actor }
      },
      { name: 'soak.identity' },
    )
  },
})

const app = createApp({
  config: {},
  providers: [soakProvider, frameworkProvider({ database: db, models: [Note] })],
})
await app.boot()
const http = createHttpApp(app, {
  resources: [Note],
  env: 'production',
  routes: [
    route.get('/reports/:year', {
      permission: 'report.view',
      handler: (c) => ({ year: c.params['year'] }),
    }),
    route.get('/boom', {
      public: true,
      handler: () => {
        throw new Error('soak: deliberate handler failure')
      },
    }),
  ],
})
const server = await serve((request, bindings) => http.fetch(request, bindings), { port: 0 })

async function sample(): Promise<Record<string, unknown>> {
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  gc?.()
  const mem = process.memoryUsage()
  const resources: Record<string, number> = {}
  for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] ?? 0) + 1
  let dbConnections: number | undefined
  if (pgUrl) {
    const rows = await db.query<{ n: string | number }>(
      'SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
    )
    dbConnections = Number(rows[0]?.n ?? 0) + 1
  }
  return {
    heapUsed: mem.heapUsed,
    rss: mem.rss,
    external: mem.external,
    resources,
    handles: Object.values(resources).reduce((a, b) => a + b, 0),
    ...(dbConnections !== undefined ? { dbConnections } : {}),
  }
}

process.on('message', (message: unknown) => {
  if (message === 'shutdown') {
    void (async () => {
      await server.close()
      await app.shutdown()
      if (tempDir) rmSync(tempDir, { recursive: true, force: true })
      process.disconnect?.()
    })()
    return
  }
  if (typeof message === 'object' && message !== null && 'type' in message) {
    if (message.type === 'sample')
      sample().then(
        (s) => process.send?.({ type: 'sample', ...s }),
        (e: unknown) => process.send?.({ type: 'sample-error', error: String(e) }),
      )
  }
})
process.send?.({ type: 'ready', url: server.url })
