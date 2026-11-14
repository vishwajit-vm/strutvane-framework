# CLAUDE.md: Strutvane Framework (`@strutvane/framework`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

The backend & database core of Strutvane: declare models as fields and types, get migrations, a secured CRUD API, OpenAPI docs, queues, cache and mail.

It is one repo of the **Strutvane** polyrepo ecosystem (one GitHub repo per package; see ADR-0002). The hub with the full blueprint is https://github.com/vishwajit-vm/strutvane. Locally it is the umbrella folder two levels up: `../../docs/`.

## Status

- **Implemented: `0.1.0-next.0` (Phase 1), not yet released to npm.** One concept per file in `src/`:
  - `model/`: `field.ts` (builders), `define-model.ts` (definition + inference types), `naming.ts`, `registry.ts`, `schemas.ts` (Zod create/update/read + Zod → RFC-0003 issue codes)
  - `schema/compile.ts`: models → Drizzle tables (pg + sqlite), deterministic constraint names (hashed past 63 bytes)
  - `migrations/`: `planner.ts` (ADR-0009: rename resolver, destructive gating, `assertPromptFree`, two-phase drizzle-kit diffs, RLS statements), `rls.ts` (ADR-0007 policies + `tenancyAudit`), `files.ts` (timestamped SQL + decision header, snapshot), `migrator.ts` (atomic batch, advisory lock, `strutvane_migrations`, checksum + schema drift)
  - `database/`: tiny `Database` contract, drivers (PGlite, libSQL, node-postgres with transaction-local tenant + broken-connection destruction), `connect.ts` (config → driver), `sql.ts` (quoted identifiers, `?` fragments)
  - `query/`: `bind.ts` (QueryFilter → bound, actor refs, fail closed), `compile.ts` (→ SQL, two-valued, ASCII case folding), `evaluate.ts` (in-memory twin), `sort.ts` (sort keys, NULLS LAST, keyset cursors)
  - `data/`: `values.ts` (canonical values: the reason SQL and memory agree), `repository.ts` (CRUD, tenant scope, in-scope reference checks, soft deletes, pagination)
  - `http/`: `create-http-app.ts`, `resource-routes.ts` (pipeline, post-write policy check, cost limits), `resource.ts` (config + hooks), `list-query.ts` (shared serializer/parser), `permissions.ts`, `security.ts`, `proxy.ts` (`trustProxy`/`publicUrl`, client address), `errors.ts`
  - `openapi/`: `document.ts` (OpenAPI 3.1 + `x-strutvane-*`), `manifest.ts`
  - `storage/`: keys, MIME sniffing, memory + local disks, signing (HKDF subkey), `serve-signed.ts`, `tenant-disk.ts`, manager, streaming multipart, `UploadedFile`
  - `model/sensitive-keys.ts`: registers hidden/sensitive field keys with core's `registerSensitiveKeys` at boot
  - `testing/` (subpath export): `createTestApp`, factories
  - `provider.ts`, `tokens.ts`, `messages.ts` (framework catalog + error codes)
  - `runtime/` (app runtime: `project.ts` loader, `boot.ts`, `serve.ts` Node adapter, `server.ts`, `migrations.ts`, `seeders.ts`, `database-config.ts`, `default-provider.ts`), `entries/` (`/provider`, `/http`, `/database` subpaths), `commands.ts` (CLI contribution: dev/start/build/migrate/migrate:status/db:seed), `http/route.ts` (custom routes), `model/policy-schema.ts`, `testing/define-factory.ts`
- **Deferred (documented in README):** queue/cache/mail, MySQL, Azure Entra passwordless (config shape kept, throws `NotImplementedError`), relation paths in filters, sparse fieldsets, bulk/export/PUT, `/docs` UI, custom actions.
- Tests in `test/` run on real engines (PGlite + libSQL): migrations, RLS (as a non-owner role), SQL ↔ memory property tests, end-to-end HTTP, OpenAPI validation, upload attacks, type-level tests (`*.test-d.ts`). `test/readme.test.ts` runs the README examples: update both together.
- Gate: `corepack pnpm@12.18.0 run ci` (lint → typecheck → tests + coverage 90/90/85/90 → build).
- **Temporary:** `pnpm-workspace.yaml` overrides `@strutvane/contracts` and `@strutvane/core` with `link:../contracts` / `link:../core` until both are published. **Never commit those overrides**; the CI `check-deps` guard rejects them.
- Changesets is in pre mode (`next` tag).
- Design first: read this package's spec and the ADRs, and write or extend an RFC before changing any public API.
- The source of truth for decisions is `../../docs/00-executive-summary.md`. If anything here conflicts with it, that file wins.
- The package spec is `../../docs/06-package-framework.md` (online: https://github.com/vishwajit-vm/strutvane/blob/main/docs/06-package-framework.md).

## Gotchas learned while building it

- drizzle-kit opens interactive prompts on any diff that both adds and removes tables/columns; only call it through `planner.ts` (guarded by `assertPromptFree`). It is loaded lazily.
- Remove columns in a separate diff before dropping tables: Postgres `DROP TABLE … CASCADE` silently removes FKs that a later `DROP CONSTRAINT` then can't find.
- Postgres error `23001` (restrict_violation) is what `ON DELETE RESTRICT` raises, not `23503`.
- libSQL throws for integers beyond 2^53 unless the client uses `intMode: 'bigint'` (what `connectDatabase` does).
- PGlite runs as a superuser, which bypasses RLS: RLS tests must `SET ROLE` to a non-owner role.
- Secure defaults tests rely on: `/openapi.json` needs an actor outside `env: 'local'`, totals need `allowTotal`, client `X-Request-Id` is ignored without `trustProxy`. `createTestApp({ http: {…} })` passes extra `createHttpApp` options.
- Undici's lazily generated `FormData` bodies throw when cancelled mid-stream; upload tests encode forms to bytes first.

## Boundaries (non-negotiable)

- Allowed dependencies: `@strutvane/core`, `@strutvane/contracts`. It must never import `@strutvane/auth` or `@strutvane/ui`; it cooperates with them only through contracts resolved from the container.
- Cooperation with other Strutvane packages happens **only through `@strutvane/contracts`**, resolved at runtime via the core container.
- Public API changes need a changeset, docs and tests. Contract changes need an RFC.

## Conventions (apply once code exists)

- TypeScript strict, ESM only, Node 24+ (Node 26 LTS is the target). No decorators or reflection.
- Validation uses Standard Schema with Zod 4 as the default. Errors are RFC 9457 problem+json.
- Tooling: pnpm, tsdown (build), Biome (lint/format), Vitest (tests), Playwright (UI e2e), Testcontainers (DB).
- Code generation and AST work pin the TypeScript 6 compiler API (`@typescript/typescript6`), because TypeScript 7 has no compiler API.
- Releases: Changesets, npm trusted publishing (OIDC) with provenance. Core packages share a major release train.
- **Docker is local-only and never committed** (ADR-0006). Never commit `.env`; keep `.env.example` complete and documented.
- Windows, macOS and Linux are all first-class. Use no bash-only scripts.

## Definition of done (for any change)

Code, tests, docs and a changeset ship together. Security implications are noted. The CLI help or reference is updated if commands changed.

## Where things are

- `.claude/skills/`: task playbooks for this package (invoke by name)
- `.claude/agents/`: specialised reviewer subagents
- `.claude/commands/`: slash commands (`/spec`, `/pre-pr`)
