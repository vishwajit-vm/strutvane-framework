---
"@strutvane/framework": patch
---

Message lookups and placeholders only use a catalog's or the caller's own entries. A message key or placeholder named like a built-in object member (`constructor`, `toString`, `__proto__`) is now reported as missing instead of resolving to a JavaScript function and printing its source.
