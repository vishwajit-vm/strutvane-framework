---
"@strutvane/framework": patch
---

`createTestApp()` from `@strutvane/framework/testing` accepts a `clock` option. Pass a `createTestClock()` to test anything time-based, such as idempotency TTLs or expiry, by moving time yourself. Tests then neither wait nor fail on a slow machine.
