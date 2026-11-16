---
"@strutvane/framework": patch
---

Factory definitions and overrides (`defineFactory`, `create`, `createMany`, `attributes`) accept every column of the model, `readOnly` and `hidden` ones included, typed per field (`FactoryAttributes<M>`), so tests and seeders no longer need casts. `readOnly` is an API rule for clients; system columns (`id`, timestamps, `deletedAt`) stay out.
