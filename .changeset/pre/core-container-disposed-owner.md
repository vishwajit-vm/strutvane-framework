---
"@strutvane/framework": patch
---

The container no longer creates a singleton (or scoped instance) in a container that was already disposed. A request scope still running during shutdown used to recreate app-wide services such as a database pool whose cleanup never ran, which could keep the process alive; it now gets a `DISPOSED` error.
