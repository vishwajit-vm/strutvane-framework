---
"@strutvane/framework": patch
---

`PATCH /<resource>/:id` checks that the caller may update some rows before it reads and validates the body, so an anonymous or unauthorized caller gets 401/403 instead of field-level validation issues describing the schema.
