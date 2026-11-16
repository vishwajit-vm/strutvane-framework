---
"@strutvane/framework": patch
---

A `hasMany` include that reaches the per-request cap of 1000 children no longer stops silently: a list response carries `meta.truncated` (the relation names, also in the OpenAPI document) and a single-record response the `Strutvane-Truncated-Includes` header. `MAX_INCLUDED_CHILDREN` is exported.
