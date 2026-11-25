---
'@strutvane/framework': minor
---

Model lifecycle events and after-commit work (`@strutvane/framework/database`): `save()`, `delete()`, `forceDelete()` and `restore()` emit `<model>.created`, `.updated` (with the changed columns), `.deleted` (soft or not) and `.restored` on the app's event bus after the transaction commits (never for rolled-back work), with the tenant and actor; the payload is the model's `toJSON()`. `modelEventName()` gives the names. `afterCommit(fn)` / `Connection.afterCommit(fn)` run work after the outermost commit (at once outside a transaction, dropped on rollback).
