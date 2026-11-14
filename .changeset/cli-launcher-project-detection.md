---
"@strutvane/framework": patch
---

Project detection is stricter: the launcher delegates only to a folder whose package.json lists `@strutvane/cli` or that contains `strutvane.config.ts`, never to a drive or file-system root, the OS temp folder or a folder above the home directory, and (on POSIX) only to folders owned by the current user. `--version`, `help`, `new` and `create` are always answered by the launcher itself. `npx` now runs as `node npx-cli.js` without a shell when available; the Windows fallback resolves `npx.cmd` from PATH only and child processes get `NoDefaultCurrentDirectoryInExePath=1`. Text read from manifests is printed without control characters, and an invalid `STRUTVANE_CREATE_COMMAND` is reported instead of crashing.
