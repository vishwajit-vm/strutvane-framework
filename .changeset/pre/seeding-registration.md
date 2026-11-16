---
"@strutvane/framework": minor
---

Seeding: `related('Model')` in a factory now reuses an existing parent in the same tenant (spreading children over the first 100 in turn) and creates one only when none exists; `related('Model', { create: true })` keeps the old always-create behaviour. `sv db:seed` warns, naming the files and the fix, when `DatabaseSeeder` ran no other seeder while other seeder files exist. The documented seeder shape is `defineSeeder('Name', async ({ call, create }) => …)`.
