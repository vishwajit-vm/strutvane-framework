# v2/data-layer: progress notes (temporary, removed before merge)

## Done
- `src/schema/**`, `src/entries/schema.ts`, `test/schema/**`: spike 10's offline pipeline (Schema builder, recorder, replay, types/resources.json/schema.json/SQL generation, DDL for SQLite/PostgreSQL/MySQL/MariaDB, MySQL index lint), plus #97 modifiers, tenant composite FKs and uniques (F-05, #92), UUIDv7 keys (#93). 199 tests green (`npx vitest run test/schema`).
- Spike 11's ORM copied verbatim into `src/database/{db,orm,sql,schema}` and its tests into `test/database/**` (WIP: not adapted yet, does not type-check).
- `mysql2@3.24.6` added as a dev dependency (to become an optional peer).

## Next
1. Adapt the ORM to the repo rules (isolatedDeclarations, imports, lazy mysql2, Biome), snapshot from `src/schema/columns.ts`.
2. node-postgres ORM driver with ADR-0007 rules; real-engine globalSetup (MySQL 8.4, MariaDB 11.4, PostgreSQL 18, uniquely named containers, removed after).
3. Policy compiler (ADR-0008) emitting through the grammar; RLS wiring.
4. v2 migrator (`migrations` table, batches, rollback/fresh/refresh/step/pretend/isolated, #121 atomicity, MySQL resume), introspection + drift, F-06 replay sandbox.
5. Commands: make:migration (+ model, `--seeder` → seeder + factory with #104 markers), migrate*, db:seed; defineSeeder/defineFactory v2; DB_CONNECTION/DB_URL/DB_SOCKET/DB_SSLMODE/DB_SSL_CA.
6. Deprecate Drizzle-based v1 APIs; `./schema` export; changeset (minor); gate x3.

## Test state
- Baseline `npm run ci` on main: 1465 passed, 1 load-sensitive failure (serve-lifecycle grace period) while another job was running.
- `test/schema` green; `test/database` not yet compiling (WIP).
