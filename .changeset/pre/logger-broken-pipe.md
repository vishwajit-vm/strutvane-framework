---
"@strutvane/framework": patch
---

The core logger no longer crashes the app when the reader of stdout goes away (EPIPE from a closed pipe, a restarted log shipper, `sv start | head`). The asynchronous stream error used to become an uncaught exception; now the records are counted as dropped, one warning goes to stderr, and the app keeps running. A broken stderr is contained the same way.
