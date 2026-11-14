---
"@strutvane/cli": patch
---

Safer defaults across the CLI:

- Project detection matches the launcher: a project is a folder whose package.json lists `@strutvane/cli` or that contains `strutvane.config.ts`, never a drive root, the temp folder or a folder above home, and on POSIX one owned by the current user.
- `APP_ENV` is resolved as the runtime does (process environment, then `.env.<name>` with `--env`, then `.env`; empty means unset; trimmed and case-insensitive). Destructive commands run without confirmation only in `local`, `test`, `testing` or `development`; otherwise they need `--force --i-understand`. Commands receive the resolved value as `ctx.appEnv` and can call `ctx.guardDestructive()`; `--env <name>` now loads `.env.<name>` for the command.
- Destructive commands must be typed in full (no prefix matching).
- `key:generate --force` is guarded the same way when it replaces a key, and replaces every `APP_KEY` line.
- `env:check` and `doctor` report malformed env lines and invalid keys by file and line number only.
- On Windows, programs are resolved from PATH (never the working directory) and child processes get `NoDefaultCurrentDirectoryInExePath=1`.
- Generator inputs are validated against the field catalogue (types, modifiers and argument formats), and numbers are re-checked when templates render.
- The field parser only accepts the catalogue's own entries, and `make:*` refuses names that would create Windows device file names.
- Plugins outside `@strutvane/` must declare `strutvane.compat`; manifest text is printed without control characters.
- `registry:build` refuses to write through a symbolic link or junction at `.strutvane`.
