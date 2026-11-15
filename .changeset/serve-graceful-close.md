---
"@strutvane/framework": patch
---

`RunningServer.close()` (and so `sv start`'s shutdown) drains instead of resetting: it stops accepting connections, closes idle keep-alive connections, lets requests already in flight finish (their responses carry `Connection: close`), and only after a grace period (`close({ graceMs })`, default `DEFAULT_CLOSE_GRACE_MS`, 8 s) cuts what is left, aborting those requests' signals. Before, every in-flight request lost its connection the moment shutdown began. `close()` is also idempotent now; a second call used to reject with "Server is not running".
