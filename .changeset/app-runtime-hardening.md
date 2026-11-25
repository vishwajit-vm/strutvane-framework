---
"@strutvane/framework": minor
---

Safer defaults for tenancy, routes, storage and logs.

- **Hand-written SQL and tenancy:** with tenancy on, `connection.run(sql…)` and `whereRaw` that name a tenant table now need an active tenant even when none is set (before, no tenant meant no check). Without one they fail with `tenant_required`. Work with no tenant on purpose runs in the new `runWithoutTenant(reason, fn)` (exported from `@strutvane/framework/database`), reported to `onUnsafeTenancy` with `kind: 'scope'`. Migrations, seeders without `--tenant`, the `migrate`/`db:seed` family and an app's own console commands enter it for you; HTTP requests never inherit it.
- **CSRF on package routes:** `app.addRoutes(routes)` without a middleware group now gets the `csrf` middleware, like the `web` and `api` groups. A webhook opts out with `.withoutMiddleware('csrf')`, shown in `route:list --security`.
- **Storage layout:** the default `local` disk is `storage/app/private` (was `storage/app`, which held `storage/app/public`). Boot fails with `invalid_filesystems_config` when two local disks share a folder or nest. A local disk keeps its metadata and partial uploads beside its root (`<parent>/.strutvane-disks/<root name>/`), moving older in-root folders out on first use. `storage:link` refuses a folder holding files stored as private (`storage_link_private_files`). An overwrite never serves new bytes under the old file's metadata.
- **Serving stored files:** inline only for display-only types (images, PDF, plain text, audio, video); everything else is an `application/octet-stream` attachment. A stored content type must be one media type (no list, quote or control character).
- **XSRF cookie:** never added to a response a shared cache may store (`Cache-Control: public` or `s-maxage`).
- **Logs:** error messages, stacks and causes are redacted by value in core's fallback logger too (connection strings, bearer tokens, JWTs, API keys, card numbers), as the logging pipeline already did.

Upgrading: move files from `storage/app` (outside `public/`) to `storage/app/private`, or set `root: 'storage/app/private'` explicitly; a `config/filesystems.ts` whose `local` root is `storage/app` next to a `public` disk at `storage/app/public` must change.
