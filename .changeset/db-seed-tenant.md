---
"@strutvane/framework": minor
---

`sv db:seed --tenant <id>` seeds a tenancy app: seeders get `scope` (`{ tenantId }`) and `tenantId`, and `create(factory, count)` uses the run's scope by default. Without the flag, a tenant-scoped model now fails with a validation error that names `--tenant` instead of `TENANT_REQUIRED`; a malformed id is refused before anything runs. `sv make:seeder` generates `async ({ create, scope }) => { await create(Factory, n, scope) }`.
