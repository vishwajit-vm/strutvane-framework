---
'@strutvane/framework': minor
---

Queues (RFC-0006): `defineJob` jobs with retries and backoff, timeouts, unique jobs, chains,
batches, the transactional outbox, `afterCommit` dispatch and the tenant restored in the worker;
signed plain-data payloads (no code, no secrets); the `database` driver (SQLite, MySQL, MariaDB,
PostgreSQL), plus `sync` and `memory`; failed jobs; `config/queue.ts` and `QUEUE_CONNECTION`; the
`Queue` and `Bus` facades; `node strut queue:table`, `queue:work`, `queue:restart`,
`queue:failed`, `queue:retry`, `queue:forget`, `queue:flush`, `queue:clear`,
`queue:prune-batches` and `queue:prune-outbox`; `Connection.afterCommit()`; the
`@strutvane/framework/queue` subpath, and `queueDriverContract` on `/testing` for add-on drivers.
