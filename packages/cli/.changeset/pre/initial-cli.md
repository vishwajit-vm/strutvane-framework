---
"@strutvane/cli": minor
"strutvane": minor
---

First implementation of the Strutvane CLI (Phase 1).

- `strutvane` launcher: delegates every command to the project-local `@strutvane/cli` (local always wins); project-less `new`, `doctor --global`, `--version` and `help`.
- Command framework: colon names with a space alias and unique prefixes, universal flags (`--json`, `--dry-run`, `--diff`, `--yes`, `--force`, `--cwd`, `--no-color`…), documented exit codes, a stable `--json` envelope, catalog-based error messages, and commands contributed by packages through `strutvane.commands` (path-contained, compat-checked).
- Commands: `about`, `doctor`, `env:check`, `key:generate`, `make:model` (field mini-language), `make:resource`, `make:policy`, `make:migration`, `make:seeder`, `make:factory`, `make:test`, `registry:build`, `registry:watch`, `routes`, `models`, `permissions`, `add`, `remove`, `upgrade`, and placeholders for the `migrate*` / `db:*` commands provided by `@strutvane/framework`.
