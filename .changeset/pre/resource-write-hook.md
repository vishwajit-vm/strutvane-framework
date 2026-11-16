---
"@strutvane/framework": minor
---

Add the `resource.beforeWrite` hook (create and update, before the database) and a `type` (permission prefix) on `resource.serialize` payloads, so a permission package can enforce field-level read and write rules. A Strutvane error thrown by a hook handler now keeps its status instead of becoming a 500.
