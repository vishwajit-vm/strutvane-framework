/**
 * `createTestApp()`: a booted application, a migrated real database (SQLite in memory by
 * default, or PGlite) and the HTTP app, ready for `app.request()`-style tests without a
 * network or a server.
 *
 * ```ts
 * const t = await createTestApp({ resources: [Customer, Invoice] })
 * const res = await t.actingAs(user, { tenantId }).resource(Invoice).create({ number: 'INV-1', … })
 * expect(res.status).toBe(201)
 * await t.refreshDatabase()
 * await t.close()
 * ```
 *
 * @module
 */
import type { Actor, PermissionProvider } from '../contracts/index.ts'
import {
  type Application,
  type Clock,
  createApp,
  HooksToken,
  IdGeneratorToken,
  PermissionProviderToken,
} from '../core/index.ts'
import { createRepository, type Repository } from '../data/repository.ts'
import { connectDatabase } from '../database/connect.ts'
import type { Database, Dialect } from '../database/types.ts'
import { createHttpApp, type HttpApp, type HttpAppOptions } from '../http/create-http-app.ts'
import { allowAllPermissions, denyAllPermissions } from '../http/permissions.ts'
import type { ResourceConfig } from '../http/resource.ts'
import { migrationSource } from '../migrations/files.ts'
import { migrate } from '../migrations/migrator.ts'
import { planMigration } from '../migrations/planner.ts'
import type {
  AnyModel,
  CreateInput,
  InferModel,
  ModelDefinition,
  UpdateInput,
} from '../model/define-model.ts'
import { createModelRegistry, type ModelRegistry } from '../model/registry.ts'
import { frameworkProvider } from '../provider.ts'
import { createFactory, type Factory } from './factory.ts'

/** Options for {@link createTestApp}. */
export interface TestAppOptions {
  readonly resources: readonly (ResourceConfig | AnyModel)[]
  /** Extra models that are not exposed over HTTP. */
  readonly models?: readonly AnyModel[]
  /** Default `sqlite` (in memory). `postgres` uses PGlite. */
  readonly dialect?: Dialect
  /** `allow` (default), `deny`, or a provider. */
  readonly permissions?: 'allow' | 'deny' | PermissionProvider
  readonly basePath?: string
  /** Extra `createHttpApp` options (e.g. `trustProxy`, `openapi`, `signedFiles`). */
  readonly http?: Omit<HttpAppOptions, 'resources' | 'registry' | 'database'>
  /**
   * The app's clock (default: the system clock). Pass a `TestClock` to test anything that
   * depends on elapsed time (expiry, TTLs) without waiting, and without failing on a slow machine.
   *
   * @example
   * const clock = createTestClock()
   * const t = await createTestApp({ resources: [Order], clock, http: { idempotency: { ttlMs: 50 } } })
   * clock.advance(51) // every stored idempotent response has now expired
   */
  readonly clock?: Clock
}

/** A response as seen by tests. */
export interface TestResponse<T = unknown> {
  readonly status: number
  readonly headers: Headers
  readonly body: T
}

/** Request options. */
export interface TestRequestInit {
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly query?: string | URLSearchParams
}

/** Typed CRUD calls for one model. */
export interface ResourceClient<M extends AnyModel> {
  list(
    query?: string,
  ): Promise<TestResponse<{ data: InferModel<M>[]; meta: { page: Record<string, unknown> } }>>
  show(id: string): Promise<TestResponse<InferModel<M>>>
  create(input: CreateInput<M>): Promise<TestResponse<InferModel<M>>>
  update(id: string, patch: UpdateInput<M>): Promise<TestResponse<InferModel<M>>>
  delete(id: string): Promise<TestResponse<null>>
  restore(id: string): Promise<TestResponse<InferModel<M>>>
}

/** Sends requests, optionally as an actor. */
export interface TestClient {
  request<T = unknown>(
    method: string,
    path: string,
    init?: TestRequestInit,
  ): Promise<TestResponse<T>>
  resource<M extends AnyModel>(model: M): ResourceClient<M>
}

/** The test application. */
export interface TestApp extends TestClient {
  readonly app: Application
  readonly http: HttpApp
  readonly db: Database
  readonly registry: ModelRegistry
  /** A client whose requests come from `actor` (and tenant). */
  actingAs(actor: Actor | null, options?: { readonly tenantId?: string }): TestClient
  /** The repository of a model (for arranging data directly). */
  repository(model: AnyModel | string): Repository
  /** A record factory; pass `{ tenantId }` for tenant-scoped models. */
  factory<M extends AnyModel>(model: M, options?: { readonly tenantId?: string }): Factory<M>
  /** Delete every row of every model table (children first), keeping the schema. */
  refreshDatabase(): Promise<void>
  close(): Promise<void>
}

const ACTOR_HEADER = 'x-strutvane-test-identity'

/** Create a test application. */
export async function createTestApp(options: TestAppOptions): Promise<TestApp> {
  const dialect = options.dialect ?? 'sqlite'
  const db = await connectDatabase(
    dialect === 'postgres' ? { driver: 'pglite' } : { driver: 'sqlite', url: ':memory:' },
  )
  const definitions: ModelDefinition[] = [
    ...options.resources.map((r) =>
      'model' in r ? ('definition' in r.model ? r.model.definition : r.model) : r.definition,
    ),
    ...(options.models ?? []).map((m) => m.definition),
  ]
  const registry = createModelRegistry(definitions)
  const plan = await planMigration({ dialect, previous: [], next: registry.all })
  await migrate(db, [migrationSource('0001_test_schema', plan.statements)])

  const app = createApp({
    config: {},
    providers: [frameworkProvider({ database: db, models: registry.all })],
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  })
  const permissions =
    options.permissions === undefined || options.permissions === 'allow'
      ? allowAllPermissions()
      : options.permissions === 'deny'
        ? denyAllPermissions()
        : options.permissions
  app.container.value(PermissionProviderToken, permissions)
  await app.boot()

  // Test-only identity: actingAs() registers an identity under a random token sent in a header.
  // This hook exists only in test apps; production resolves identity through @strutvane/auth.
  const identities = new Map<string, { actor: Actor | null; tenantId?: string }>()
  app.make(HooksToken).on(
    'http.onRequest',
    (payload) => {
      const p = payload as { request: Request; actor: Actor | null; tenant: unknown }
      const id = identities.get(p.request.headers.get(ACTOR_HEADER) ?? '')
      if (!id) return undefined
      return {
        ...p,
        actor: id.actor,
        tenant: id.tenantId ? { id: id.tenantId, strategy: 'shared' } : undefined,
      }
    },
    { name: 'testing.actingAs' },
  )

  const http = createHttpApp(app, {
    resources: options.resources,
    registry,
    env: 'testing',
    ...(options.basePath ? { basePath: options.basePath } : {}),
    ...options.http,
  })
  const basePath = (options.basePath ?? '/api/v1').replace(/\/+$/, '')
  const repos = new Map<string, Repository>()
  const repository = (model: AnyModel | string): Repository => {
    const name = typeof model === 'string' ? model : model.definition.name
    let r = repos.get(name)
    if (!r) {
      r = createRepository({
        db,
        model: registry.require(name),
        registry,
        ids: () => app.make(IdGeneratorToken)(),
      })
      repos.set(name, r)
    }
    return r
  }

  const client = (identityToken?: string): TestClient => {
    const request = async <T>(
      method: string,
      path: string,
      init: TestRequestInit = {},
    ): Promise<TestResponse<T>> => {
      const headers: Record<string, string> = { ...init.headers }
      if (identityToken) headers[ACTOR_HEADER] = identityToken
      let body: string | undefined
      if (init.body !== undefined) {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
        headers['content-type'] ??= 'application/json'
      }
      const query = init.query ? `?${init.query.toString()}` : ''
      const res = await http.request(`${path}${query}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      })
      const text = await res.text()
      let parsed: unknown = null
      if (text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      return { status: res.status, headers: res.headers, body: parsed as T }
    }
    return {
      request,
      resource<M extends AnyModel>(model: M): ResourceClient<M> {
        const base = `${basePath}/${model.definition.path}`
        return {
          list: (query) => request('GET', base, query ? { query } : {}),
          show: (id) => request('GET', `${base}/${id}`),
          create: (input) => request('POST', base, { body: input }),
          update: (id, patch) => request('PATCH', `${base}/${id}`, { body: patch }),
          delete: (id) => request('DELETE', `${base}/${id}`),
          restore: (id) => request('POST', `${base}/${id}/restore`),
        }
      },
    }
  }

  const anonymous = client()
  return {
    ...anonymous,
    app,
    http,
    db,
    registry,
    actingAs(actor, opts = {}) {
      const token = crypto.randomUUID()
      identities.set(token, { actor, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) })
      return client(token)
    },
    repository,
    factory: (model, opts = {}) => createFactory(model, (name) => repository(name), opts),
    async refreshDatabase() {
      for (const m of [...registry.all].reverse()) await db.execute(`DELETE FROM "${m.table}"`)
    },
    async close() {
      await app.shutdown()
    },
  }
}
