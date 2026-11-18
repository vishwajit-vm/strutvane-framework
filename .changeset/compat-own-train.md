---
"@strutvane/framework": patch
---

The framework's `strutvane.compat` now accepts its own 0.2 release train (`^0.2.0-next.0`). In 0.2.0-next.0 it still said `^0.1.0-next.0`, so the 0.2 CLI refused the framework's own `migrate`, `db:seed`, `sync`, `start` and `dev` commands in a 0.2 app. The CLI also never refuses the package it ships in at its own version, and the advice it gives plugin authors without a range (`node strut doctor`, the `missing_compat` hint) now names the running CLI's train instead of a fixed `^0.1.0`. A test fails whenever the range stops accepting the package's version, so the next version bump can't repeat this.
