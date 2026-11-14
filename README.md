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

Strutvane Framework is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for enterprise B2B applications. One model definition drives everything: the database schema and migrations, validation, the REST API, OpenAPI, the UI manifest and the tests. It depends only on `@strutvane/core` and `@strutvane/contracts`; auth and UI plug in through contracts, never imports.

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
| **App runtime** | What a generated app runs on: the zero-option provider (`/provider`), custom routes (`/http`), seeders (`/database`), `loadProject()` / `bootProject()` / `startServer()`, and the CLI commands `sv dev`, `start`, `build`, `migrate`, `migrate:status` and `db:seed` (contributed via `strutvane.commands`). |

## Quick start

```ts
import { createApp } from '@strutvane/core'
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
| `dist/web/` | `sv start` serves the built UI (`sv build`) next to the API: files, then `index.html` for client-side routes (never for the API base path, `/_strutvane`, `/storage` or discovery documents), with a page CSP. |
| `vite.config.*` | `sv dev` mounts the project's own Vite (resolved from the project's `node_modules`; the framework has no Vite dependency) in middleware mode on the same port, with HMR over the same server: one URL for the API and the UI, so the UI's `/api/v1` fetches and auth's `trustedOrigins: [APP_URL]` work without a proxy. Vite only gets `GET`/`HEAD` requests the API did not answer, outside the API base path and framework paths (the same rule as `dist/web`). Without a Vite config or an installed `vite`, `sv dev` serves the API only and says so. A port that cannot be bound (taken, privileged, unknown interface) fails with `ServerListenError` (`PORT_IN_USE`, … plus `host`/`port`), which the CLI reports as a config error: change `APP_PORT` or pass `--port`. |
| `database/migrations/` | `sv migrate` diffs the models with `snapshot.json`, writes a timestamped `.sql` file and applies it together with hand-written `.sql`/`.ts` migrations, in timestamp order (`--pretend`, `--rename old=new`, `--separate old=new`, `--allow-destructive`). |
| package migrations | A dependency whose package.json declares `"strutvane": { "migrations": "./migrations" }` ships `<folder>/<dialect>/*.sql`; `sv migrate` applies and tracks them with the app's files (e.g. `@strutvane/auth`'s identity tables), so installing a package never needs a separate migration step. |
| `database/seeders/` | `sv db:seed` runs `database.seeder.ts`, which calls the other seeders in order (`sv make:model` registers each new model's seeder there, parents before children); `--class InvoiceSeeder` runs one. When `DatabaseSeeder` runs nothing while other seeder files exist, `db:seed` warns and names them. |
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

// database/seeders/database.seeder.ts (what `sv db:seed` runs)
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
`@strutvane/contracts` and are re-exported here. `http.onResponse` receives `route`, the matched
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
| `trustProxy` | `false` | How many proxy hops may set `X-Forwarded-For`/`-Proto` and `X-Request-Id`. Clients can send these headers themselves, so they are ignored unless a proxy you control overwrites them. |
| `publicUrl` | none | The URL users reach the app at. An `https://` URL makes the app send HSTS (and request URLs report `https`) even though TLS ends at the proxy. |

`http.onRequest` handlers receive `clientAddress`: the TCP peer (from `serve`, or `@hono/node-server`'s `c.env.incoming`), or the trusted `X-Forwarded-For` hop. It is `undefined` when unknown, and controls keyed by address must then fail closed. `serve` also aborts `request.signal` when the client disconnects, cancels the response body, honours backpressure, and never streams `HEAD` bodies. Every response carries a `Permissions-Policy` that disables camera, microphone, geolocation, payment and similar features.

## What's deferred

| Item | Status |
|---|---|
| Queue, cache, mail | Not implemented. Integration-map tokens are reserved for a later release. |
| MySQL | `driver: 'mysql'` is accepted in config and throws `NotImplementedError`. |
| Azure Entra ID (passwordless) Postgres | `auth: { kind: 'azure-entra' }` is part of the config shape and throws `NotImplementedError` for now. |
| Relation paths in filters (`customer.name`), sparse fieldsets, bulk, export, `PUT` | Rejected clearly (`relation_path_unsupported`, `unknown_parameter`) or not routed. |
| Locale-aware sorting, case folding beyond ASCII | Text sorts by code point and case-insensitive matching folds ASCII only, identically on every engine. |
| Custom actions, ETags, rate limiting, request timeouts | Planned. Postgres statements have a default timeout; SQLite and PGlite have none. |
| Migration `schema` builder and rollback | Hand-written migrations run (`.sql`, or `.ts` with `defineMigration({ up({ db }) {…} })` using `db.execute`), but the `schema` builder of docs/06 §3.2 and `down()`/rollback are not built yet. |
| Custom routes in OpenAPI | Custom routes are served but not documented in `/openapi.json` yet. |

## Installation (once released)

```bash
npm install @strutvane/framework @strutvane/core
npm install @libsql/client   # or: pg, @electric-sql/pglite (optional peer dependencies)
```

## Development

```bash
corepack pnpm@12.18.0 install
corepack pnpm@12.18.0 run ci   # lint → typecheck → tests (incl. type tests) + coverage → build
```

| Script | What it does |
|---|---|
| `lint` / `format` | Biome check / auto-fix |
| `typecheck` | `tsc --noEmit` with the strictest settings |
| `test` / `test:coverage` | Vitest on real engines (PGlite + libSQL): migrations, RLS, SQL ↔ memory property tests (fast-check), end-to-end HTTP, OpenAPI validation, upload attacks, type-level tests. Coverage thresholds: 90/90/85/90. |
| `build` | tsdown → `dist/index.mjs`, `dist/testing/index.mjs` + `.d.mts` |

Until `@strutvane/contracts` and `@strutvane/core` are published, local development links them from `../contracts` and `../core` through temporary `overrides` in `pnpm-workspace.yaml`. Those entries must not be committed (the CI `check-deps` guard rejects them).

Shared configs (`tsconfig.base.json`, `biome.base.json`, `vitest.shared.ts`, CI workflows) are synced from [strutvane-tooling](https://github.com/vishwajit-vm/strutvane-tooling). Don't edit them here.

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core (this repo) |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| [`@strutvane/core`](https://github.com/vishwajit-vm/strutvane-core) | Kernel: container, providers, config, context |
| [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts) | Shared types and wire protocols |
| [`strutvane` / `@strutvane/cli`](https://github.com/vishwajit-vm/strutvane-cli) | Unified CLI |
| [`@strutvane/devkit`](https://github.com/vishwajit-vm/strutvane-devkit) | SDK for installers, generators and plugins |
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
