---
"@strutvane/framework": patch
---

The runtime now loads a `.env` file saved with a UTF-8 byte-order mark correctly. Node's `.env` parser kept the mark as part of the first key, so that variable was silently missing at runtime while `sv env:check` reported it as set.
