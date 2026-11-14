---
"@strutvane/cli": patch
---

`registry:watch` runs one catch-up rebuild shortly after it starts, so a change made while the native file watchers are still starting (notably on macOS) is no longer missed.
