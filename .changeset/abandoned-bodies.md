---
"@strutvane/framework": patch
---

`serve` no longer adapts request bodies with `Readable.toWeb`: a body the app stops reading (a body limit, an upload aborted by the multipart parser) is drained up to 1 MiB so the client receives the 413/422 problem instead of a connection reset, and it can no longer raise an uncaught "Controller is already closed" error.
