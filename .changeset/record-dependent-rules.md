---
"@strutvane/framework": patch
---

Row actions no longer require a record-less `can()` to pass: a conditional rule ("members update their own records", a role map `own: true` grant) could never be satisfied on show, update, delete or restore. The action is allowed when `can()` allows it or the row filter is not FALSE; delete and restore are now also checked against the record itself, so a record-level refusal (`deny('delete', { when: … })`) is enforced.
