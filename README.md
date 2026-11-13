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
| **OpenAPI & manifest** | OpenAPI 3.1 at `/openapi.json` (validated in tests) with `x-strutvane-*` extensions; the resource manifest at `/.well-known/strutvane.json` with per-actor capabilities. |
| **Storage** (RFC-0002 core) | `local` and `memory` disks behind the `StorageDisk` contract, path-safe keys, streaming with sha256, signed temporary URLs; streaming multipart parsing with limits enforced *while* streaming; magic-byte MIME detection; `UploadedFile.store()`. |
| **Testing** | `@strutvane/framework/testing`: `createTestApp()`, `factory()`, `actingAs()`, `refreshDatabase()`, typed request helpers, on real SQLite or PGlite. |

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

## Security notes

- **Deny by default.** Without a bound `PermissionProvider` (`@strutvane/auth`), `createHttpApp` refuses to start unless `APP_ENV=local` (allow-all with a warning) or `publicApi: true` is set explicitly.
- **Tenancy, twice** (ADR-0007). Tenant models get `tenant_id`, per-tenant unique indexes, a RESTRICTIVE RLS policy with `ENABLE` + `FORCE`, and `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Repositories add `tenant_id = ?` to every statement *and* set the tenant transaction-locally with `set_config(…, true)`. `tenancyAudit()` flags unprotected tables and roles that bypass RLS. The runtime role must never own the tables, be a superuser or have `BYPASSRLS`.
- **No enumeration.** Rows outside the tenant or the policy filter are 404, exactly like missing rows.
- **References are checked in scope.** A `belongsTo` id must name a visible row of the same tenant (foreign keys alone would accept another tenant's id).
- **Never trusted:** the payload's tenant, system fields and unknown keys (strict schemas → `unknown_field`), client file names (keys are UUIDs), browser MIME types (magic bytes decide), filter text (`%`/`_` are literal; no `LIKE`).
- Broken Postgres connections are destroyed, never returned to the pool.

## What's deferred

| Item | Status |
|---|---|
| Queue, cache, mail | Not implemented. Integration-map tokens are reserved for a later release. |
| MySQL | `driver: 'mysql'` is accepted in config and throws `NotImplementedError`. |
| Azure Entra ID (passwordless) Postgres | `auth: { kind: 'azure-entra' }` is part of the config shape and throws `NotImplementedError` for now. |
| Relation paths in filters (`customer.name`), sparse fieldsets, bulk, export, `PUT` | Rejected clearly (`relation_path_unsupported`, `unknown_parameter`) or not routed. |
| Locale-aware sorting, case folding beyond ASCII | Text sorts by code point and case-insensitive matching folds ASCII only, identically on every engine. |
| `/docs` UI, custom actions, ETags, rate limiting, request timeouts | Planned. |

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
