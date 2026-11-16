---
"@strutvane/framework": minor
---

`policySchema(Model)` is typed per field (`PolicySchemaOf<M>`), so policy rules over framework models type-check instead of failing with "possibly undefined" columns; field builders carry their kind as a phantom type. Custom route `params` are typed from the path (`RouteParams<P>`), and route handlers get `where(model, filter)` to bind server-written filters for repository calls.
