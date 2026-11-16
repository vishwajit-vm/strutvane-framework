# v2/data-layer: progress notes (temporary, removed before merge)

## Done
- Schema pipeline (`src/schema/**`, `@strutvane/framework/schema`): Schema builder, replay, generators, DDL for SQLite/PostgreSQL/MySQL/MariaDB, MySQL index lint, #97 modifiers, tenant composite keys (F-05, #92), UUIDv7 keys (#93), ADR-0007 RLS emitted for `t.tenant()` tables on PostgreSQL.
- ORM (`src/database/**`, `@strutvane/framework/database`): spike 11 adapted; drivers mysql2 (lazy), node-postgres (new), PGlite, node:sqlite; `wherePolicy()`; tenancy off by default and fail-closed (#90).
- ADR-0008 compiler `compileFilterSql` through the grammar (all 4 dialects); v1 `compileFilter` delegates to it.
- v2 migrator (`src/migrations/runner.ts`), introspection, F-06 sandbox (`sandbox.ts`, `replay-worker.ts`).
- Commands: migrate*, db:seed, sync (`src/runtime/schema-commands.ts`), make:migration (`src/console/make/migration-first.ts`); seeders/factories (`src/database/seeding/**`); DB_* settings (`src/database/config.ts`).
- Drizzle-based APIs marked `@deprecated`; minor changeset `.changeset/v2-data-layer.md`.
- Real engines: uniquely named MySQL 8.4 / MariaDB 11.4 / PostgreSQL 18 containers via `test/helpers/db-servers.ts`.

## Next
- Gate x3, publint/attw/package check, dist sandbox smoke test.
- Not built (see the report): generated CRUD API over the ORM, auto-seeding new seeders in development, observers/events, upserts/chunking.
