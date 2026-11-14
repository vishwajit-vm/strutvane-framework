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

Until 1.0, every Strutvane package is published under the npm dist-tag `next` (`latest` only holds a name placeholder), so name the tag: `npm create strutvane@next`, `npx strutvane@next new acme`, `pnpm add -D strutvane@next @strutvane/cli@next`. From 1.0 these become `@latest` (or no tag at all).

```bash
npm create strutvane@next acme         # or: npx strutvane@next new acme
cd acme
pnpm add -D strutvane@next @strutvane/cli@next   # only for an existing app; create-strutvane adds both, plus the script "sv": "strutvane"
pnpm sv make:model Invoice number:string:unique "amount:decimal(12,2):min(0)" "customer:belongsTo(Customer)"
pnpm sv routes
pnpm sv doctor
```

Outside a project, the launcher offers `strutvane new <name>`, `strutvane doctor --global`, `--version` and `help`.

### Release channel

The launcher and the CLI fetch other Strutvane packages from the npm dist-tag they were released under themselves: a `0.1.0-next.N` build uses `next`, a `0.2.0-canary.N` build uses `canary`, and a stable build uses `latest`. So `strutvane new` runs `create-strutvane@next` (from 1.0: `create-strutvane@latest`), `sv add auth` installs `@strutvane/auth@next` (from 1.0: `@strutvane/auth`), and install hints name the same tag. The channel is derived exactly as the release workflow derives the tag it publishes to; a version that does not fit (not strict semver, an unusual prerelease id) falls back to `latest`. `strutvane doctor --global` runs `@strutvane/cli` at the launcher's exact version, because the two are always released together. Third-party plugins are installed by their bare name.

### Which folder is a project

The launcher (before delegating) and the CLI (before loading plugins or reading `.env`) use the same rules. A folder is a project only when its `package.json` lists `@strutvane/cli` in `dependencies` or `devDependencies`, or it contains `strutvane.config.ts`. The search walks up from the working directory (or `--cwd`) but never accepts a drive or file-system root, the OS temp folder itself, or a folder above your home directory, and on macOS and Linux the folder must belong to the current user. A plain `package.json` or a stray `node_modules` higher up is ignored.

The launcher always answers `--version`, `help` (and a bare `strutvane`), `new` and `create` itself, even inside a project. To list the project's commands, run `pnpm exec strutvane-cli help` (or `npx strutvane-cli help`); every other command (`strutvane make:model …`, `pnpm sv migrate`) is delegated as before.

### Destructive commands and `APP_ENV`

Destructive commands (`migrate:fresh`, `migrate:reset`, `migrate:rollback`, `db:wipe`, `db:restore`, and `key:generate --force` when it would replace a key) run without confirmation only when `APP_ENV` is `local`, `test`, `testing` or `development`. Anywhere else, including when `APP_ENV` is not set (the runtime then assumes production), they need `--force --i-understand`.

`APP_ENV` is resolved the way the app resolves it: the process environment first (an empty value counts as unset), then `.env.<name>` when `--env <name>` is passed, then `.env`. Values are trimmed and compared case-insensitively, and quotes and `export` prefixes are understood. The command receives exactly the value the check used (`ctx.appEnv`), and `--env <name>` loads `.env.<name>` for the command, below the process environment and above `.env`.

Destructive commands must be typed in full: prefixes such as `sv mi:fr` are refused with the full name suggested.

## Commands

| Command | What it does |
|---|---|
| `about` | Versions of the CLI, Node.js and every installed Strutvane package |
| `doctor [--global]` | Checks Node.js, package.json, env files, `.gitignore`, the registry, owned-file conflicts and plugin compatibility. Exits 3 on failures |
| `env:check [--env <name>] [--strict]` | Compares `.env` with `.env.example`: missing, unknown, empty and invalid keys, and secrets committed in `.env.example`. Never prints values; malformed lines are reported as `file:line` only |
| `key:generate [--force] [--show]` | Writes `APP_KEY` to `.env` (and an empty entry to `.env.example`), replacing every `APP_KEY` line. Never prints the key unless `--show`. Replacing a non-empty key needs `--force`, and outside local/test environments also `--i-understand` |
| `make:model <Name> [fields…]` | Model, policy, factory, seeder and feature test (`--all` adds the resource), and registers the seeder in `database/seeders/database.seeder.ts` (see below). Interactive field builder when run in a terminal without fields |
| `make:resource <Model>` | Resource with `--actions approve,send` and `--hooks beforeCreate,afterUpdate` |
| `make:policy <Model>` | Deny-by-default policy, `--template default\|owner\|tenant-admin\|readonly`. Rules use the role names of `config/auth.ts`: `admin`, `member`, `viewer`, and `owner` (a tenant's creator); `tenant-admin` grants writes to `admin`/`owner` with `scope: 'tenant'` |
| `make:migration <name>` | Hand-written migration stub (`--sql`, `--table`) |
| `make:seeder <Name>` / `make:factory <Model>` / `make:test <name>` | Seeder (`--model`, `--count`), factory from the model's field types, feature/unit/e2e test |
| `registry:build [--check]` / `registry:watch` | Compiles conventions into the typed `.strutvane/registry.gen.ts` without running app code (ADR-0010). `--check` exits 6 when stale |
| `routes` / `models` / `permissions` | Read the registry: CRUD, action and custom routes with permissions; models with fields and relations; every permission |
| `add <package>` / `remove <package>` | Install a package (Strutvane packages from the CLI's release channel, e.g. `@strutvane/auth@next`) and run its devkit installer (all-or-nothing, previewable). Unknown flags become installer answers: `sv add auth --methods email` |
| `upgrade [--to <v> \| --channel <tag>]` | Bumps Strutvane packages, three-way merges owned files (ADR-0012), then runs the project's `tsc --noEmit` |
| `migrate*`, `db:*` | Provided by `@strutvane/framework` through its `strutvane.commands` module; the CLI explains how to install it when missing |

Every command supports `--json`, `--dry-run`, `--diff`, `--yes`, `--no-interactive`, `--force`, `--cwd <path>`, `--env <name>`, `--verbose`, `--quiet` and `--no-color`. `sv make model` is the same as `sv make:model`, and unique prefixes work (`sv mi:st` → `migrate:status`) except for destructive commands, which need their full name. `--diff` output never shows values from `.env` files (they appear as `KEY=<redacted>`).

On Windows, package managers are looked up on `PATH` only (never in the project folder), and child processes run with `NoDefaultCurrentDirectoryInExePath=1`.

### Field syntax

```
name:type[:modifier]…          # a type or modifier takes arguments in (…) or […]

title:string(200):required:searchable
amount:decimal(12,2):min(0):sortable
"status:enum(draft,sent,paid):default(draft):filterable"   # quote parentheses in shells
customer:belongsTo(Customer)
due:date:label("Due date, local")                           # quote arguments with , ( ) : or spaces
```

Arguments can also go in **square brackets**, which mean exactly the same and are the form to use on Windows:

```
title:string[200]:required:searchable
amount:decimal[12,2]:min[0]:sortable
status:enum[draft,sent,paid]:default[draft]:filterable
customer:belongsTo[Customer]
"due:date:label['Due date, local']"                         # text with spaces: single quotes inside
```

Why: in PowerShell, `corepack pnpm sv …`, `pnpm sv …` and `npx …` start `.cmd` shims. PowerShell removes the quotes around an argument without spaces, and cmd.exe then re-reads the arguments inside the shims' `IF … ( … )` blocks, where a `)` ends the block: `'name:string(120):required'` fails with `:required was unexpected at this time` before the CLI even starts, so the CLI cannot catch it. Square brackets and commas pass through unchanged, quoted or not (checked with Windows PowerShell 5.1, cmd.exe, `corepack.cmd` and npm/pnpm shims). PowerShell 5.1 also drops double quotes inside an argument, so quote text arguments with single quotes. From cmd.exe and Git Bash, quoted parentheses work too (they keep the quotes), and `node node_modules/@strutvane/cli/dist/bin.mjs …` avoids the shims altogether. In zsh, quote bracket specs (`[…]` is a glob pattern there). The two spellings cannot be mixed within one argument list (`string(120]` is an error).

Errors name the problem and the column: `Invalid field "status:enum(draft,paid):default(sent)": default "sent" is not one of: draft, paid. (column 33)`.

### Seeders

`sv db:seed` runs only `database/seeders/database.seeder.ts`. So `make:model` (and `make:seeder <Name> --model <Model>`) also register the new seeder there: they add `import XSeeder from './x.seeder.ts'` (in Biome's import order) and `await call(XSeeder)`, and give the callback its `({ call })` parameter. The call goes after the seeders of the models the new model belongs to and before those of existing models that belong to it, so related rows exist first; seeders are matched to models by name (`<Model>Seeder`). A parent whose seeder is not registered yet is named in a warning. Running the command again changes nothing. A missing file is created in the shape `create-strutvane` generates; the starter's older `defineSeeder({ async run() {…} })` file is updated to the current shape; any other content is left untouched and the lines to add are printed instead. `--dry-run` and `--diff` include the change; `--no-seeder` skips it.

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

The module must resolve inside the package's own folder in `node_modules` (symlinks included); anything else is refused without being executed. Packages whose `compat` range excludes the CLI are refused (exit 7), and so are plugins (anything outside `@strutvane/`) that declare no `compat` range at all: declare the Strutvane versions your plugin supports. A plugin can never replace a built-in command. Contributed commands receive `ctx.appEnv` (the resolved `APP_ENV`) and `ctx.guardDestructive()` for operations that are only sometimes destructive.

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
