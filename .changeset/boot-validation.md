---
"@strutvane/framework": patch
---

`sv start` and `sv dev` now check the settings the framework reads before booting, and a malformed one stops the boot with exit 3 and an "Invalid environment" message naming the key, instead of booting with a broken value or exiting 1 with a driver error: `APP_TIMEZONE` (an IANA zone), `APP_LOCALE` (a language tag), `API_PREFIX` (a path starting with `/`), `CORS_ORIGINS` (exact origins, no `*` or paths), `TRUST_PROXY` (0–32; empty is refused), `APP_URL` (an http(s) URL) and `DB_DATABASE` (a SQLite file whose folder exists, not a folder). Every problem is listed at once and values are never printed.
