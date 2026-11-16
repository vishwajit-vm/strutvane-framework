---
"@strutvane/framework": patch
---

`bootProject()` (used by `sv start`, `sv dev` and `startServer()`) shuts the app down again when a provider fails to boot, so the providers that had already booted release their connections, pools and timers instead of keeping the process alive after the error. Booting is also bounded: a provider whose `boot()` never settles fails with `BootTimeoutError` after `bootTimeoutMs` (default `DEFAULT_BOOT_TIMEOUT_MS`, 30 s) instead of hanging `sv start` forever.
