---
"@strutvane/framework": patch
---

The logger keeps fields whose key is `__proto__` (common in parsed JSON) instead of silently dropping them from the log line, and still redacts sensitive keys inside them.
