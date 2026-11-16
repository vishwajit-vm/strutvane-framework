---
"@strutvane/framework": minor
---

`Idempotency-Key` is honoured on POST and DELETE: CRUD create, delete and restore, and custom routes. A retry with the same key and body gets the first response replayed (`Idempotent-Replayed: true`, with only `content-type` and `location` restored) instead of running the action twice; the same key with a different body, method or path is a 422 `idempotency_key_reused`; a duplicate while the first is still running is a 409 `idempotency_in_progress`; a malformed key is a 400 `idempotency_key_invalid`. Keys are scoped to the caller and tenant. 5xx answers are not stored, so the retry runs for real. The in-memory store keeps at most 10,000 keys for 24 h (`createHttpApp({ idempotency: { ttlMs, maxEntries } })`); bind `IdempotencyStoreToken` for a shared store in a cluster.
