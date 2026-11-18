<div align="center">

# Strutvane Framework

**The backend & database core of Strutvane: declare models as fields and types, get migrations, a secured CRUD API with OpenAPI docs, tenant isolation, storage and safe uploads.**

[![Status: 0.1.0-next](https://img.shields.io/badge/status-0.1.0--next-orange)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Status: `0.1.0-next.0`, implemented and tested, but not yet released to npm.** It follows the [package spec](https://github.com/vishwajit-vm/strutvane/blob/main/docs/06-package-framework.md), ADR-0003/0004/0007/0008/0009/0011, [RFC-0002](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0002-file-storage-and-uploads.md) (storage core) and [RFC-0003](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0003-errors-and-messages.md) (errors). The API may still change before `0.1.0`. Queue, cache, mail and MySQL are not implemented yet (see [What's deferred](#whats-deferred)).

## What it is

Strutvane Framework is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for enterprise B2B applications. One model definition drives everything: the database schema and migrations, validation, the REST API, OpenAPI, the UI manifest and the tests. Since the v2 consolidation it also ships the kernel (`@strutvane/framework/core`), the shared contracts (`/contracts`), the installer and generator SDK (`/devkit`) and the CLI (`/console`, bin `strutvane`), which used to be separate packages; see [CONSOLIDATION.md](CONSOLIDATION.md). Auth and UI plug in through contracts, never imports.

## The v2 data layer (migration-first, own ORM)

New apps follow Laravel's flow: **migrations are the source of truth** and models hold behaviour only.

```ts
// database/migrations/2026_11_16_093000_create_posts_table.ts (node strut make:migration create_posts_table --seeder)
import { migration } from '@strutvane/framework/schema'

export default migration({
  up(schema) {
    schema.create('posts', (t) => {
      t.id()
      t.string('title', 200)
      t.slug('slug').from('title')
      t.foreignId('author_id').constrained('users').cascadeOnDelete()
      t.timestamps()
      t.softDeletes()
    })
  },
  down(schema) {
    schema.dropIfExists('posts')
  },
})
```

```ts
// app/models/post.ts: columns come from the generated .strutvane/types/models.d.ts
import { Model } from '@strutvane/framework/database'

export class Post extends Model('posts', { fillable: ['title'] }) {
  author() {
    return this.belongsTo(User, 'author_id')
  }
}

const page = await Post.query().with('author').orderBy('created_at', 'desc').paginate(25)
```

- `node strut migrate` replays the migrations **in a sandboxed child process** (no secrets, no network, a timeout, symlinks refused), applies the pending ones (atomically per migration on PostgreSQL and SQLite; resumable statement by statement on MySQL/MariaDB), regenerates `.strutvane/` (types, `resources.json`, `schema.json`, SQL) and checks for drift. Flags: `--pretend`, `--step`, `--seed`, `--force` (required in production), `--isolated`, `--replay-timeout`. Also `migrate:status`, `migrate:rollback`, `migrate:reset`, `migrate:refresh`, `migrate:fresh`, `db:seed` (`--class`, `--tenant`, `--force`) and `sync`.
- **The replay timeout** stops a migration file that hangs (an endless loop, a top-level `await` on something that never settles). It is 10 s by default; on a very busy or slow machine raise it per run with `--replay-timeout=30s` (every command above takes it) or for the project with `DB_MIGRATION_REPLAY_TIMEOUT=30s` in `.env` (the flag wins). Values are milliseconds or `ms`/`s`/`min`, from 1 s to 10 min; anything else is refused naming the flag or key. Code calling `replayInSandbox(dir, { timeoutMs })` gets the same bounds.
- Engines: **MySQL 8.4+ (default)**, MariaDB (detected from the server version), PostgreSQL (node-postgres or PGlite) and SQLite (`node:sqlite`). Settings: `DB_CONNECTION` (`mysql`, `mariadb`, `pgsql`/`postgres`, `sqlite`), `DB_URL`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_SOCKET`, `DB_SSLMODE`, `DB_SSL_CA`.
- Tenancy: `t.tenant()` columns, composite tenant foreign keys and tenant-prefixed unique indexes in every engine's DDL, the ORM's tenant scope, and PostgreSQL row-level security (ADR-0007) created by the migration. Policies (ADR-0008) apply with `Model.query().wherePolicy(filter, { actor })` on every engine.
- Seeders and factories: `defineSeeder({ after, run({ db, env, tenantId, faker, call }) })`, `defineFactory(Post, ({ faker, sequence }) => ({ … }))` with `count`, `state`, `for`, `has`, `recycle`.

The v1 model DSL below keeps working for existing apps; its Drizzle-based migration planning is deprecated and goes away in 0.3.

## What's inside

| Layer | What you get |
|---|---|
| **Model DSL** | `defineModel()` + `field.*` (string, text, email, url, uuid, integer, bigInteger, decimal, float, boolean, enum, date, datetime, json, belongsTo, hasMany). Every modifier is validated when the model is defined. Exact types: `InferModel`, `CreateInput`, `UpdateInput`. |
| **Migrations** (ADR-0009) | A planner that never guesses about renames (an injected `resolveRename` decides), blocks destructive changes unless allowed, and drives drizzle-kit only with diffs that cannot prompt. Timestamped SQL files record every decision. The migrator applies pending files atomically under a lock and detects drift. |
| **Data access** | Per-model repositories: create, find, update, delete (soft or hard), restore, list. Tenant scope in every statement *and* Postgres row-level security; keyset (cursor) and offset pagination; `QueryFilter` → SQL with the two-valued, NULL-safe semantics of ADR-0008. |
| **HTTP** | `createHttpApp(app, { resources })` on Hono: list, show, create, update, delete, restore and `POST /query` per model, the list protocol of ADR-0011, deny-by-default permissions, hooks, domain events, security headers, body limits, `/health`, `/ready`. Every failure is an RFC 9457 problem with catalog messages. |
| **OpenAPI & manifest** | OpenAPI 3.1 at `/openapi.json` and a readable, script-free page at `/docs` (validated in tests; public in `APP_ENV=local`, for identified callers elsewhere) with `x-strutvane-*` extensions; the resource manifest at `/.well-known/strutvane.json` with per-actor capabilities. |
| **Storage** (RFC-0002 core) | `local` and `memory` disks behind the `StorageDisk` contract, path-safe keys, streaming with sha256, signed temporary URLs; streaming multipart parsing with limits enforced *while* streaming; magic-byte MIME detection; `UploadedFile.store()`. |
| **Testing** | `@strutvane/framework/testing`: `createTestApp()`, `defineFactory()` (deterministic fake data), `factory()`, `actingAs()`, `refreshDatabase()`, typed request helpers, on real SQLite or PGlite. |
| **App runtime** | What a generated app runs on: the zero-option provider (`/provider`), custom routes (`/http`), seeders (`/database`), `loadProject()` / `bootProject()` / `startServer()`, and the CLI commands `node strut dev`, `start`, `build`, `migrate`, `migrate:status` and `db:seed` (contributed via `strutvane.commands`). |

## Quick start

```ts
import { createApp } from '@strutvane/framework/core'
import { createHttpApp, defineModel, field, frameworkProvider } from '@strutvane/framework'

export const Customer = defineModel('Customer', {
  name: field.string(120).searchable().sortable(),
  email: field.email().unique(),
  invoices: field.hasMany('Invoice'),
}, { tenant: true })

export const Invoice = defineModel('Invoice', {
  number: field.string(32).unique().searchable().sortable(),
  amount: field.decimal(12, 2).min(0).sortable().filterable(),
  status: field.enum(['draft', 'sent', 'paid']).default('draft').filterable(),
  customer: field.belongsTo('Customer').filterable(),
  notes: field.text().optional(),
}, { tenant: true, softDeletes: true })

const app = createApp({
  config: {},
  providers: [frameworkProvider({ database: { driver: 'sqlite', url: 'file:dev.db' }, models: [Customer, Invoice] })],
})
await app.boot()

// GET/POST /api/v1/invoices, GET/PATCH/DELETE /api/v1/invoices/:id, POST …/:id/restore,
// POST /api/v1/invoices/query, /openapi.json, /.well-known/strutvane.json, /health, /ready
export const http = createHttpApp(app, { resources: [Customer, Invoice] })
```

`http.fetch` works with any runtime adapter (`@hono/node-server`, Bun, Deno, workers).

### Migrations

```ts
import { migrate, planMigration, readMigrations, readSnapshot, writeMigration } from '@strutvane/framework'

const dir = 'database/migrations'
const previous = (await readSnapshot(dir, 'sqlite')).models
const plan = await planMigration({
  dialect: 'sqlite',
  previous,
  next: [Customer.definition, Invoice.definition],
  resolveRename: (candidate) => 'rename', // the CLI asks you; CI replays recorded answers
})
await writeMigration(dir, plan, [Customer.definition, Invoice.definition], { name: 'add invoices' })
await migrate(db, await readMigrations(dir))
```

Possible renames without a resolver throw `RenameResolutionRequiredError` (never a guess); drops, narrowing, enum-value removal and new `NOT NULL` columns throw `DestructiveChangeError` unless `allowDestructive` is set.

### Listing

```
GET /api/v1/invoices?filter[status][in]=draft&filter[status][in]=sent&filter[amount][gte]=100
                    &sort=-amount&page[size]=25&page[cursor]=…&search=acme&include=customer
```

Only `filterable`, `sortable` and `searchable` fields (and allow-listed `include`s) are accepted; anything else is a 422 that lists *every* problem. Use `serializeListParams()` on clients so both sides speak the same protocol.

### Testing

```ts
import { createTestApp } from '@strutvane/framework/testing'

const t = await createTestApp({ resources: [Customer, Invoice] })
const alice = t.actingAs({ id: 'u1', type: 'user', roles: [], attrs: {} }, { tenantId })
const res = await alice.resource(Customer).create({ name: 'Acme', email: 'billing@acme.test' })
expect(res.status).toBe(201)
await t.refreshDatabase()
await t.close()
```

## In a Strutvane app

`create-strutvane` registers `@strutvane/framework/provider` in `strutvane.config.ts`. The runtime then
discovers everything by convention, so there is nothing to wire by hand:

| Where | What |
|---|---|
| `config/*.ts` | Loaded by file name (`config/database.ts` → `app.config('database')`), after `.env` (real environment variables win). |
| `APP_ENV` | Trimmed and lowercased; empty means unset; unset means `production`. `sv` commands run with the value the CLI resolved (process env, `.env.<--env>`, `.env`), so the CLI's guard and the command never disagree. |
| `app/models/*.model.ts` | Every model gets its CRUD API under `config/api.ts` `prefix` + `version` (default `/api/v1`). |
| `app/resources/*.resource.ts` | `defineResource(Invoice, { … })` replaces a model's default resource config. |
| `app/http/routes/*.ts` | `export default [route.get('/hello', { public: true, handler })]`. A route needs `permission`, or `public: true`, or else a signed-in actor (deny-by-default). Handlers get the app's services (see below) and may set `bodyLimit` (bytes) for uploads. |
| `config/filesystems.ts` | `{ default: 'local', disks: { local: { driver: 'local', root: 'storage/app' } } }` (`local` or `memory`; that disk is the default when the file is missing). Disks sign temporary links with `APP_KEY` (`config/app.ts` `key`, an HKDF subkey) and the app serves them at `/storage/<disk>/…`. |
| `dist/web/` | `node strut start` serves the built UI (`node strut build`) next to the API: files, then `index.html` for client-side routes (never for the API base path, `/_strutvane`, `/storage` or discovery documents), with a page CSP. |
| `vite.config.*` | `node strut dev` mounts the project's own Vite (resolved from the project's `node_modules`; the framework has no Vite dependency) in middleware mode on the same port, with HMR over the same server: one URL for the API and the UI, so the UI's `/api/v1` fetches and auth's `trustedOrigins: [APP_URL]` work without a proxy. Vite only gets `GET`/`HEAD` requests the API did not answer, outside the API base path and framework paths (the same rule as `dist/web`). Without a Vite config or an installed `vite`, `node strut dev` serves the API only and says so. A port that cannot be bound (taken, privileged, unknown interface) fails with `ServerListenError` (`port_in_use`, … plus `host`/`port`), which the CLI reports as a config error: change `APP_PORT` or pass `--port`. |
| `database/migrations/` | `node strut migrate` diffs the models with `snapshot.json`, writes a timestamped `.sql` file and applies it together with hand-written `.sql`/`.ts` migrations, in timestamp order (`--pretend`, `--rename old=new`, `--separate old=new`, `--allow-destructive`). |
| package migrations | A dependency whose package.json declares `"strutvane": { "migrations": "./migrations" }` ships `<folder>/<dialect>/*.sql`; `node strut migrate` applies and tracks them with the app's files (e.g. `@strutvane/auth`'s identity tables), so a package needs no separate migration step. They run as the database owner, so only folders the CLI vetted contribute (`ctx.packageMigrations()`): the app imports the package in `strutvane.config.ts`, it is a direct dependency named `@strutvane/*` or `strutvane-plugin-*`, a third-party one declares a matching `strutvane.compat`, and the folder and every file in it resolve inside the package. Anything else is ignored (`node strut doctor` warns); the framework never scans `node_modules` itself. `--pretend` and `migrate:status` show each migration's package. |
| `database/seeders/` | `node strut db:seed` runs `database.seeder.ts`, which calls the other seeders in order (`node strut make:model` registers each new model's seeder there, parents before children); `--class InvoiceSeeder` runs one. When `DatabaseSeeder` runs nothing while other seeder files exist, `db:seed` warns and names them. |
| `database/factories/` | `related('Customer')` on a `belongsTo` field reuses an existing Customer in the same tenant (children spread over the first 100 in turn) and creates one only when there is none; `related('Customer', { create: true })` always creates one. Factory definitions and overrides may set every column, `readOnly` ones included (`readOnly` limits API clients, not trusted server code), typed per field (`FactoryAttributes<M>`). |

```ts
// database/factories/invoice.factory.ts
import { defineFactory } from '@strutvane/framework/testing'
import Invoice from '../../app/models/invoice.model.ts'
export default defineFactory(Invoice, ({ fake, related, sequence }) => ({
  number: `INV-${sequence}`,
  amount: fake.decimal({ min: 10, max: 10_000, scale: 2 }),
  customer: related('Customer'), // an existing customer when there is one
}))

// database/seeders/invoice.seeder.ts
import { defineSeeder } from '@strutvane/framework/database'
import InvoiceFactory from '../factories/invoice.factory.ts'
export default defineSeeder('InvoiceSeeder', async ({ create }) => {
  await create(InvoiceFactory, 10)
})

// database/seeders/database.seeder.ts (what `node strut db:seed` runs)
import { defineSeeder } from '@strutvane/framework/database'
import CustomerSeeder from './customer.seeder.ts'
import InvoiceSeeder from './invoice.seeder.ts'
export default defineSeeder('DatabaseSeeder', async ({ call }) => {
  await call(CustomerSeeder)
  await call(InvoiceSeeder)
})
```

Per-resource hooks (`defineResource(Invoice, { hooks: { afterCreate(record, ctx) {…} } })`) get
`ctx.repository`, `ctx.repositoryFor(model)` (another model, e.g. to recompute totals), `ctx.scope`
(`{ tenantId }`) and `ctx.app` (storage, logger, config).

Global resource hooks: `resource.beforeQuery` narrows list and row filters, `resource.serialize` shapes each
record on the way out (payload `{ resource, type, actor, record }`, `type` being the permission
prefix such as `invoice`), and `resource.beforeWrite` (`{ resource, type, action, actor, tenantId,
input }`) may refuse a create or update before it reaches the database. A Strutvane error thrown by
any hook handler (`ForbiddenError`, `ValidationError`, …) becomes that problem, never a 500.

A custom route handler receives, besides `request`, `params`, `query`, `actor`, `tenantId` and `json()`:

```ts
route.post('/invoices/:id/mark-paid', {
  permission: 'invoice.update',
  handler: async (c) => {
    const repo = c.repository(Invoice)                 // same repositories as the CRUD routes
    const scope = await c.scopeFor(Invoice, 'update')   // tenant + the actor's policy filter
    const paid = await repo.update(c.params.id, { status: 'paid' }, scope)
    if (!paid) throw new NotFoundError()                // not visible to this actor = 404
    return paid
  },
})
route.post('/notes/:id/attachments', {
  bodyLimit: 12 * 1024 * 1024,                          // per route; the app default is 1 MiB
  handler: async (c) => {
    const form = await c.multipart({ maxFileSize: 10 * 1024 * 1024, fileFields: ['file'] })
    const stored = await form.file('file')?.store('notes', { storage: c.storage, id: uuidv7, tenantId: c.tenantId })
    // temp files are deleted when the handler returns, whatever happened
  },
})
```

`c.params` is typed from the path (`/invoices/:id` → `c.params.id: string`). `c.where(Model, filter)` binds a server-written `QueryFilter` for repository calls (`repo.count(c.where(Task, { op: 'eq', field: 'status', value: 'done' }), c.scope)`). `c.scope` is `{ tenantId }` (tenant-scoped models refuse to run without it), `c.authorize(permission, record?)` throws 401/403, `c.storage` is the StorageManager and `c.app` the booted application.

Other packages join the request pipeline through core hooks, never imports. `http.onRequest`
handlers may set `actor`/`tenant`, add response `headers` (a refreshed session cookie), or answer
the request themselves with `response` + `control.stop()` (sign-in routes, the log viewer); such
answers still get security headers, `X-Request-Id` and `http.onResponse`. The payload types and
hook names (`HttpRequestHookPayload`, `HttpResponseHookPayload`, `HTTP_HOOKS`) come from
`@strutvane/framework/contracts` and are re-exported here. `http.onResponse` receives `route`, the matched
route template (`/api/v1/invoices/:id`), or nothing for unmatched requests. Policies get their schema
from a model with `policySchema(Invoice)` (typed per field, so `row.stage.eq('won')` and `row.amount.lte(100)` type-check and a typo does not compile) (plain data in `@strutvane/auth`'s `ModelSchema` shape).

## Security notes

- **Deny by default.** Without a bound `PermissionProvider` (`@strutvane/auth`), `createHttpApp` refuses to start unless `APP_ENV=local` (allow-all with a warning) or `publicApi: true` is set explicitly.
- **Tenancy, twice** (ADR-0007). Tenant models get `tenant_id`, per-tenant unique indexes, a RESTRICTIVE RLS policy with `ENABLE` + `FORCE`, and `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Repositories add `tenant_id = ?` to every statement *and* set the tenant transaction-locally with `set_config(…, true)`. `tenancyAudit()` flags unprotected tables, restrictive policies that do not check the tenant, tables owned by the runtime role, views without `security_invoker` (and materialized views), `SECURITY DEFINER` functions, and roles that bypass RLS. The runtime role must never own the tables, be a superuser or have `BYPASSRLS`.
- **Record-dependent rules work.** A rule that needs the row ("members update their own deals", "won deals cannot be deleted") is decided with the row: row actions are allowed when `can()` allows them or the row filter is not FALSE, the row must lie inside that filter (else 404), and update, delete and restore are re-checked with the record (403 when it refuses).
- **No enumeration.** Rows outside the tenant or the policy filter are 404, exactly like missing rows.
- **Writes are checked after the fact** (the `WITH CHECK` of RLS, on every engine). A created row must match the actor's `create` filter and an updated row its `update` filter, inside the same transaction; otherwise the write is rolled back with 403. Record-level `can()` for an update sees the row as it would be after the change. `Scope.check` (repository) overrides the default (`Scope.filter`).
- **Hooks narrow, never widen.** A `resource.beforeQuery` result is AND-ed with the PermissionProvider's filter.
- **References are checked in scope.** A `belongsTo` id must name a row of the same tenant that the actor may `view` (foreign keys alone would accept another tenant's id).
- **Field-level filter rules.** When the PermissionProvider implements `filterableFields(actor, resourceType)` (resolved once per list request), filters, sorts and `POST /query` may only reference the fields it returns, intersected with the model's own allow-lists; any other field is a 422 (`filter_not_allowed` / `sort_not_allowed`), and search silently skips searchable fields outside the set. Cursors are bound to the sort, so they follow the same rule. Providers without the method keep the model's allow-lists alone.
- **Hidden fields stay server-side.** `hidden()` fields are never serialised, never writable (`unknown_field`), absent from OpenAPI and the manifest, and cannot be filterable, sortable or searchable (rejected when the model is defined). Hidden and `sensitive()` field keys are registered at boot with core's log redaction (`registerSensitiveKeys`), which core's fallback logger and `@strutvane/logs` both apply.
- **Query cost is bounded.** Page size is at most 100 (or the resource's `pageSize.max`, also on `POST /query`), offset pages reach at most `MAX_OFFSET` (10 000) rows deep (cursors go further), total counts only where a resource sets `allowTotal: true`, at most 10 includes, and Postgres pools get a 5 s `statement_timeout` by default (`pool.statementTimeoutMs`, `0` disables).
- **Never trusted:** the payload's tenant, system fields and unknown keys (strict schemas → `unknown_field`), `$actor` references in client filters, malformed filter nodes (422 `invalid_filter`), client file names (keys are UUIDs), browser MIME types (magic bytes decide), filter text (`%`/`_` are literal; no `LIKE`), and `X-Forwarded-*` / `X-Request-Id` unless `trustProxy` says a proxy you run sets them.
- **Discovery needs an identity.** The manifest lists only resources the caller can use at all; `/openapi.json` is served to identified callers outside `APP_ENV=local` (`openapi: 'public' | 'authenticated' | false`).
- **Uploads** (RFC-0002): limits apply while streaming, including an idle timeout reset by every received byte and a total deadline (`totalTimeoutMs`, default 120 s). Markup anywhere in the sniffed head makes a file `text/html` or `image/svg+xml`, and wildcards such as `image/*` never allow active content (name `image/svg+xml` explicitly). Keys are lowercase, with no trailing dots or Windows device names; `storage.forTenant(id)` and `store(dir, { tenantId })` confine a tenant's files to `tenants/<id>/`. Signed links use an HKDF subkey of the secret; `createHttpApp({ signedFiles })` (or `serveSignedFile`) serves them with `nosniff`, a sandboxing CSP and active content as an attachment.
- Broken Postgres connections are destroyed, never returned to the pool.

### Behind a proxy

| Option (`createHttpApp`, `serve`, `config/app.ts`) | Default | Why |
|---|---|---|
| `trustProxy` | `false` | Which proxies may set `X-Forwarded-For`/`-Proto`/`-Host` and `X-Request-Id`: a hop count (`true` = one) or, safer, their addresses or CIDR ranges (`['10.0.0.0/8']`; `'*'` is refused). Clients can send these headers themselves, so they are ignored unless a proxy you control overwrites them. |
| `publicUrl` | none | The URL users reach the app at. An `https://` URL makes request URLs report `https` even though TLS ends at the proxy. HSTS is sent over HTTPS in `APP_ENV=production` only, so a local `https://` dev server never pins your browser. |

`http.onRequest` handlers receive `clientAddress`: the TCP peer (from `serve`, or `@hono/node-server`'s `c.env.incoming`), or the trusted `X-Forwarded-For` hop. It is `undefined` when unknown, and controls keyed by address must then fail closed. `serve` also aborts `request.signal` when the client disconnects, cancels the response body, honours backpressure, and never streams `HEAD` bodies. Every response carries a `Permissions-Policy` that disables camera, microphone, geolocation, payment and similar features.

## The application core (v2)

An app built Laravel's way has `bootstrap/app.ts`, routes files and `node strut`:

```ts
// bootstrap/app.ts
import { dirname } from 'node:path'
import { Application } from '@strutvane/framework'
import web from '../routes/web.ts'

export default Application.configure({ basePath: dirname(import.meta.dirname) })
  .withRouting({ web, health: '/up' })
  .withMiddleware((m) => m.validateCsrfTokens({ except: ['webhooks/*'] }))
  .withCommands([sendReportsCommand])
  .create()
```

- **Exports.** `@strutvane/framework` exports `Application`, `Route`/`defineRoutes`, the `route()`, `config()`, `app()`, `now()` and `redirect()` helpers, middleware and protections (`csrf`, `auth`, `can`, `throttle`, `signed`, `idempotent`), `FormRequest`, `ResourceController`, the exception handler, the security kit (`Keyring`, `Encrypter`, `UrlSigner`, `HttpClient`), maintenance mode, the cache manager and the session store. `route` is callable (`route('posts.show', { post })`) and still carries the deprecated v1 `route.get/post/…` builders.
- **Facades** live on `@strutvane/framework/facades` (`Log`, `Cache`, `DB`, `Route`, `Storage`, `Http`, `Event`, `Crypt`, `Url`; `Mail`, `Queue`, `Bus`, `Notification` and `Hash` say "coming in 0.3"). They resolve from the current app's container, so tests can swap them, and the `Route` facade never shadows the `Route` builder.
- **The database in requests.** Models work in controllers, route closures, middleware, listeners and commands with no setup, Laravel-style. When the app boots it hands the ORM `.strutvane/schema.json` and the tenancy switch (`config/tenancy.ts`), and binds `DatabaseConnectionToken`: the default connection from `config/database.ts` (`default`, `host`, `port`, `database`, `username`, `socket`, `sslmode`, `ssl_ca`) over `DB_*` in `.env`, with `DB_PASSWORD`/`DB_URL` read from the environment when it connects. It is **opened by the first query** (so `/up`, `route:list` and other work that never queries never needs the database, and a database that is down fails only the requests that use it) and closed by `app.shutdown()`. Every request and command resolves its own app's connection, even with two apps in one process. With tenancy on, the tenant an `http.onRequest` hook resolves (the auth package) scopes every model query of that request; a request without one can't read tenant tables (fail closed). With `APP_ENV=testing`, `database.test_database` replaces the database name. To use another connection (a test double, a replica), bind `DatabaseConnectionToken` in a provider's `register()` or on `app.container` before boot. On MySQL and MariaDB the app's connection compiles inserts without `RETURNING` (the row is read back by key), so one grammar fits every server version.
- **Serving.** `node strut start` (and `dev`) boots `bootstrap/app.ts` before the port opens (`startApplication()`); a broken route or a weak key never starts serving. The Node adapter hands the app the socket peer and `waitUntil`, so deferred work runs after the response and a graceful stop waits for it.
- **Commands.** `node strut list` (`help` is an alias) shows the app commands: `optimize`, `config:cache`, `route:cache`, `event:cache` (and their `:clear`), `event:list`, `route:list [--security]`, `cache:clear`, `cache:forget`, `key:rotate`, `env:encrypt`/`env:decrypt`, `down`/`up`, `session:flush`, `security:check [--audit]`, `make:command`, `make:rule`, `make:observer`, plus the commands the app registers with `withCommands()`. A `BootError` is reported with its hint and exit code 3.

### Upgrading to 0.2: lowercase error codes

Every code is lowercase `snake_case` from 0.2 (CONSISTENCY #68, #123): HTTP problem codes (`NOT_FOUND` → `not_found`, `VALIDATION_FAILED` → `validation_failed`), CLI `--json` error codes (`PROJECT_NOT_FOUND` → `project_not_found`), devkit, container and model-DSL codes. Each new name is the old one in lower case; `LEGACY_ERROR_CODES` (from `@strutvane/framework/core`) is the full table. Through the 0.2 line the old names keep working: `new StrutvaneError('NOT_FOUND')` carries `not_found`, the error registry finds an old name, and an app's own uppercase code is still accepted. Each prints one `DeprecationWarning` (code `STRUTVANE_UPPERCASE_ERROR_CODE`); 0.3 removes them. Clients that compare `problem.code` must switch to the lowercase names, and catalog keys become `errors.<new code>.title`.

Validation issues also carry `field`, the dotted path (`items.0.title`), next to `path` (CONSISTENCY #69).

## What's deferred

| Item | Status |
|---|---|
| Queue, mail; database and Redis cache stores | Not implemented (coming in 0.3). The cache has `memory` and `file` stores today. |
| MySQL in the v1 runtime | v1's `connectDatabase({ driver: 'mysql' })` throws `NotImplementedError`; migration-first apps use MySQL through the ORM (`DB_CONNECTION=mysql`). |
| Azure Entra ID (passwordless) Postgres | `auth: { kind: 'azure-entra' }` is part of the config shape and throws `NotImplementedError` for now. |
| Relation paths in filters (`customer.name`), sparse fieldsets, bulk, export, `PUT` | Rejected clearly (`relation_path_unsupported`, `unknown_parameter`) or not routed. |
| Locale-aware sorting, case folding beyond ASCII | Text sorts by code point and case-insensitive matching folds ASCII only, identically on every engine. |
| Custom actions, ETags, rate limiting, request timeouts | Planned. Postgres statements have a default timeout; SQLite and PGlite have none. |
| Rollback for v1 migrations | v1's hand-written migrations (`.sql`, `defineMigration`) have no rollback; migration-first apps have the Schema builder and `migrate:rollback`. |
| Custom routes in OpenAPI | Custom routes are served but not documented in `/openapi.json` yet. |

## Installation (once released)

```bash
npm install @strutvane/framework
npm install @libsql/client   # or: pg, @electric-sql/pglite (optional peer dependencies)
```

## Development

```bash
npm install
npm run ci   # lint → typecheck → tests (incl. type tests) + coverage → build
```

| Script | What it does |
|---|---|
| `lint` / `format` | Biome check / auto-fix |
| `typecheck` | `tsc --noEmit` with the strictest settings |
| `test` / `test:coverage` | Vitest on real engines (PGlite + libSQL): migrations, RLS, SQL ↔ memory property tests (fast-check), end-to-end HTTP, OpenAPI validation, upload attacks, type-level tests. Coverage thresholds: 90/90/85/90. |
| `test:perf` | Performance budgets (`*.perf.test.ts`, today the CLI registry), kept out of the gate |
| `test:soak` | Soak and spike (`test/soak/*.soak.ts`), kept out of the gate: a real server under mixed CRUD, auth-protected, error and aborted requests for `SOAK_MINUTES` (default 10), then `SOAK_SPIKE` (default 2,000) concurrent requests. Fails on a crash, an unexpected status, a 5xx in the spike, or steady heap, handle or database-connection growth. SQLite by default; `SOAK_DB=postgres://…` uses a throw-away Postgres database (its tables are dropped). `node test/soak/soak-driver.ts --minutes 10 --out soak.json` runs it without Vitest and prints every sample. With `SOAK_PG_CONTAINER=<a throw-away container>` as well, the Postgres chaos run stops, freezes (`docker pause`) and kills connections of that container mid-request, mid-transaction and mid-migration, and exhausts the pool: every request must get a bounded problem+json answer and the app must recover. |
| `test:tripwire` | The whole suite again under process tripwires (`--unhandled-rejections=strict`, `test/helpers/tripwires.ts`): a test file fails if anything raised an uncaught exception or an unhandled rejection, or if it left sockets, servers, timers or child processes running. Kept out of the gate because it runs every test a second time. |
| `build` | tsdown → one entry per subpath (`dist/index.mjs`, `dist/core/index.mjs`, `dist/console/bin.mjs`, …) + `.d.mts` |

This repo uses npm (>= 11.19). `.npmrc` turns on `strict-allow-scripts`, so only the install scripts approved in `package.json` `allowScripts` run (`npm approve-scripts <pkg>` after reviewing one), and third-party versions must be a day old (`min-release-age`).

Shared configs (`tsconfig.base.json`, `biome.base.json`, `vitest.shared.ts`, CI workflows) are synced from [strutvane-tooling](https://github.com/vishwajit-vm/strutvane-tooling). Don't edit them here.

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core (this repo) |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| `@strutvane/framework/core` (was `@strutvane/core`) | Kernel: container, providers, config, context (this repo) |
| `@strutvane/framework/contracts` (was `@strutvane/contracts`) | Shared types and wire protocols (this repo) |
| `@strutvane/framework/console`, bin `strutvane` (was `@strutvane/cli`) | Unified CLI (this repo) |
| `@strutvane/framework/devkit` (was `@strutvane/devkit`) | SDK for installers, generators and plugins (this repo) |
| [`@strutvane/logs`](https://github.com/vishwajit-vm/strutvane-logs) | Zero-config logging + built-in log viewer (default) |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter |

## Documentation

- **Package specification:** [06-package-framework.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/06-package-framework.md); decisions: ADR [0007](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0007-tenancy-rls-enforcement-rules.md) (RLS), [0008](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0008-policy-predicates-two-valued-semantics.md) (filter semantics), [0009](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0009-migration-engine-owns-rename-resolution.md) (migrations), [0011](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0011-openapi-pipeline-and-typed-client.md) (OpenAPI and the list protocol)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) and the [developer experience](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md)

## Contributing

Issues, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Public API changes need an RFC, tests, docs and a changeset.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
