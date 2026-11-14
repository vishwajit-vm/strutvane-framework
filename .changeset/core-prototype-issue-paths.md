---
"@strutvane/core": patch
---

`toProblem` no longer degrades a validation problem to a 500 when an issue path is named after an `Object.prototype` member (`__proto__`, `constructor`, `toString`, a client-sent unknown field): `fieldErrors` is built from own properties only and labels are read with own-key checks.
