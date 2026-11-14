---
"@strutvane/framework": patch
---

`serve()`, `startServer()` (`sv start`) and `sv dev` report a port they cannot bind as `ServerListenError` with a stable `code` (`PORT_IN_USE`, `PORT_ACCESS_DENIED`, `ADDRESS_NOT_AVAILABLE`), the `host` and `port`, and how to change them (`APP_PORT` or `--port`), instead of a raw Node error. `sv dev` checks the port (and loads the config) before starting its watched child, which would otherwise wait for file changes instead of exiting.
