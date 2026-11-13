# @strutvane/framework

## 0.1.0-next.0

### Minor Changes

- First implementation of the Strutvane backend and database core (Phase 1):
  
  - Model DSL: `defineModel()` and `field.*` builders (15 kinds, every modifier validated at definition time) with exact type inference (`InferModel`, `CreateInput`, `UpdateInput`) and a validated model registry.
  - Schema compiler and migrations (ADR-0009): Drizzle tables for Postgres and SQLite, a prompt-free planner with an injected rename resolver, destructive-change gating, Postgres row-level security for tenant models (ADR-0007), timestamped migration files that record every decision, and a locked, atomic migrator with drift detection.
  - Data access: per-model repositories with tenant scoping (WHERE clause plus transaction-local `set_config`), in-scope reference checks, soft deletes, keyset and offset pagination, and a QueryFilter compiler that is property-tested equal to the in-memory evaluator on both engines (ADR-0008).
  - HTTP: `createHttpApp()` on Hono with automatic CRUD routes, `POST /query`, the shared list-query protocol (ADR-0011), deny-by-default permissions, hooks, domain events, security headers, body limits, `/health` and `/ready`, and RFC-0003 problems for every failure.
  - OpenAPI 3.1 at `/openapi.json` with `x-strutvane-*` extensions, and the resource manifest at `/.well-known/strutvane.json`.
  - Storage core (RFC-0002): `local` and `memory` disks, signed temporary URLs, streaming multipart parsing with limits enforced while streaming, and magic-byte MIME detection.
  - `@strutvane/framework/testing`: `createTestApp()`, factories (`defineFactory()` with deterministic fake data), `actingAs()`, `refreshDatabase()` and typed request helpers.
  - App runtime for generated projects: the zero-option provider (`@strutvane/framework/provider`, database from `config/database.ts` incl. the create-strutvane shapes), custom routes (`@strutvane/framework/http`, deny-by-default), seeders (`@strutvane/framework/database`), `loadProject()` / `bootProject()` / `startServer()`, `policySchema()` for auth policies, `defineResource(Model, config)`, and the CLI commands `dev`, `start`, `build`, `migrate`, `migrate:status` and `db:seed` (`strutvane.commands`).
  - `http.onRequest` hook handlers may add response headers or answer a request themselves (auth endpoints, the log viewer).
