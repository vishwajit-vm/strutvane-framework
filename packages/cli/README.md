<div align="center">

# Strutvane CLI

**The unified Strutvane command line (`strutvane`, `pnpm sv`): create projects, add packages, make models and resources, run migrations, list routes and permissions, eject code and upgrade safely.**

[![Status: planning](https://img.shields.io/badge/status-planning-blueviolet)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Strutvane CLI is in the design phase.** The specification is written and implementation has not started. Nothing is published to npm yet, and the package name `strutvane` is reserved for this project. Follow [the roadmap](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md) for progress.

## What it is

Strutvane CLI is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for building enterprise B2B applications. You declare models as fields and types, and get migrations, a secured CRUD API, auth/RBAC/tenancy and a complete UI. Every line stays owned, overridable TypeScript.

## Planned capabilities

- `strutvane new` / `npm create strutvane`: presets for full-stack, API-only and UI-only projects
- `sv add <package>` / `sv remove`: self-installing packages (config, `.env` + `.env.example`, migrations, routes, screens)
- `sv make:*`: model, resource, policy, action, job, event, listener, mail, command, seeder, factory, migration, test, page
- `sv migrate*`, `db:seed`, `db:pull`, `routes`, `permissions`, `doctor`, `env:check`, `tinker`, `up`/`down` (local Docker)
- `sv eject` and `sv upgrade`, with three-way merge and `--dry-run --diff` on every generator
- The global launcher **delegates to the project-local version**. `--json` output for CI. Windows, macOS and Linux supported

## A taste of the API (design preview)

```bash
npm create strutvane@latest acme
cd acme
pnpm sv make:model Product name:string price:decimal(10,2) "status:enum(draft,active)"
pnpm sv migrate
pnpm dev
```

## Installation (once released)

```bash
npx strutvane --help   # or: npm i -g strutvane
```

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| [`@strutvane/core`](https://github.com/vishwajit-vm/strutvane-core) | Kernel: container, providers, config, context |
| [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts) | Shared types and wire protocols |
| [`strutvane` / `@strutvane/cli`](https://github.com/vishwajit-vm/strutvane-cli) | Unified CLI |
| [`@strutvane/devkit`](https://github.com/vishwajit-vm/strutvane-devkit) | SDK for installers, generators and plugins |
| [`@strutvane/logs`](https://github.com/vishwajit-vm/strutvane-logs) | Zero-config logging + built-in log viewer (default) |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter |

## Documentation

- **Package specification:** [09-cli-reference.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/09-cli-reference.md)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) and the [developer experience](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md)

## Contributing

Ideas and design feedback are welcome while the project is in the design phase. Open an issue or discussion, and see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
