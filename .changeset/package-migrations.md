---
"@strutvane/framework": minor
---

`sv migrate` (and `migrate:status`) also apply migrations shipped by the app's dependencies: a package declares `"strutvane": { "migrations": "./migrations" }` and ships `<folder>/<dialect>/*.sql`, applied and drift-checked like the app's own files (`readPackageMigrations`).
