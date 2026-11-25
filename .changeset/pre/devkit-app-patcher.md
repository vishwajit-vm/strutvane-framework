---
'@strutvane/framework': minor
---

Devkit: `createAppPatcher()` and `context.app` in installers add or remove a provider in `bootstrap/providers.ts` and a config file in `config/index.ts` (parsed, minimal edits, idempotent, reversible byte for byte). A file in an unfamiliar shape is never touched: the installer prints the lines to add by hand instead of failing.
