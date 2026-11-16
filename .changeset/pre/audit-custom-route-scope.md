---
"@strutvane/framework": patch
---

Custom routes' `scopeFor` now builds the row filter exactly as the CRUD routes do: `resource.beforeQuery` hooks narrow it, and a policy that cannot be bound (an unknown field, a missing actor attribute) is a 500 instead of a 422 that named the policy's fields.
