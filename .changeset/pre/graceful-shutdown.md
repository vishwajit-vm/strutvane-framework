---
"@strutvane/framework": patch
---

Graceful shutdown for `sv start` and `startServer()`:
- `stopOnSignals()` also stops on the IPC message `'shutdown'` (`SHUTDOWN_MESSAGE`, the PM2 convention) when the process has an IPC channel. On Windows an external SIGTERM kills the process without running any handler, so this is how a process manager or `sv` asks for a drain there (ADR-0015).
- It resolves with the reason (`'SIGINT' | 'SIGTERM' | 'shutdown-message'`), and `sv start` exits with 143 after a SIGTERM (it used to exit 0, so a process manager could not tell a requested stop from anything else). `exitCodeForStop()` maps the reasons.
- A failing stop is logged ("Graceful shutdown failed") instead of being swallowed.
