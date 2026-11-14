---
"@strutvane/cli": patch
---

`make:model` (and `make:seeder <Name> --model <Model>`) register the new seeder in `database/seeders/database.seeder.ts`, the only seeder `sv db:seed` runs, so seeded models get rows. The command adds the import (in Biome's import order) and `await call(XSeeder)`, and gives the callback a `({ call })` parameter. Calls are ordered so a model's parents are seeded before it; a parent that has no registered seeder yet is named in a warning. Running it again changes nothing. A missing file is created in the shape `create-strutvane` generates, and the starter's older `defineSeeder({ async run() {…} })` file is updated to that shape. Any other content is left as it is, and the lines to add are printed instead. `--dry-run`/`--diff` include the change, `--no-seeder` skips it, and `--json` reports it as `seederRegistration`.
