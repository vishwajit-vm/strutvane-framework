<div align="center">

# Strutvane CLI

**The unified Strutvane command line (`strutvane`, `pnpm sv`): generate models and resources, add packages, build the typed registry, list routes and permissions, check your environment and upgrade safely.**

[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Implemented, not yet released.** Version `0.1.0-next.0` of both packages is built and tested (Phase 1) but not on npm yet. Commands and flags may still change before `0.1.0`.

## What it is

Strutvane CLI is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for building enterprise B2B applications. This repository publishes two packages, released together:

| Package | What it is |
|---|---|
| [`strutvane`](packages/launcher) | The tiny `strutvane` launcher (zero dependencies). Install it globally or run it with `npx`. Inside a project it **delegates every command to the project's own `@strutvane/cli`**, so generators always match the versions in `package.json`. |
| [`@strutvane/cli`](packages/cli) | The CLI itself: command framework, generators, registry compiler, installers and upgrades. Add it to each project as a dev dependency. |

## Quick start

```bash
pnpm add -D strutvane @strutvane/cli   # create-strutvane adds both, plus the script "sv": "strutvane"
pnpm sv make:model Invoice number:string:unique "amount:decimal(12,2):min(0)" "customer:belongsTo(Customer)"
pnpm sv routes
pnpm sv doctor
```

Outside a project, the launcher offers `strutvane new <name>` (runs `create-strutvane`), `strutvane doctor --global`, `--version` and `help`.

## Commands

| Command | What it does |
|---|---|
| `about` | Versions of the CLI, Node.js and every installed Strutvane package |
| `doctor [--global]` | Checks Node.js, package.json, env files, `.gitignore`, the registry, owned-file conflicts and plugin compatibility. Exits 3 on failures |
| `env:check [--env <name>] [--strict]` | Compares `.env` with `.env.example`: missing, unknown, empty and invalid keys, and secrets committed in `.env.example`. Never prints values |
| `key:generate [--force] [--show]` | Writes `APP_KEY` to `.env` (and an empty entry to `.env.example`). Never prints the key unless `--show` |
| `make:model <Name> [fields…]` | Model, policy, factory, seeder and feature test (`--all` adds the resource). Interactive field builder when run in a terminal without fields |
| `make:resource <Model>` | Resource with `--actions approve,send` and `--hooks beforeCreate,afterUpdate` |
| `make:policy <Model>` | Deny-by-default policy, `--template default\|owner\|tenant-admin\|readonly` |
| `make:migration <name>` | Hand-written migration stub (`--sql`, `--table`) |
| `make:seeder <Name>` / `make:factory <Model>` / `make:test <name>` | Seeder (`--model`, `--count`), factory from the model's field types, feature/unit/e2e test |
| `registry:build [--check]` / `registry:watch` | Compiles conventions into the typed `.strutvane/registry.gen.ts` without running app code (ADR-0010). `--check` exits 6 when stale |
| `routes` / `models` / `permissions` | Read the registry: CRUD, action and custom routes with permissions; models with fields and relations; every permission |
| `add <package>` / `remove <package>` | Install a package and run its devkit installer (all-or-nothing, previewable). Unknown flags become installer answers: `sv add auth --methods email` |
| `upgrade [--to <v> \| --channel <tag>]` | Bumps Strutvane packages, three-way merges owned files (ADR-0012), then runs the project's `tsc --noEmit` |
| `migrate*`, `db:*` | Provided by `@strutvane/framework` through its `strutvane.commands` module; the CLI explains how to install it when missing |

Every command supports `--json`, `--dry-run`, `--diff`, `--yes`, `--no-interactive`, `--force`, `--cwd <path>`, `--env <name>`, `--verbose`, `--quiet` and `--no-color`. `sv make model` is the same as `sv make:model`, and unique prefixes work (`sv mi:st` → `migrate:status`).

### Field syntax

```
name:type[(args)][:modifier[(args)]]…

title:string(200):required:searchable
amount:decimal(12,2):min(0):sortable
"status:enum(draft,sent,paid):default(draft):filterable"   # quote parentheses in shells
customer:belongsTo(Customer)
due:date:label("Due date, local")                           # quote arguments with , ( ) : or spaces
```

Errors name the problem and the column: `Invalid field "status:enum(draft,paid):default(sent)": default "sent" is not one of: draft, paid. (column 33)`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure (a failed child process, an unexpected error) |
| 2 | Invalid usage: unknown command or flag, bad argument, input needed but prompting disabled |
| 3 | Validation failed: field specs, registry diagnostics, env problems, doctor failures |
| 4 | Conflict: merge conflicts written, a file exists, an owned file, an existing `APP_KEY` |
| 5 | Database error (framework commands) |
| 6 | Pending action required (`registry:build --check`, `migrate --check`) |
| 7 | Incompatible versions (`strutvane.compat`) |
| 130 | Interrupted (Ctrl+C) |

### `--json`

Every command prints exactly one JSON document on stdout (diagnostics go to stderr, and are suppressed):

```json
{ "schemaVersion": 1, "ok": false, "command": "make:model", "exitCode": 3, "data": null,
  "error": { "code": "INVALID_FIELD", "message": "…", "hint": "…", "issues": [] }, "warnings": [] }
```

## Commands from packages and plugins

A dependency named `@strutvane/*`, `strutvane-plugin-*` or `@scope/strutvane-plugin-*` can contribute commands:

```json
{ "strutvane": { "commands": "./dist/commands.js", "compat": "^0.1.0" } }
```

```ts
import { defineCommand } from '@strutvane/cli'

export default defineCommand({
  name: 'reports:send',
  description: 'Send monthly reports',
  args: { month: { required: true } },
  flags: { 'dry-run-email': { type: 'boolean' } },
  run({ args, out }) {
    out.success(`Sent reports for ${args.month}`)
    return { data: { month: args.month } }
  },
})
```

The module must resolve inside the package's own folder in `node_modules` (symlinks included); anything else is refused without being executed. Packages whose `compat` range excludes the CLI are refused (exit 7). A plugin can never replace a built-in command.

## Development

This repository is a private pnpm workspace (`packages/cli`, `packages/launcher`). From the root:

```bash
corepack pnpm@12.18.0 install
corepack pnpm@12.18.0 run ci     # biome → tsc → vitest (coverage 90/90/85/90) → tsdown
```

## Documentation

- **Package specification:** [09-cli-reference.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/09-cli-reference.md)
- **Decisions:** [ADR-0010 registry compiler](https://github.com/vishwajit-vm/strutvane/tree/main/docs/adr), ADR-0012 three-way merge, ADR-0016 release flow
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
