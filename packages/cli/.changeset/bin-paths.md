---
"@strutvane/cli": patch
"strutvane": patch
---

The `bin` entries in package.json no longer start with `./`, so npm publishes them as written instead of reporting them as auto-corrected.
