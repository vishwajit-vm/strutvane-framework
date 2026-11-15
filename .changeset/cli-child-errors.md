---
"@strutvane/framework": patch
---

`sv dev` and `sv build` handle a child process that cannot start (a missing working directory, descriptor or process exhaustion): it counts as exit code 1 instead of crashing the CLI with an uncaught `error` event or waiting forever for an `exit` that never comes. `sv dev` also removes its Ctrl+C/SIGTERM forwarding listeners once the child is gone. Both use the new `runChild()` helper.
