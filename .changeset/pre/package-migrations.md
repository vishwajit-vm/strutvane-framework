---
"@strutvane/framework": minor
---

`sv migrate` (and `migrate:status`) also apply migrations shipped by packages: a package declares `"strutvane": { "migrations": "./migrations" }` and ships `<folder>/<dialect>/*.sql`, applied and drift-checked like the app's own files (`readPackageMigrations`, `MigrateProjectOptions.packageMigrations`).

Security: these run as the database owner, so the framework never scans `node_modules`. It reads only the folders the CLI vetted (`ctx.packageMigrations()`: enabled in `strutvane.config.ts`, direct dependency, contributor name, compat, real path inside the package), and each dialect folder and file must resolve inside its package. Without that list nothing runs (fail closed). `migrate --pretend` lists package migrations with their package, `migrate:status` has a Source column, and `Applied …` lines name the package.

Pre-release caveat: an app created before this release may have committed `database/migrations/*_auth_identity.sql` (written by the old `sv auth:migration`). On a fresh database, delete that file: `@strutvane/auth` now ships the same tables as a package migration. On a database where it was already applied, keep it (deleting an applied migration is reported as drift); the package migration is idempotent (`CREATE TABLE IF NOT EXISTS`) and records itself under its own name.
