---
'@strutvane/framework': minor
---

The v2 data layer: migration-first schema and Strutvane's own ORM (blueprint §2.3, §2.4, §4).

**Migrations are the source of truth.** `database/migrations/*.ts` use Laravel's Schema builder
from the new `@strutvane/framework/schema` entry (`schema.create('posts', (t) => { … })`, with
`.secret()`, `.hidden()`, `t.tenant()`, `{ global: true }`, `{ internal: true }`, UUIDv7 keys and
tenant-safe composite keys). They are replayed offline, in a sandboxed child process (no secrets,
no network, a timeout, symlinks refused), into `.strutvane/types/models.d.ts`,
`.strutvane/resources.json`, `.strutvane/schema.json` and per-engine SQL.

**The ORM** (`@strutvane/framework/database`): `class Post extends Model('posts', { fillable })`,
a typed query builder, relations, casts, scopes, soft deletes, slugs, pagination, transactions
with savepoints, the tenant scope, and `wherePolicy()` for ADR-0008 policy filters. It runs on
MySQL 8.4+ (the default), MariaDB, PostgreSQL (node-postgres or PGlite) and SQLite (`node:sqlite`).
PostgreSQL tables with `t.tenant()` get ADR-0007 row-level security from their migration.

**Commands** for migration-first projects: `migrate` (`--pretend`, `--step`, `--seed`, `--force`,
`--isolated`), `migrate:status`, `migrate:rollback`, `migrate:reset`, `migrate:refresh`,
`migrate:fresh`, `db:seed` (`--class`, `--tenant`, `--force`), `sync`, and `make:migration`
(writes the model; `--seeder` adds the seeder and factory). Production needs `--force`.
`defineSeeder({ after, run })` and `defineFactory(Model, ({ faker, sequence }) => …)` are new.

**Configuration:** `DB_CONNECTION` = `mysql` | `mariadb` | `pgsql` (`postgres` accepted) |
`sqlite`, plus `DB_URL`, `DB_SOCKET`, `DB_SSLMODE` and `DB_SSL_CA`. `mysql2` is a new optional
peer dependency.

**Upgrading from 0.1 (breaking, pre-1.0):**
- v1 (`defineModel`) projects keep working: the commands detect them and run the v1 path.
- Drizzle-based planning (`planMigration`, `compilePg`, `compileSqlite`, `writeMigration`,
  `migrateProject`, …) is deprecated and will be removed in 0.3. Move models' columns into
  migrations, then use `node strut migrate`.
- `defineSeeder({ run })` (object form) now receives the migration-first context
  (`{ db, env, tenantId, faker, call }`); the string form keeps the v1 context.
- Tenancy in the ORM is off unless enabled (`config/tenancy.ts`), and a `t.tenant()` table is
  refused while it is off.
- New error codes are lowercase `snake_case`; existing v1 codes are unchanged in this release.
