---
"@strutvane/framework": patch
---

Messages, help text, generated files and TSDoc no longer name pnpm, corepack or the absorbed `@strutvane/core`/`cli`/`contracts`/`devkit` packages: the `make:model` field-syntax help talks about the `.cmd` shims of npm and npx, the generated database seeder says `sv db:seed`, built-in error codes are owned by `@strutvane/framework`, and the "install the project dependencies" hint of `sv dev` uses the project's own package manager (`packageManager` field, then the lockfile, else npm; `detectPackageManager` and `installCommand` in `/core`).
