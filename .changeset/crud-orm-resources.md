---
'@strutvane/framework': minor
---

The generated CRUD API works with ORM models (acceptance FW-5): `class CustomerController extends ResourceController<typeof Customer> { model = Customer }` and `resourceController(Customer)` serve list (filter, search, sort, pagination, opt-in totals, include, fields), show, create, update, delete and restore, with validation derived from the model, deny-by-default policies and the tenant scope.

Authorization controls of `ResourceController`:
- `index` ANDs the policy's list scope into the query: the new `Policy.viewScope(user)` returns `true`, `false` or constraints that say in SQL what `view` says for one record. Every listed row is checked against `view` once more. Boot stops with `view_scope_missing` when `view(user, record)` reads the record and the policy has no `viewScope`.
- `store` and `update` write inside a transaction (new `ResourceModel.transaction()`), then read the row again and require `view` (and `update` after an update); a write that moves the row out of the caller's reach is rolled back with 403.
- Every foreign key the client sends must name a row the caller may `view` under the related model's policy (422 `not_found` otherwise, the same answer as a missing row). The model says where a key points through its `belongsTo` (new `ResourceModel.reference()`); boot stops with `unresolved_reference` for a writable foreign key without one.
- Field-level read rules: the new `Policy.readableFields(user)` limits the fields of lists, single records and included rows, and an unreadable field can't be filtered, sorted, searched or selected.
- `?include=` shows only the related rows the related model's policy allows (its list scope and `view`), with its readable fields.

New gate helpers: `listScope()`, `readableFieldsFor()`, `needsViewScope()`.
