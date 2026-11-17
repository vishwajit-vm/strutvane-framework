# v2/data-layer: progress notes (temporary, removed before merge)

Updated 2026-11-17. Branch is committed; the agent pushes nothing (the coordinator does).

## Done (committed)
- Schema pipeline (`src/schema/**`, entry `@strutvane/framework/schema`): Schema builder, offline replay, generators (types, resources.json, schema.json, SQL), DDL for SQLite/PostgreSQL/MySQL/MariaDB, MySQL index lint, #97 modifiers, tenant composite keys and uniques (F-05, #92), UUIDv7 keys (#93), ADR-0007 RLS created by migrations for `t.tenant()` tables (proven as a non-owner role on PGlite and PostgreSQL 18).
- ORM (`src/database/**`, entry `@strutvane/framework/database`): spike 11 adapted to the repo rules; drivers mysql2 (lazy, optional peer), node-postgres (new), PGlite, node:sqlite; `wherePolicy()`; tenancy off by default and fail closed for `t.tenant()` tables (#90); `TableRegistry` declared in `src/entries/database.ts`.
- One ADR-0008 compiler `compileFilterSql` through the grammar for all four dialects; v1 `compileFilter` delegates to it; property test on all five engines.
- v2 migrator (`src/migrations/runner.ts`), introspection, F-06 sandbox (`sandbox.ts`, `replay-worker.ts`, `replay-protocol.ts`), built-package smoke test (`scripts/smoke-dist.mjs`, last step of `npm run ci`).
- Commands for migration-first projects (`src/runtime/schema-commands.ts`) and `make:migration` (`src/console/make/migration-first.ts`).
- Seeders/factories, `DB_*` settings, inflection in `src/core/inflection.ts`. Drizzle-based APIs `@deprecated`; changesets `.changeset/v2-data-layer.md` (minor) and `.changeset/v2-data-layer-hardening.md` (patch).
- **Security review fixes (2026-11-17)**, each with whole-class tests:
  - Replay sandbox: one shared import resolver for the gate and the child (`resolveMigrationImport`, property-tested against URL resolution); the child loads only gate-approved files pinned by SHA-256, always as ES modules (no CommonJS through any `package.json`); `package.json`/`node_modules` in the folder refused; the child checks its own confinement (permission model) and fails closed, empties its globals to an allowlist, freezes the rest, imports nothing but approved files once locked, runs with frozen intrinsics, `--disable-proto=throw`, `--no-addons` and a heap cap; answers on capped stdout; child text is made printable. Tests: `test/migrations/v2/sandbox-gate.test.ts`, `sandbox-worker.test.ts` (child alone, gate bypassed), `sandbox-revalidation.test.ts`, `sandbox.test.ts`.
  - Parent re-validation: the recorder's operations are private (copied out); folding a tenant table requires the recorder's rewrites; column sizes and operation counts are bounded.
  - ORM: the migration's `.hidden()`, `.secret()` and secret-looking names are hidden everywhere (toJSON, inspect, nested JSON, request filter/sort/search, cursors, hints); secret columns in `fillable` need `allowSensitive`; `JsonOf` follows the generated json shape. Relation keys, whereHas correlation, eager-load keys and cursor seeks can't be OR-ed away. No string-to-SQL path for app code (`SqlFragment.trusted` removed, identifiers re-checked at render); request text and sort terms bounded; own-property table lookups. Tests: `test/database/orm/hidden-columns.test.ts`, `relations.test.ts`, `sql-safety.test.ts`, `types.test.ts`.
  - An independent re-review of the fixed code found no critical or high issue; its mediums and lows are fixed above.
- **Gate:** PGlite-backed v1 suites get realistic timeouts (`test/helpers/engines.ts`, same values as the real-server suites). Three consecutive `npm run ci` runs green on 2026-11-17 under full load (each: 139 files, 2458 passed, 16 skipped; coverage 96.06 stmts / 90.01 branches / 97.39 funcs / 97.05 lines; dist smoke OK; 8-10 min). Agent-reported until the coordinator re-runs them.

## Half-done
- Nothing in progress.

## Next
1. Before the generated CRUD API (v2 HTTP layer) calls the ORM: an allow-list for request-driven `?include=` relation names, opt-in totals and an offset cap for `paginate()` (hub `docs/12` §3.2).
2. Node 24 has no `--allow-net`: there the network is closed by the child's in-process barriers (no `process`, no reachable sockets, imports locked); on Node versions with `--allow-net` the permission model denies it too (the self-check reports which). Revisit when the minimum Node version moves.
3. Lowercase the remaining v1 error codes per #123.
4. Not built yet: the generated CRUD API over the ORM (blueprint §2.4 step 4), auto-seeding new seeders in development, the `resources/ui` pre-flight lint, observers/events, upserts/chunking/cursor streaming.

## How to verify
- `npm ci` then `npm run ci` (needs Docker for the MySQL 8.4 / MariaDB 11.4 / PostgreSQL 18 test containers; `STRUTVANE_TEST_DOCKER=off` skips them). Run it three times in a row.
- Sandbox only: `npx vitest run test/migrations/v2`, then `npx tsdown && node scripts/smoke-dist.mjs`.
