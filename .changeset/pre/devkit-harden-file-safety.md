---
"@strutvane/framework": patch
---

Harden file safety in transactions, recovery, previews and env handling.

- Paths under `.git/`, `node_modules/` and `.strutvane/staging/` (at any depth) are refused with `INVALID_PATH`, including through letter case, Windows aliases and links. The rest of `.strutvane/` stays writable.
- Transaction recovery validates every journal before changing anything, only restores project files plus `.strutvane/lock.json` and `.strutvane/base/**`, only replaces or unlinks single regular files, and refuses journals owned by another user. New `planRecovery()` lists the affected paths; `recoverTransactions({ confirmed })` recovers exactly that plan.
- File permissions are preserved when a file is replaced. New `.env`/`.env.*` files, backups and journals are created owner-only, staging folders are owner-only, and a linked `.strutvane` or `.strutvane/staging` folder is refused.
- Diffs redact the values of `.env`/`.env.*` files (except `.env.example`) by default; `StagedFs.diff({ revealSecrets: true })` opts out.
- `looksSecret(key, value?)` recognises more secret-looking names (`*_PASS`, `*_PWD`, `*_DSN`, `SALT`, `SIGNING`, `ACCESS_KEY`, …) and URLs with embedded credentials, which therefore never reach `.env.example`.
- `DevkitIo` gains two required methods, `removeFile` and `inspect`, and `writeText` accepts an optional `{ mode, dirMode }`. Custom implementations that spread `nodeIo` keep working; others must add the two methods.
