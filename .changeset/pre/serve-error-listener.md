---
"@strutvane/framework": patch
---

`serve()` keeps an `error` listener on the Node server for its whole life. An error the listening server emits (an accept failure such as `EMFILE` when the process runs out of file descriptors) is reported through `onError` instead of crashing the process; the server keeps serving.
