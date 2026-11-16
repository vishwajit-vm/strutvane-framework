---
"@strutvane/framework": patch
---

Migrations (and `db:seed`) on Postgres run on their own connection settings instead of the API pool's: no statement timeout (the API's 5 s limit, or a role default, used to kill long index builds and table rewrites half way), no client-side query timeout, one connection, and a `lock_timeout` of 10 s so a migration waiting on a lock held by live traffic fails fast and can be retried. Set it with `DB_MIGRATION_LOCK_TIMEOUT` (milliseconds, or `30s`, `2min`; `0` waits forever); a malformed value is reported as an invalid environment. The new `pool.lockTimeoutMs` option sets `lock_timeout` for any Postgres connection.
