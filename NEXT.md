# v2/data-layer: progress notes (temporary, removed before merge)

Paused 2026-11-16 at the project lead's request. Branch is committed; nothing pushed by the agent.

## Done (committed, tests green when run on their own)
- Schema pipeline (`src/schema/**`, entry `@strutvane/framework/schema`): Schema builder, offline replay, generators (types, resources.json, schema.json, SQL), DDL for SQLite/PostgreSQL/MySQL/MariaDB, MySQL index lint, #97 modifiers, tenant composite keys and uniques (F-05, #92), UUIDv7 keys (#93), ADR-0007 RLS created by migrations for `t.tenant()` tables (proven as a non-owner role on PGlite and PostgreSQL 18).
- ORM (`src/database/**`, entry `@strutvane/framework/database`): spike 11 adapted to the repo rules; drivers mysql2 (lazy, optional peer), node-postgres (new), PGlite, node:sqlite; `wherePolicy()`; tenancy off by default and fail closed for `t.tenant()` tables (#90); `TableRegistry` declared in `src/entries/database.ts`.
- One ADR-0008 compiler `compileFilterSql` through the grammar for all four dialects; v1 `compileFilter` delegates to it; property test on all five engines.
- v2 migrator (`src/migrations/runner.ts`: `migrations` table, batches, step/pretend/isolated, #121 atomicity, MySQL resume, rollback/reset/refresh/fresh, drift), introspection, F-06 sandbox (`sandbox.ts`, `replay-worker.ts`, `replay-protocol.ts`), and a built-package smoke test (`scripts/smoke-dist.mjs`, last step of `npm run ci`).
- Commands for migration-first projects (`src/runtime/schema-commands.ts`): migrate, migrate:status/rollback/reset/refresh/fresh, db:seed (--class/--tenant/--force), sync; v1 projects keep v1 commands. `make:migration` (`src/console/make/migration-first.ts`): model for create_*, `--seeder` (seeder + factory, #104 markers), `--factory`.
- Seeders/factories (`src/database/seeding/**`), `DB_*` settings (`src/database/config.ts`), inflection moved to `src/core/inflection.ts`.
- Drizzle-based APIs marked `@deprecated`; minor changeset `.changeset/v2-data-layer.md`; README and CLAUDE.md updated.
- Gate: one full `npm run ci` green (134 files, 2205 passed, 16 skipped; coverage 96.16 stmts / 89.86 branches / 97.42 funcs / 97.16 lines). publint, attw (esm-only), package check, code rules, deps check and `npm audit --omit=dev --audit-level=high` clean.

## Half-done
- Gate x3 under load: the first of the final three runs failed with 7 timeouts (60 s) in v1 PGlite suites (equivalence, early-years, repository, rls, crud, security, planner) while the machine was saturated; runs 2 and 3 were stopped for the pause. The real-server suites already raise their own timeouts (test/helpers/server-database.ts); v1 PGlite suites don't.
- Security review of the new code (not yet fixed): 2 critical and 2 high findings in the F-06 sandbox and in hidden/secret column handling, plus mediums and lows. Details are in the coordinator's copy of the review, deliberately not committed. The sandbox is NOT release-ready until they are fixed.

## Next
1. Fix the security review findings, critical and high first, each with a regression test for the whole class (the list of findings is in the coordinator's private review copy, not in this repo); then the mediums.
2. Stabilise the gate under load (timeouts for PGlite-heavy v1 suites, or limit workers for real-engine files) and get three green runs in a row.
3. Lowercase the remaining v1 error codes per #123 (only new codes are lowercase now).
4. Not built yet: the generated CRUD API over the ORM (blueprint §2.4 step 4), auto-seeding new seeders in development, the `resources/ui` pre-flight lint, observers/events, upserts/chunking/cursor streaming.
