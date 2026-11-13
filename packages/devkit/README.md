<div align="center">

# Strutvane Devkit

**SDK for building Strutvane installers, generators, plugins and codemods: staged transactional file writes, env-file editing, config AST patching, templates, three-way merge and dry-run diffs.**

[![Status: planning](https://img.shields.io/badge/status-planning-blueviolet)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Strutvane Devkit is in the design phase.** The specification is written and implementation has not started. Nothing is published to npm yet, and the package name `@strutvane/devkit` is reserved for this project. Follow [the roadmap](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md) for progress.

## What it is

Strutvane Devkit is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for building enterprise B2B applications. You declare models as fields and types, and get migrations, a secured CRUD API, auth/RBAC/tenancy and a complete UI. Every line stays owned, overridable TypeScript.

## Planned capabilities

- `defineInstaller()`: the protocol behind `sv add <package>` (idempotent, reversible, previewable)
- `defineGenerator()`: templates with typed inputs, used by `sv make:*`
- **Staged file system**: writes commit atomically at the end, and a failure leaves the project untouched
- **Env editor**: appends documented blocks to `.env` and `.env.example`; generates secrets
- **Config patcher**: AST edits of `strutvane.config.ts` (magicast/ts-morph)
- **Three-way merge** for ejected files and upgrades, and **codemod runner**
- `definePlugin()`: register providers, commands, field types and UI extensions

## A taste of the API (design preview)

```ts
import { defineInstaller } from '@strutvane/devkit'

export default defineInstaller({
  name: 'notify',
  async install({ deps, fs, env, config }) {
    await deps.add({ '@strutvane/notify': '^1' })
    await fs.template('config/notify.ts', templates.config)
    await env.add('Notifications', { NOTIFY_DEFAULT_CHANNEL: 'mail' })   // .env + .env.example
    await config.registerProvider('@strutvane/notify/provider')
  },
})
```

## Installation (once released)

```bash
npm i -D @strutvane/devkit
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

- **Package specification:** [04-architecture.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/04-architecture.md)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) and the [developer experience](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md)

## Contributing

Ideas and design feedback are welcome while the project is in the design phase. Open an issue or discussion, and see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
