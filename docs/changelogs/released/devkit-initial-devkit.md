---
'@strutvane/devkit': minor
---

First implementation of `@strutvane/devkit`: the SDK behind `sv add`, `sv make:*` and `sv upgrade`.

- Staged file system with multi-file transactions (journal, rollback, crash recovery) and path/symlink safety.
- `.env` + `.env.example` editor (secrets never reach `.env.example`), `package.json` dependency editor, and `strutvane.config.ts` provider patcher.
- Installer runtime (`defineInstaller`, `runInstaller`, dry runs, `checkIdempotent`, uninstall).
- Generators with Standard Schema inputs and plain-function templates.
- Normalising three-way merge for ejected files (`planUpgrade`, `applyUpgrade`, lock + merge bases, two-way fallback).
