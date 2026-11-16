---
"@strutvane/framework": patch
---

Postgres pools are bounded on the client side too. `pool.connectionTimeoutMs` (default `DEFAULT_CONNECTION_TIMEOUT_MS`, 5 s) limits the wait for a pooled connection, so an exhausted pool or an unreachable server fails the request instead of queueing it forever. `pool.queryTimeoutMs` (default `statementTimeoutMs` + 2 s, or 30 s when the statement timeout is off; `0` disables it) fails a query whose server stopped answering (frozen, partitioned), where `statement_timeout` cannot fire; the connection is destroyed rather than reused.
