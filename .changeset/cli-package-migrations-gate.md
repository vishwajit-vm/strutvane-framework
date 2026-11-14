---
"@strutvane/cli": minor
---

Gate package migrations (they run as the database owner): `ctx.packageMigrations()` returns the migration folders of packages that are direct dependencies with a contributor name, enabled by a value import in `strutvane.config.ts`, compatible (`strutvane.compat` required for third-party packages, exit 7), and whose folder resolves inside the package in `node_modules` (`UNSAFE_CONTRIBUTION`). `sv migrate` (from `@strutvane/framework`) applies only those. `sv doctor` warns about dependencies whose migrations are ignored and fails on an enabled package that fails the gate.
