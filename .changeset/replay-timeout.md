---
"@strutvane/framework": patch
---

The migration replay sandbox's timeout can now be raised: `--replay-timeout=30s` on `migrate`, `migrate:status`, `migrate:rollback`/`reset`/`refresh`/`fresh`, `db:seed` and `sync`, or `DB_MIGRATION_REPLAY_TIMEOUT=30s` in `.env` (the flag wins). The default stays 10 s; values must be from 1 s to 10 min (`30000`, `30s`, `2min`) and anything else is refused naming the flag or key. `replayInSandbox(dir, { timeoutMs })` checks the same bounds, and the timeout error now says how to allow more time.
