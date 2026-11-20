---
'@strutvane/framework': minor
---

Queues (RFC-0006): `defineJob` jobs with retries and backoff, timeouts, unique jobs, chains,
`afterCommit` dispatch and tenant context restored in the worker; signed plain-data payloads
(no code, no secrets); the `database` driver (SQLite, MySQL, MariaDB, PostgreSQL), plus `sync` and
`memory`; failed jobs; `config/queue.ts` and `QUEUE_CONNECTION`; the `Queue` and `Bus` facades;
`node strut queue:table`, `queue:work`, `queue:restart`, `queue:failed`, `queue:retry`,
`queue:forget`, `queue:flush` and `queue:clear`; `Connection.afterCommit()`; the
`@strutvane/framework/queue` subpath, and `queueDriverContract` on `/testing` for add-on drivers.
