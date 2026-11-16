---
"@strutvane/framework": patch
---

When `sv dev` or `sv start` cannot bind its address (the port is taken, a privileged port, an interface the machine does not have), the CLI now reports a configuration error that names the host and port and how to change them (`APP_PORT` in `.env`, or `--port`), with exit code 3, instead of "Unexpected error … report the bug".
