---
"@strutvane/framework": patch
---

Path checks now follow dangling symbolic links to their target, so a link that points at a protected location (such as a file under `.git/` that doesn't exist yet) is refused like any other protected path. Link loops are refused instead of hanging.
