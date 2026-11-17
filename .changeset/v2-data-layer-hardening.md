---
'@strutvane/framework': patch
---

Security hardening of the v2 data layer (migration replay sandbox and ORM).

**Replay sandbox.** The static gate and the child process now resolve relative imports with one
shared function that accepts only plain `./`/`../` paths ending in `.ts`. The child loads only
the files the gate approved, pinned by SHA-256 and always as ES modules. It checks its own
confinement before running anything, empties its global scope to an allowlist, freezes what is
left, and runs with frozen intrinsics, a heap cap and no addons. Text from a failing migration is
stripped of control characters before it is shown.

What may break a migrations folder:
- A `package.json` or `node_modules` inside `database/migrations` is refused.
- `module`, `exports`, `__dirname`, `__filename`, `import x = require()` and `export =` are refused.
- Column sizes are bounded: length 1–65,535, precision 1–65, scale up to the precision.
- One migration may record at most 1,000 operations.

**ORM.** Columns that the migration marks `.hidden()` or `.secret()`, and columns named like secrets,
are hidden from every model without listing them in `hidden`. The secret names are `password`,
`*_token`, `*_secret`, `api_key`, `private_key`, `*_access_key`, `recovery_codes` and the like, and
they are now shared with the type and metadata generators. A hidden column is never included in:
- `toJSON()`
- `util.inspect`
- request filters, sorts and searches
- `cursorPaginate()` sort keys (refused with `cursor_hidden_column`)
- "did you mean" hints

A secret column in `fillable` must also be listed in `allowSensitive`, otherwise it is refused with
`secret_fillable`. The conditions a relation, `whereHas`, an eager load or a cursor adds can no
longer be OR-ed away by `orWhere`. Request text for contains/startsWith is capped at 200
characters, and `sort()` takes at most 8 columns. `SqlFragment.trusted` is gone: fragments come
only from the `sql` tag, and every identifier is checked again when the SQL is rendered.
