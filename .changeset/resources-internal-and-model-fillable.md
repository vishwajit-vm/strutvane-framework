---
"@strutvane/framework": patch
---

`.strutvane/resources.json` no longer exposes framework or identity tables and takes mass assignment from the models. In 0.2.0-next.0 tables such as `sessions`, `cache`, `cache_locks` and `password_reset_tokens` became sidebar resources unless their migration said `{ internal: true }`, and `fillable` came from the migration, so `users.email_verified_at` was fillable although `User` allows only `name` and `email`.

- Every table on `INTERNAL_TABLES` (the list the resource controller already refuses, security review F-01) is now listed under `internal` instead of `resources`, together with `{ internal: true }` tables, and relations to them are left out. This includes `users` and `teams`: they get no auto CRUD or sidebar entry (`@strutvane/auth` provides the users screen).
- `sync` and `migrate` read `fillable`, `hidden` and `allowSensitive` from `app/models` without running them. A field is fillable only when the table's model lists it, and a model with no `fillable` makes nothing fillable. Secrets, hidden columns and privilege-like names (`is_*`, `*_at`, `role`…) need `allowSensitive` too. Without a model, only plain columns are fillable. Model options that aren't literal string arrays produce a warning and nothing fillable (fail closed).
- `primaryKey` is the table's real primary key (`t.uuid('code').primary()` gives `code`), not always `id`.
