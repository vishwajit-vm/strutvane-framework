# CLAUDE.md: Strutvane Framework (`@strutvane/framework`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

The backend & database core of Strutvane: declare models as fields and types, get migrations, a secured CRUD API, OpenAPI docs, queues, cache and mail.

It is one repo of the **Strutvane** ecosystem. On branch `v2/consolidate` it also holds the former `core`, `contracts`, `devkit` and `cli` repos, with their history (blueprint `docs/18-v2-blueprint.md` §3.2). [CONSOLIDATION.md](CONSOLIDATION.md) says what moved where. The hub with the full blueprint is https://github.com/vishwajit-vm/strutvane. Locally it is the umbrella folder two levels up: `../../docs/`.

## Status

- **Implemented: `0.1.0-next.0` (Phase 1), not yet released to npm.** One concept per file in `src/`:
  - `model/`: `field.ts` (builders), `define-model.ts` (definition + inference types), `naming.ts`, `registry.ts`, `schemas.ts` (Zod create/update/read + Zod → RFC-0003 issue codes)
  - `schema/compile.ts`: models → Drizzle tables (pg + sqlite), deterministic constraint names (hashed past 63 bytes)
  - `migrations/`: `planner.ts` (ADR-0009: rename resolver, destructive gating, `assertPromptFree`, two-phase drizzle-kit diffs, RLS statements), `rls.ts` (ADR-0007 policies + `tenancyAudit`), `files.ts` (timestamped SQL + decision header, snapshot), `migrator.ts` (atomic batch, advisory lock, `strutvane_migrations`, checksum + schema drift)
  - `database/`: tiny `Database` contract, drivers (PGlite, libSQL, node-postgres with transaction-local tenant + broken-connection destruction), `connect.ts` (config → driver), `sql.ts` (quoted identifiers, `?` fragments)
  - `query/`: `bind.ts` (QueryFilter → bound, actor refs, fail closed), `compile.ts` (→ SQL, two-valued, ASCII case folding), `evaluate.ts` (in-memory twin), `sort.ts` (sort keys, NULLS LAST, keyset cursors)
  - `data/`: `values.ts` (canonical values: the reason SQL and memory agree), `repository.ts` (CRUD, tenant scope, in-scope reference checks, soft deletes, pagination)
  - `http/`: `create-http-app.ts`, `resource-routes.ts` (pipeline, post-write policy check, cost limits), `resource.ts` (config + hooks), `list-query.ts` (shared serializer/parser), `permissions.ts`, `security.ts`, `proxy.ts` (`trustProxy`/`publicUrl`, client address), `errors.ts`, `route.ts` (custom routes + their app services), `static-files.ts` (built UI), `ui-paths.ts` (what the UI may answer), `docs-page.ts` (`/docs`)
  - `openapi/`: `document.ts` (OpenAPI 3.1 + `x-strutvane-*`), `manifest.ts`
  - `storage/`: keys, MIME sniffing, memory + local disks, signing (HKDF subkey), `serve-signed.ts`, `tenant-disk.ts`, manager, streaming multipart, `UploadedFile`
  - `model/sensitive-keys.ts`: registers hidden/sensitive field keys with core's `registerSensitiveKeys` at boot
  - `testing/` (subpath export): `createTestApp`, factories
  - `provider.ts`, `tokens.ts`, `messages.ts` (framework catalog + error codes)
  - absorbed (v2 consolidation; subpath exports): `contracts/` (`/contracts`, was `@strutvane/contracts`), `core/` (`/core`, the kernel), `devkit/` (`/devkit`), `console/` (`/console` + bin `strutvane`, alias `strutvane-cli`, was `@strutvane/cli`). Their tests are in `test/<part>/`; their changelogs in `docs/changelogs/`, their old READMEs in `docs/absorbed/`. They import each other by relative `.ts` path, never through the package name.
  - `runtime/` (app runtime: `project.ts` loader, `boot.ts`, `serve.ts` Node adapter, `server.ts`, `migrations.ts`, `seeders.ts`, `database-config.ts`, `storage-config.ts` (`config/filesystems.ts`), `dev-ui.ts` (`sv dev` serves Vite on the API port), `default-provider.ts`), `entries/` (`/provider`, `/http`, `/database` subpaths), `commands.ts` (CLI contribution: dev/start/build/migrate/migrate:status/db:seed), `http/route.ts` (custom routes), `model/policy-schema.ts`, `testing/define-factory.ts`
- **v2 data layer (branch `v2/data-layer`):** migration-first schema in `src/schema/` (Schema builder, replay, generators, `ddl/`; entry `/schema`), the ORM in `src/database/{db,orm,sql,schema,seeding}` (entry `/database`; `TableRegistry` is declared in `src/entries/database.ts` because augmentations only merge into the declaring module), `src/database/config.ts` (`DB_*`), the v2 migrator, introspection and F-06 sandbox in `src/migrations/{runner,introspect,sandbox,replay-worker}.ts`, commands in `src/runtime/schema-commands.ts`, `make:migration` in `src/console/make/migration-first.ts`. ORM suites live in `test/database/orm` with their own tsconfig (app-style `extends Model(...)` is TS9021 under isolatedDeclarations). Real servers: `test/helpers/db-servers.ts` (vitest globalSetup; `STRUTVANE_TEST_DOCKER=off` skips).
- **Deferred (documented in README):** queue/cache/mail, MySQL, Azure Entra passwordless (config shape kept, throws `NotImplementedError`), relation paths in filters, sparse fieldsets, bulk/export/PUT, custom actions.
- Tests in `test/` run on real engines (PGlite + libSQL): migrations, RLS (as a non-owner role), SQL ↔ memory property tests, end-to-end HTTP, OpenAPI validation, upload attacks, type-level tests (`*.test-d.ts`). `test/readme.test.ts` runs the README examples: update both together.
- Gate: `npm run ci` (lint → typecheck → tests + coverage 90/90/85/90 → build). npm 11.19+; `.npmrc` enforces `strict-allow-scripts` (approvals in `package.json` `allowScripts`) and `min-release-age`. Never run pnpm here.
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

- Internal layering (was the repo boundary): `src/contracts` imports nothing of ours; `src/core` imports only `contracts`; `src/devkit` only `contracts`; `src/console` may use `contracts`, `core` and `devkit`. It must never import `@strutvane/auth` or `@strutvane/ui`; it cooperates with them only through contracts resolved from the container.
- The framework's own modules (everything outside `contracts/`, `core/`, `devkit/` and `console/`) use only `contracts` and `core`.
- Cooperation with other Strutvane packages happens **only through the contracts (`@strutvane/framework/contracts`)**, resolved at runtime via the core container.
- Public API changes need a changeset, docs and tests. Contract changes need an RFC.

## Conventions (apply once code exists)

- TypeScript strict, ESM only, Node 24+ (Node 26 LTS is the target). No decorators or reflection.
- Validation uses Standard Schema with Zod 4 as the default. Errors are RFC 9457 problem+json.
- Tooling: npm, tsdown (build), Biome (lint/format), Vitest (tests), Playwright (UI e2e), Testcontainers (DB).
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
